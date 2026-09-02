package main

// Relay-side diagnostic vantage: an OPT-IN, per-peer ring of structured
// events plus an HTTP surface to receive a client's own bundle and read it
// back, with this relay's view stapled onto it. Wire schema mirrored in
// frontend/src/lib/telemetry/schema.ts (DiagEvent, RelayVantage,
// RelayCloseReason) - a change to an event's shape or to that reason
// vocabulary must be made in both places, in the same commit.
//
// What the relay already knows about a peer (docs/spec.md "Server
// Privacy") - its own peerId, dial/reservation outcomes, timings and error
// codes - is exactly what this file may record and serve back. It must
// NEVER learn or emit a room CODE (rooms travel as diagRoomRef, an HMAC
// keyed by a boot-only secret - see telemetryBootSecret), a did:key, or
// message/file content, none of which this relay ever sees in the first
// place.
//
// Everything here is inert unless TELEMETRY_ENABLED=1: diagRecord no-ops,
// and the HTTP endpoints answer 204/404 without doing any of the work
// below. Every diagRecord call site in this package is OUTSIDE
// registry.mu - TestRegistryNeverLogsUnderItsLock's reasoning for
// log.Printf applies identically to a mutex-taking recorder: called under
// the registry's single global lock, it would serialize every join and
// leave in the process behind it.
//
// POST /telemetry wire contract (frontend/src/lib/telemetry/upload.ts):
// headers X-Awful-Peer (full peerId), X-Awful-Ts (unix ms, decimal
// string), X-Awful-Sig (base64 Ed25519 signature); body is the bundle JSON
// verbatim. The signed content is exactly
// "awful-telemetry:" + <X-Awful-Ts verbatim> + ":" + hex(sha256(body)).

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
)

// relaySelfPeerId is this relay's own libp2p peerId, set once in main()
// right after the host is built and never written again - every request
// handler only reads it.
var relaySelfPeerId string

// telemetryEnabled gates the entire surface: with it unset, /telemetry
// answers 204 and writes nothing, the admin routes 404, and diagRecord
// never allocates a ring. A package var, not a const, read once at init
// like every other operator flag here, but reassignable so tests can flip
// it without an os.Setenv/re-init dance.
var telemetryEnabled = os.Getenv("TELEMETRY_ENABLED") == "1"

// telemetryAdminToken gates the two operator read routes. Empty means "not
// configured", and those routes must then behave as if they do not exist
// (404, not 401/403) so an unconfigured instance never advertises a console
// nobody can reach.
var telemetryAdminToken = os.Getenv("TELEMETRY_ADMIN_TOKEN")

var telemetryDir = func() string {
	if d := os.Getenv("TELEMETRY_DIR"); d != "" {
		return d
	}
	return "/app/data/telemetry"
}()

// telemetryBootSecret keys diagRoomRef's HMAC. Generated fresh every start
// and NEVER written to disk: a room ref must not be invertible back to a
// room code after the process exits, which persisting this secret would
// undo. A package var (not const) so a test can swap it to prove two boot
// secrets yield different refs for the same room code.
var telemetryBootSecret = func() []byte {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is a fatal platform problem elsewhere too
		// (loadOrGenKey has the same shape) - continuing with a zero
		// secret would make every room ref computable offline by anyone,
		// which is the one thing this secret exists to prevent.
		log.Fatalf("[telemetry] crypto/rand: %v", err)
	}
	return b
}()

const (
	// Events held per peer before the ring wraps and starts overwriting the
	// oldest. 256 is a small fraction of the frontend's 4096-event ring
	// (RING_CAPACITY, frontend/src/lib/telemetry/ring.ts): the relay only
	// ever sees its OWN rendezvous protocol events for one peer, not the
	// whole app-layer traffic a client vantage covers, so far fewer events
	// carry the same useful window.
	telemetryRingCapacity = 256
	// Distinct peers the relay will hold a ring for at once. Unlike the
	// registry's own maxTotalRegistrations, nothing else bounds this map's
	// growth - a peer only needs to open and close one rendezvous stream to
	// earn an entry, no REGISTER required - so it needs its own ceiling.
	// Evicting the oldest-touched peer first (evictOldestPeerLocked) means a
	// quiet peer's ring is what pays for a new arrival once the relay is
	// this busy, not a peer still connected.
	telemetryMaxTrackedPeers = 4096
	// Signed-timestamp freshness window for a /telemetry upload, the same
	// shape and width as mailboxAuthSkew: wide enough to tolerate ordinary
	// clock drift, narrow enough that a captured request cannot be replayed
	// hours later.
	telemetryAuthSkew = 2 * time.Minute
	// One uploaded bundle, post-staple, is capped here. 2 MiB comfortably
	// covers a trimmed ClientBundle (the client itself trims to ~1.8 MB
	// before signing, frontend/src/lib/telemetry/upload.ts) plus this
	// relay's own stapled view, with headroom for JSON overhead.
	telemetryMaxBody = 2 << 20
	// Bundles kept per peer before the OLDEST is evicted to make room for a
	// new one. Unlike the global ceiling below, a peer's own quota is not a
	// resource anyone else depends on, so there is nothing to protect by
	// refusing a new upload instead - eviction, not refusal, is correct
	// here.
	telemetryMaxPerPeer = 8
	// Hard ceilings on everything under telemetryDir combined, the same
	// per-IP-is-not-enough reasoning as mailboxGlobalMaxBytes: many peers
	// each staying under their own quota can still fill the shared data
	// volume. Global overflow REFUSES (507) rather than evicting, because
	// unlike a peer's own quota, the resource being protected here belongs
	// to every OTHER peer's telemetry too.
	telemetryGlobalMaxBytes = 128 << 20
	telemetryGlobalMaxFiles = 4096
	// Unclaimed bundles are diagnostic exhaust, not user data anyone is
	// waiting on - a week is long enough to debug a bug report, short
	// enough that "opted in once, forgot about it" does not accumulate
	// disclosure forever.
	telemetryTTL = 7 * 24 * time.Hour
	// Uploads per client IP per minute. Lower than mailboxDepositLimit: a
	// real client uploads at most a few times per session (an explicit
	// export, or the periodic upload described in the plan), never at line
	// rate, so this only has to be generous enough for manual retries.
	telemetryRateLimit = 4
	// Requests per client IP per minute against the two operator read
	// routes. These are cheap directory listings and file reads gated by a
	// bearer token, not a guessing oracle like the mailbox/invite budgets -
	// this only has to stop a misbehaving dashboard from hammering the
	// relay, not resist a blind attacker who has no token to try.
	telemetryAdminLimit = 30
)

// relayCloseGraceful and friends are exactly RelayCloseReason in
// frontend/src/lib/telemetry/schema.ts - see that type's doc comment. Named
// constants here so every call site spells a reason identically; a typo in
// a raw string would silently split one reason into two on the wire.
const (
	relayCloseGraceful        = "graceful"
	relayCloseLivenessTimeout = "liveness-timeout"
	relayCloseIdleTimeout     = "idle-timeout"
	relayCloseReadError       = "read-error"
	relayCloseFrameOversize   = "frame-oversize"
	relayCloseOutboxFull      = "outbox-full"
	relayCloseStreamCap       = "stream-cap"
	relayClosePeerDisconnect  = "peer-disconnect"
	relayCloseEvicted         = "evicted"
)

// telemetryPeerIDRe is the shape of a libp2p Ed25519 identity-multihash
// peerId as base58btc: no leading zero, no 0/O/I/l. Every path this
// package builds from a peerId - the on-disk directory and the admin `id`
// query param - validates against this BEFORE the string ever touches
// filepath.Join, per relay-audit.md's own path-traversal lesson.
var telemetryPeerIDRe = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{40,64}$`)

// telemetryFileNameRe is the shape of a stored bundle's filename: hex
// nanoseconds plus the .json this package always writes.
var telemetryFileNameRe = regexp.MustCompile(`^[0-9a-f]+\.json$`)

// ── Per-peer event ring ──────────────────────────────────────────────────

// relayDiagEvent is this relay's copy of DiagEvent
// (frontend/src/lib/telemetry/schema.ts). It must marshal to that FULL
// shape, not a subset: the dashboard merges relay events into the same
// timeline as client events and reads every field.
type relayDiagEvent struct {
	// 1-based within this PEER's ring (not the process), so a gap - the
	// ring wrapped, or a peer was evicted and its ring restarted at 1 - is
	// visible on the wire exactly like a client event's own seq gap.
	Seq int `json:"seq"`
	// Absolute unix milliseconds. This is the one place relayDiagEvent
	// diverges from a CLIENT event's `t`, which is relative to that
	// session's own startedAt - the dashboard treats a relay event's `t` as
	// already absolute and must not try to rebase it.
	T int64 `json:"t"`
	// A DiagKind literal - see the call sites in main.go for which ones
	// this relay actually emits.
	Kind string `json:"kind"`
	// "debug" | "info" | "warn" | "error" - see diagSeverityFor.
	Sev string `json:"sev"`
	// The peerId this event is about. Never nil for a relay event: every
	// ring here is keyed by, and every event in it is about, one peer.
	Peer *string `json:"peer"`
	// diagRoomRef output, or "" when the event has no room context. NEVER
	// a raw room code.
	Room string `json:"room"`
	// JSON primitives only, <=12 keys - the same bound event.ts enforces
	// client-side (frontend/src/lib/telemetry/event.ts). Every call site in
	// this package respects it by construction: none builds more than a
	// couple of keys.
	D map[string]any `json:"d,omitempty"`
}

// peerDiag is one peer's diagnostic ring: a pre-allocated array plus a head
// index, exactly the frontend's DiagRing (ring.ts) - wraparound overwrites
// the oldest event and increments dropped rather than growing or shifting.
type peerDiag struct {
	mu        sync.Mutex
	events    []relayDiagEvent
	head      int // next write index
	filled    int // valid slots, <= len(events)
	dropped   int // evicted by wraparound
	nextSeq   int // never resets while this peer's entry lives
	lastTouch time.Time
}

func (pd *peerDiag) push(e relayDiagEvent) {
	pd.mu.Lock()
	defer pd.mu.Unlock()
	pd.nextSeq++
	e.Seq = pd.nextSeq
	if pd.filled >= len(pd.events) {
		pd.dropped++
	} else {
		pd.filled++
	}
	pd.events[pd.head] = e
	pd.head = (pd.head + 1) % len(pd.events)
}

// snapshot returns every live event, oldest first, and the dropped count.
func (pd *peerDiag) snapshot() ([]relayDiagEvent, int) {
	pd.mu.Lock()
	defer pd.mu.Unlock()
	out := make([]relayDiagEvent, pd.filled)
	if pd.filled < len(pd.events) {
		copy(out, pd.events[:pd.filled])
	} else {
		n := copy(out, pd.events[pd.head:])
		copy(out[n:], pd.events[:pd.head])
	}
	return out, pd.dropped
}

// diagPeers is the process-wide table of per-peer rings. A plain map under
// one mutex, not sync.Map: telemetryMaxTrackedPeers has to be checked
// atomically with the insert, the same reason pluginproxy's rate limiter
// and mailboxMu are not sync.Map either.
var (
	diagMu    sync.Mutex
	diagPeers = map[string]*peerDiag{}
)

// diagSeverityFor is diagRecord's default severity per kind, matching the
// classes KIND_SEV (frontend/src/lib/telemetry/schema.ts) draws for every
// kind this relay actually emits: a *.fail/*.timeout/*.oversize/*.drop kind
// is "error", rv.close and peer.disconnect are "warn", everything else -
// rv.open, rv.register, rv.unregister here - is "info".
func diagSeverityFor(kind string) string {
	switch {
	case strings.HasSuffix(kind, ".fail"),
		strings.HasSuffix(kind, ".timeout"),
		strings.HasSuffix(kind, ".oversize"),
		strings.HasSuffix(kind, ".drop"):
		return "error"
	case kind == "rv.close", kind == "peer.disconnect":
		return "warn"
	default:
		return "info"
	}
}

// evictOldestPeerLocked drops the least-recently-touched peer's ring.
// Caller holds diagMu. An O(n) scan over at most telemetryMaxTrackedPeers
// entries is cheap next to letting the map grow without bound, and this
// only runs once the table is already at its ceiling.
func evictOldestPeerLocked() {
	var oldestId string
	var oldestAt time.Time
	found := false
	for id, pd := range diagPeers {
		if !found || pd.lastTouch.Before(oldestAt) {
			oldestId, oldestAt, found = id, pd.lastTouch, true
		}
	}
	if found {
		delete(diagPeers, oldestId)
	}
}

// diagRecord appends one event to peerId's ring, filling in Seq/T/Sev/Peer -
// callers set only Kind, Room and D. A no-op unless TELEMETRY_ENABLED, and
// never called while registry.mu is held (see this file's header comment).
func diagRecord(peerId string, e relayDiagEvent) {
	if !telemetryEnabled {
		return
	}
	now := time.Now()
	e.T = now.UnixMilli()
	e.Sev = diagSeverityFor(e.Kind)
	e.Peer = &peerId

	diagMu.Lock()
	pd, ok := diagPeers[peerId]
	if !ok {
		if len(diagPeers) >= telemetryMaxTrackedPeers {
			evictOldestPeerLocked()
		}
		pd = &peerDiag{events: make([]relayDiagEvent, telemetryRingCapacity)}
		diagPeers[peerId] = pd
	}
	pd.lastTouch = now
	diagMu.Unlock()

	pd.push(e)
}

// diagSnapshot returns peerId's events (oldest first) and its dropped
// count. A peer nothing has ever recorded for gets an empty slice, not
// nil, so relayViewFor's JSON always carries `events: []`, never
// `events: null`.
func diagSnapshot(peerId string) ([]relayDiagEvent, int) {
	diagMu.Lock()
	pd, ok := diagPeers[peerId]
	diagMu.Unlock()
	if !ok {
		return []relayDiagEvent{}, 0
	}
	return pd.snapshot()
}

// diagRoomRef is the room ref a relay-vantage event or RelayVantage.rooms
// entry carries: never the room code itself, only an HMAC of it keyed by
// this process's own boot secret. Stable for the life of one process (two
// uploads see the same ref for the same room) and un-invertible once the
// process exits, because the secret was never written anywhere.
func diagRoomRef(roomCode string) string {
	if roomCode == "" {
		return ""
	}
	mac := hmac.New(sha256.New, telemetryBootSecret)
	mac.Write([]byte(roomCode))
	return "h:" + hex.EncodeToString(mac.Sum(nil))[:12]
}

// readLoopCloseReason classifies why readLoop's s.Read returned err, so a
// liveness timeout, an idle timeout, a graceful EOF and a genuine read
// error are told apart. Today they all exit readLoop through the same
// "stream closed" log line - see handleStream - which is the difference
// between "a peer left" and "a peer wedged".
func readLoopCloseReason(err error, registered bool) string {
	if errors.Is(err, io.EOF) {
		return relayCloseGraceful
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		if registered {
			return relayCloseLivenessTimeout
		}
		return relayCloseIdleTimeout
	}
	return relayCloseReadError
}

// ── Relay vantage: what gets stapled onto an uploaded bundle ────────────

// relayVantage mirrors RelayVantage in
// frontend/src/lib/telemetry/schema.ts. Field names must match exactly -
// json.Marshal uses the tags below, not the Go names.
type relayVantage struct {
	Vantage        string               `json:"vantage"` // always "relay"
	RelayPeerId    string               `json:"relayPeerId"`
	ObservedPeerId string               `json:"observedPeerId"`
	Registry       relayVantageRegistry `json:"registry"`
	Rooms          []relayVantageRoom   `json:"rooms"`
	Streams        []relayVantageStream `json:"streams"`
	Events         []relayDiagEvent     `json:"events"`
}

type relayVantageRegistry struct {
	TotalRegistrations int  `json:"totalRegistrations"`
	StreamsForPeer     int  `json:"streamsForPeer"`
	AtTotalCap         bool `json:"atTotalCap"`
}

type relayVantageRoom struct {
	Ref     string   `json:"ref"`
	Size    int      `json:"size"`
	Members []string `json:"members"`
}

type relayVantageStream struct {
	Ref            string  `json:"ref"`
	OpenedAt       int64   `json:"openedAt"`
	ClosedAt       *int64  `json:"closedAt"`
	CloseReason    *string `json:"closeReason"`
	Rooms          int     `json:"rooms"`
	Registers      int     `json:"registers"`
	Unregisters    int     `json:"unregisters"`
	Capped         int     `json:"capped"`
	OracleSilenced int     `json:"oracleSilenced"`
}

// relayViewFor builds the RelayVantage this relay staples onto peerId's
// uploaded bundle: the registry state relevant to that ONE peer (never
// another peer's unrelated rooms), plus its diagnostic ring. Scoped to
// rooms peerId itself currently holds a stream in, and to that peer's own
// currently-live streams - a stream already closed by the time of upload
// carries no entry here, but its close is still visible in Events via the
// rv.close this package recorded when it happened.
func relayViewFor(reg *registry, peerId string) relayVantage {
	reg.mu.Lock()
	total := reg.total
	atCap := reg.total >= maxTotalRegistrations
	streams := reg.clients[peerId]
	streamsForPeer := len(streams)

	roomSet := make(map[string]struct{}, streamsForPeer)
	for c := range streams {
		for room := range c.rooms {
			roomSet[room] = struct{}{}
		}
	}
	rooms := make([]relayVantageRoom, 0, len(roomSet))
	for room := range roomSet {
		members := reg.rooms[room]
		rooms = append(rooms, relayVantageRoom{
			Ref:     diagRoomRef(room),
			Size:    distinctPeers(members),
			Members: peersExcept(members, ""), // "" excludes nobody: every member is reported
		})
	}

	streamViews := make([]relayVantageStream, 0, streamsForPeer)
	for c := range streams {
		streamViews = append(streamViews, relayVantageStream{
			Ref:            c.diagRef,
			OpenedAt:       c.diagOpenedAt.UnixMilli(),
			ClosedAt:       nil,
			CloseReason:    nil,
			Rooms:          len(c.rooms),
			Registers:      c.diagRegisters,
			Unregisters:    c.diagUnregisters,
			Capped:         c.diagCapped,
			OracleSilenced: c.diagOracleSilenced,
		})
	}
	reg.mu.Unlock()

	events, _ := diagSnapshot(peerId)

	return relayVantage{
		Vantage:        "relay",
		RelayPeerId:    relaySelfPeerId,
		ObservedPeerId: peerId,
		Registry: relayVantageRegistry{
			TotalRegistrations: total,
			StreamsForPeer:     streamsForPeer,
			AtTotalCap:         atCap,
		},
		Rooms:   rooms,
		Streams: streamViews,
		Events:  events,
	}
}

// stapleRelayView adds a "relayView" key to bundle, an uploaded
// ClientBundle's raw JSON object, without needing this package to model
// ClientBundle's full shape - it only ever needs to add one key next to
// whatever the client sent.
func stapleRelayView(bundle []byte, view relayVantage) ([]byte, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(bundle, &obj); err != nil {
		return nil, fmt.Errorf("bundle is not a JSON object: %w", err)
	}
	viewBytes, err := json.Marshal(view)
	if err != nil {
		return nil, err
	}
	obj["relayView"] = viewBytes
	return json.Marshal(obj)
}

// ── Auth ──────────────────────────────────────────────────────────────────

// verifyTelemetryAuth proves the uploader owns peerId, without ever
// learning a did:key.
//
// An Ed25519 libp2p peerId is an identity multihash: the public key is
// INSIDE it (peer.ID.ExtractPublicKey). So a signature that verifies
// against the key extracted from the CLAIMED peerId proves the uploader
// holds that peerId's private key - and the relay already knows every
// peerId it has seen, from the rendezvous protocol alone. Signing with the
// identity key instead would hand this endpoint a did:key -> peerId
// binding it must never learn (docs/spec.md "Server Privacy"); if a peerId
// ever fails to yield a key this way, the upload is rejected outright,
// never re-tried against some other key.
//
// tsMs is X-Awful-Ts parsed to an int64 (freshness check); tsStr is that
// SAME header's raw string, reused verbatim in the signed message - the
// client signs the string it sends, not a round-tripped reformatting of it.
func verifyTelemetryAuth(peerIdStr string, tsMs int64, tsStr, sigB64, bodySha256Hex string) error {
	if d := time.Since(time.UnixMilli(tsMs)); d > telemetryAuthSkew || d < -telemetryAuthSkew {
		return fmt.Errorf("stale timestamp")
	}
	pid, err := peer.Decode(peerIdStr)
	if err != nil {
		return fmt.Errorf("bad peer id: %w", err)
	}
	pub, err := pid.ExtractPublicKey()
	if err != nil {
		return fmt.Errorf("peer id does not embed a public key: %w", err)
	}
	raw, err := pub.Raw()
	if err != nil {
		return fmt.Errorf("bad public key: %w", err)
	}
	// Same subgroup check as verifyMailboxAuth (mailbox.go) and for the
	// identical reason: Go's crypto/ed25519 verifies a signature against a
	// small-order key even without the matching private key, so a peerId
	// naming a torsion point would authenticate for anybody.
	if isSmallOrderPubKey(raw) {
		return fmt.Errorf("small-order public key")
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return fmt.Errorf("bad signature encoding: %w", err)
	}
	// "awful-telemetry:", not "awful-mailbox:" - the domain-separation
	// prefix verifyMailboxAuth (mailbox.go) uses. Reusing that prefix would
	// make one signature valid on both surfaces.
	msg := []byte("awful-telemetry:" + tsStr + ":" + bodySha256Hex)
	ok, err := pub.Verify(msg, sig)
	if err != nil || !ok {
		return fmt.Errorf("bad signature")
	}
	return nil
}

// ── POST /telemetry ingest ───────────────────────────────────────────────

// handleTelemetryIngest returns the /telemetry handler bound to reg, so it
// stays testable with a fresh registry per test rather than the process's
// single global one. Order is fixed and matters, mirroring
// handleTurnCredentials (turn.go): Origin, then rate budget, then whether
// telemetry is even turned on, then the body bound, then auth - so even the
// 204 "not set up" path is metered.
func handleTelemetryIngest(reg *registry) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isAllowedOrigin(r.Header.Get("Origin")) {
			apiError(w, r, "Origin not allowed", http.StatusForbidden)
			return
		}
		if !rateAllow("tm:"+clientIP(r), telemetryRateLimit) {
			apiError(w, r, "rate limited", http.StatusTooManyRequests)
			return
		}
		if !telemetryEnabled {
			// "Not set up" - the /plugin-proxy and /turn-credentials
			// convention: 204 rather than 404, so the client keeps quietly
			// not uploading until an operator opts in.
			withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
			return
		}

		peerId := r.Header.Get("X-Awful-Peer")
		tsStr := r.Header.Get("X-Awful-Ts")
		sig := r.Header.Get("X-Awful-Sig")
		if !telemetryPeerIDRe.MatchString(peerId) || tsStr == "" || sig == "" {
			apiError(w, r, "bad request", http.StatusBadRequest)
			return
		}
		tsMs, err := strconv.ParseInt(tsStr, 10, 64)
		if err != nil {
			apiError(w, r, "bad request", http.StatusBadRequest)
			return
		}

		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, telemetryMaxBody))
		if err != nil {
			apiError(w, r, "body too large", http.StatusRequestEntityTooLarge)
			return
		}
		sum := sha256.Sum256(body)
		if err := verifyTelemetryAuth(peerId, tsMs, tsStr, sig, hex.EncodeToString(sum[:])); err != nil {
			apiError(w, r, "unauthorized", http.StatusUnauthorized)
			return
		}

		full, err := stapleRelayView(body, relayViewFor(reg, peerId))
		if err != nil {
			apiError(w, r, "bad request", http.StatusBadRequest)
			return
		}
		bundleId, status, err := storeTelemetryBundle(peerId, full)
		if err != nil {
			// The 507 message is a fact about the quota and safe to say. The
			// 500 one is whatever os.MkdirAll or os.WriteFile returned, which
			// carries the absolute path of the data volume - reported to an
			// anonymous caller. Log it instead and answer with a constant.
			if status == http.StatusInternalServerError {
				log.Printf("[telemetry] storing a bundle for %s failed: %v", peerId, err)
				apiError(w, r, "internal error", status)
				return
			}
			apiError(w, r, err.Error(), status)
			return
		}

		withCors(w, r, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{"bundleId": bundleId})
		})
	}
}

// ── Storage ───────────────────────────────────────────────────────────────

// telemetryUsedBytes/telemetryFiles track the global quota incrementally,
// the same mailboxUsedBytes/mailboxFiles scheme mailbox.go uses and for the
// identical reason: a full-tree walk per upload does not scale. One walk at
// startup (telemetryInitUsedBytes), then storeTelemetryBundle and the
// sweeper adjust them at every write and removal. Guarded by telemetryMu.
var (
	telemetryMu        sync.Mutex
	telemetryUsedBytes int64
	telemetryFiles     int
)

func telemetryInitUsedBytes() {
	telemetryMu.Lock()
	defer telemetryMu.Unlock()
	telemetryUsedBytes = 0
	telemetryFiles = 0
	peers, _ := os.ReadDir(telemetryDir)
	for _, p := range peers {
		if !p.IsDir() {
			continue
		}
		entries, _ := os.ReadDir(filepath.Join(telemetryDir, p.Name()))
		for _, e := range entries {
			if info, err := e.Info(); err == nil {
				telemetryUsedBytes += info.Size()
				telemetryFiles++
			}
		}
	}
}

// storeTelemetryBundle writes one already-stapled bundle to
// <telemetryDir>/<peerId>/<id>.json and returns its bundleId
// ("<peerId>/<id>.json", directly usable as the admin `id` query param).
// Global overflow REFUSES (507); a peer over its own per-peer quota instead
// EVICTS its oldest upload - see telemetryMaxPerPeer and
// telemetryGlobalMaxBytes above.
func storeTelemetryBundle(peerId string, full []byte) (bundleId string, status int, err error) {
	size := int64(len(full))

	telemetryMu.Lock()
	defer telemetryMu.Unlock()

	if telemetryUsedBytes+size > telemetryGlobalMaxBytes || telemetryFiles >= telemetryGlobalMaxFiles {
		return "", http.StatusInsufficientStorage, fmt.Errorf("telemetry store full")
	}

	dir := filepath.Join(telemetryDir, peerId)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", http.StatusInternalServerError, err
	}

	id := strconv.FormatInt(time.Now().UnixNano(), 16) + ".json"
	if err := os.WriteFile(filepath.Join(dir, id), full, 0o600); err != nil {
		return "", http.StatusInternalServerError, err
	}
	telemetryFiles++
	telemetryUsedBytes += size

	// Per-peer eviction: oldest first. Hex-nanosecond filenames sort
	// chronologically as plain strings, the same trick mailbox.go's own
	// deposit path relies on for its tie-break.
	entries, _ := os.ReadDir(dir)
	var files []os.DirEntry
	for _, e := range entries {
		if telemetryFileNameRe.MatchString(e.Name()) {
			files = append(files, e)
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for len(files) > telemetryMaxPerPeer {
		oldest := files[0]
		files = files[1:]
		info, err := oldest.Info()
		if err != nil {
			continue
		}
		if os.Remove(filepath.Join(dir, oldest.Name())) == nil {
			telemetryFiles--
			telemetryUsedBytes -= info.Size()
		}
	}

	return peerId + "/" + id, http.StatusOK, nil
}

// sweepTelemetryOnce removes bundles older than telemetryTTL and reports
// how many it removed. Split from startTelemetrySweeper so a test can drive
// one pass without waiting an hour.
func sweepTelemetryOnce(now time.Time) int {
	cutoff := now.Add(-telemetryTTL)

	telemetryMu.Lock()
	defer telemetryMu.Unlock()

	removed := 0
	peers, _ := os.ReadDir(telemetryDir)
	for _, p := range peers {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(telemetryDir, p.Name())
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			info, err := e.Info()
			if err != nil || !info.ModTime().Before(cutoff) {
				continue
			}
			if os.Remove(filepath.Join(dir, e.Name())) == nil {
				telemetryUsedBytes -= info.Size()
				telemetryFiles--
				removed++
			}
		}
		os.Remove(dir) // no-op unless now empty
	}
	return removed
}

// startTelemetrySweeper expires bundles past telemetryTTL. Runs hourly,
// beside startMailboxSweeper - a restart changes nothing because the state
// is plain files under the data volume.
func startTelemetrySweeper() {
	telemetryInitUsedBytes()
	go func() {
		for {
			if removed := sweepTelemetryOnce(time.Now()); removed > 0 {
				log.Printf("[telemetry] expired %d bundle(s)", removed)
			}
			time.Sleep(time.Hour)
		}
	}()
}

// ── Operator read routes ─────────────────────────────────────────────────

// telemetryAdminCORS handles method gating and CORS for the two operator
// endpoints. Unlike every other handler in this file, it does NOT call
// isAllowedOrigin: a bearer token is real authentication, and
// isAllowedOrigin returns true for an empty Origin by design (cors.go) - it
// was never the abuse control here. Echoing the REQUEST's own Origin
// (never "*", and never with credentials) is what lets an operator's
// dashboard on http://localhost:5174 reach a production relay.
func telemetryAdminCORS(w http.ResponseWriter, r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Headers", "authorization")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

// checkTelemetryAdminAuth compares the bearer token in constant time, the
// same reason every password/token check anywhere should.
func checkTelemetryAdminAuth(r *http.Request) bool {
	const prefix = "Bearer "
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, prefix) {
		return false
	}
	token := strings.TrimPrefix(h, prefix)
	return subtle.ConstantTimeCompare([]byte(token), []byte(telemetryAdminToken)) == 1
}

type telemetryBundleInfo struct {
	ID        string `json:"id"`
	PeerId    string `json:"peerId"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
}

// handleTelemetryList answers GET /telemetry/list -> {"bundles":[...]},
// newest first, capped at 500.
func handleTelemetryList(w http.ResponseWriter, r *http.Request) {
	// Absent unless configured - a plain 404, before anything else runs,
	// so an unconfigured instance looks exactly like one with no such
	// route at all.
	if telemetryAdminToken == "" {
		http.NotFound(w, r)
		return
	}
	if !telemetryAdminCORS(w, r) {
		return
	}
	if !rateAllow("tma:"+clientIP(r), telemetryAdminLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !checkTelemetryAdminAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	var out []telemetryBundleInfo
	peers, _ := os.ReadDir(telemetryDir)
	for _, p := range peers {
		if !p.IsDir() {
			continue
		}
		dir := filepath.Join(telemetryDir, p.Name())
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			info, err := e.Info()
			if err != nil {
				continue
			}
			out = append(out, telemetryBundleInfo{
				ID:        p.Name() + "/" + e.Name(),
				PeerId:    p.Name(),
				Size:      info.Size(),
				CreatedAt: info.ModTime().UnixMilli(),
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	if len(out) > 500 {
		out = out[:500]
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"bundles": out})
}

// handleTelemetryGet answers GET /telemetry/get?id=<peerId>/<file> with the
// stored bundle's raw JSON.
func handleTelemetryGet(w http.ResponseWriter, r *http.Request) {
	if telemetryAdminToken == "" {
		http.NotFound(w, r)
		return
	}
	if !telemetryAdminCORS(w, r) {
		return
	}
	if !rateAllow("tma:"+clientIP(r), telemetryAdminLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	if !checkTelemetryAdminAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	id := r.URL.Query().Get("id")
	peerId, file, ok := strings.Cut(id, "/")
	if !ok || !telemetryPeerIDRe.MatchString(peerId) || !telemetryFileNameRe.MatchString(file) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	// Belt and suspenders against traversal: the regexes above already
	// guarantee peerId and file are each one plain path segment with no
	// "..", but this confirms the resolved path really did stay under
	// telemetryDir regardless of how that guarantee could ever be defeated.
	root, err := filepath.Abs(telemetryDir)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	path, err := filepath.Abs(filepath.Join(telemetryDir, peerId, file))
	if err != nil || !strings.HasPrefix(path, root+string(filepath.Separator)) {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(data)
}
