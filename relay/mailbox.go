package main

// Offline DM mailbox: store-and-forward for end-to-end encrypted blobs.
//
// The relay NEVER sees plaintext or sender identity. A sender seals the DM
// envelope to the recipient's key client-side (ephemeral-static ECDH, so no
// prior handshake and nothing in the blob names the sender) and deposits it
// under the recipient's mailbox id = SHA-256(recipient did). The recipient
// collects by proving control of the did with an ed25519 signature over a
// fresh timestamp, then acks; acked blobs are deleted immediately and
// unclaimed ones expire after MailboxTTL.
//
// One identity can hold SEVERAL devices, and they share one box because the
// box id is derived from the did alone. A client may therefore name itself
// with an optional "device" (its libp2p peerId) on collect and ack: an ack
// then records that device against the blob instead of deleting it, and
// collect hides only what that device already has. Without it the old
// delete-on-ack behaviour stands, which is what made a phone next to an
// always-on desktop never receive its offline DMs - the desktop acked first
// and the blob was gone before the phone woke up.
//
// What the relay learns: recipient mailbox, deposit times, padded sizes,
// depositor IP. What it cannot learn: content, sender identity.
//
// Kept deliberately small: DMs only, text-scale blobs (files ride WebTorrent
// peer-to-peer and are never deposited), hard caps everywhere.

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/edwards25519"
	"github.com/mr-tron/base58"
)

const (
	// One sealed text DM is a few hundred bytes; 16 KiB leaves room for
	// padding buckets and replies-with-context while keeping the server
	// footprint minimal. Anything bigger retries peer-to-peer instead.
	mailboxMaxBlob = 16 * 1024
	// Per-mailbox caps: count and total bytes.
	mailboxMaxMsgs  = 100
	mailboxMaxBytes = 512 * 1024
	// Unclaimed blobs expire; the P2P offline queue still retries forever,
	// so expiry only delays delivery until both sides co-online.
	mailboxTTL = 48 * time.Hour
	// Signed-timestamp freshness window for collect/ack, into the PAST: it
	// has to tolerate a slow client and a slow network.
	mailboxAuthSkew = 2 * time.Minute
	// How far AHEAD a signed timestamp may be. Only clock skew needs
	// tolerating in that direction, and allowing the full mailboxAuthSkew
	// doubled the life of a captured auth triple - it stayed usable from two
	// minutes before it was signed until two minutes after.
	mailboxAuthFutureSkew = 30 * time.Second
	// Hard ceiling on everything under mailboxDir combined. Per-IP limits
	// mean nothing to a distributed depositor; without a global cap the
	// shared data volume could be filled without bound.
	mailboxGlobalMaxBytes = 256 << 20
	// Blobs are charged their real cost, not their logical length. A 1-byte
	// deposit still consumes a filesystem block and an inode, so counting
	// len(blob) alone let a flood of tiny blobs occupy ~4096x the space the
	// global counter thought it had handed out - the ceiling above measured
	// the one resource the attack does not spend.
	mailboxBlockSize = 4096
	// Inodes are exhaustible independently of bytes. With the block charge
	// these are close to what the byte ceiling already implies; they are
	// counted explicitly so that raising mailboxGlobalMaxBytes, or ever
	// dropping the charge, cannot quietly unbound file and directory creation.
	mailboxGlobalMaxFiles = mailboxGlobalMaxBytes / mailboxBlockSize
	// A box is a directory, so it costs an inode of its own on top of the
	// blobs inside it: the inode budget above is shared, and at most half of
	// it may be directories - exactly the case where every box holds one
	// blob. This used to be mailboxGlobalMaxFiles/8, which 8192 one-byte
	// deposits reached with only an EIGHTH of the byte budget spent, after
	// which every NEW recipient was refused for a full TTL while existing
	// boxes kept working. Box pressure now arrives with byte pressure, and a
	// deposit that does meet it evicts a stale box before refusing (see
	// evictOldestStaleBox).
	mailboxGlobalMaxBoxes = mailboxGlobalMaxFiles / 2
	// Deposit/collect/ack per-IP budgets, per minute. Deposits get their own
	// bucket so a chatty plugin proxying data does not starve offline DMs
	// (and vice versa); collect+ack were previously unlimited, a free
	// CPU/verify sink.
	//
	// Receipts are deposits too: collecting a box of N DMs sends N acks
	// back through here, and a conversation opened on a page of unread
	// sends one read receipt. At 10 a minute the acks for one collect ate
	// the whole budget and the sender's ticks never moved. The IP is also
	// shared by a household behind one NAT and by every phone on a
	// carrier's CGNAT, so the number has to cover several people at once.
	mailboxDepositLimit = 120
	mailboxAuthedLimit  = 240
	// The share of the global budget one source may hold at once: an IPv4
	// address, or an IPv6 /56 (shareKey). A proxy-class address is charged
	// to no share - see exemptFromShares. The deposit rate limit alone was
	// not a ceiling on this - it bounds deposits per minute, blobs live
	// for mailboxTTL, and a /56 was 256 separate rate-limit buckets, about
	// 30,000 deposits a minute, which filled all 65,536 files in two
	// minutes and closed every box on the instance for two days. A
	// sixteenth means at least sixteen separate allocations to do that
	// now, and still leaves one busy carrier NAT thousands of pending DMs.
	mailboxMaxHeldPerSource      = mailboxGlobalMaxFiles / 16
	mailboxMaxHeldBytesPerSource = mailboxGlobalMaxBytes / 16
	// Maximum IDs one ack request may carry. A real client acks what it just
	// collected, which is a small number bounded by mailboxMaxMsgs. This limit
	// leaves clear headroom and prevents the ack loop from doing unbounded
	// filesystem syscalls under the global lock.
	mailboxMaxAckIDs = 256
	// Devices one blob may be acked by before the earliest is forgotten. A box
	// is one identity; sixteen is well past a real person's device count, and
	// the bound is what keeps the ack index a small file rather than something
	// an identity can grow without limit.
	mailboxMaxAckDevices = 16
)

// ackIndexName is the per-box file recording which devices have acked which
// blob: {"<blob id>": ["<peerId>", ...]}. One extra inode per box rather than
// a sidecar per blob. The name is deliberately NOT a blob id (mailboxIDRe is
// hex only), so collect skips it and the deposit scan below excludes it.
//
// Losing this file costs a device one duplicate DM, nothing more, so it is
// written in place with no fsync and no temp-and-rename like everything else
// here.
const ackIndexName = "acks.json"

// mailboxDeviceRe matches a libp2p peerId as the frontend sends it: base58,
// no separators. Length is bounded on both sides because this string is a map
// key written to disk.
var mailboxDeviceRe = regexp.MustCompile(`^[1-9A-HJ-NP-Za-km-z]{32,64}$`)

var mailboxDir = func() string {
	if d := os.Getenv("MAILBOX_DIR"); d != "" {
		return d
	}
	return "/app/data/mailbox"
}()

var mailboxBoxRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
var mailboxIDRe = regexp.MustCompile(`^[0-9a-f]{1,32}$`)

// mailboxMu serializes writes per process - deposit volume is tiny and a
// single lock keeps the quota check race-free.
var mailboxMu sync.Mutex

// Which source deposited each blob, and how much of the global budget each
// source holds - see mailboxMaxHeldPerSource. Memory only, guarded by
// mailboxMu, and bounded by the blobs on disk. A restart forgets it, which
// only means blobs from before the restart count against nobody's share.
//
// The relay already learns the depositor's address with every deposit
// (docs/spec.md, "Server Privacy"); what is new is holding a link from a
// stored blob back to it for the blob's lifetime. So the link is a keyed
// hash of the coarse source bucket, not the address, under a key that
// exists only in this process: it lets the relay tell "same source" from
// "different source" and nothing else, and it is gone at the next restart.
type mailboxOrigin struct {
	source string
	charge int64
}

type mailboxShare struct {
	files int
	bytes int64
}

var (
	mailboxBlobOrigin = map[string]mailboxOrigin{} // "<box>/<id>" -> origin
	mailboxHeld       = map[string]mailboxShare{}  // source -> what it holds
)

var mailboxSourceKey = func() []byte {
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic("mailbox: no randomness for the source key: " + err.Error())
	}
	return k
}()

// mailboxSourceTag is the opaque per-process name of a request's source,
// or empty for a source that holds no share (exemptFromShares): a proxy's
// address is everybody behind it, and a share applied to it would be a
// ceiling on the whole mailbox.
func mailboxSourceTag(r *http.Request) string {
	key := shareKey(clientAddr(r))
	if key == "" {
		return ""
	}
	m := hmac.New(sha256.New, mailboxSourceKey)
	m.Write([]byte(key))
	return hex.EncodeToString(m.Sum(nil)[:12])
}

// mailboxRecordBlob charges a stored blob to its source. Caller holds
// mailboxMu.
func mailboxRecordBlob(box, id, source string, charge int64) {
	mailboxBlobOrigin[box+"/"+id] = mailboxOrigin{source: source, charge: charge}
	h := mailboxHeld[source]
	h.files++
	h.bytes += charge
	mailboxHeld[source] = h
}

// mailboxForgetBlob returns a removed blob's charge to its source. Every
// site that removes a blob calls it, like the global counters. Caller holds
// mailboxMu.
func mailboxForgetBlob(box, id string) {
	key := box + "/" + id
	o, ok := mailboxBlobOrigin[key]
	if !ok {
		return
	}
	delete(mailboxBlobOrigin, key)
	h := mailboxHeld[o.source]
	h.files--
	h.bytes -= o.charge
	if h.files <= 0 {
		delete(mailboxHeld, o.source)
		return
	}
	mailboxHeld[o.source] = h
}

// didToPubKey decodes a did:key to the raw ed25519 public key. The app's
// identity layer encodes WITHOUT the multibase 'z' (did:key:<base58> of
// 0xed01||pub) - requiring the spec's z-form made every real client's
// collect/ack fail 401. Accept both, disambiguating by decode: 'z' is a
// valid base58 character, so only a successful 34-byte 0xed01 decode says
// which form this is.
// mailboxWriteFile is os.WriteFile behind a seam. The failure this exists to
// cover is ENOSPC, where the file IS created and the write then fails, leaving
// a zero-byte blob that the quota counters know nothing about. That shape
// cannot be produced with permissions - a read-only directory fails at
// open(O_CREAT) and leaves nothing behind - so a test that wants the cleanup
// path has to substitute the failure here.
var mailboxWriteFile = os.WriteFile

func didToPubKey(did string) (ed25519.PublicKey, error) {
	const prefix = "did:key:"
	if !strings.HasPrefix(did, prefix) {
		return nil, fmt.Errorf("not a did:key")
	}
	body := did[len(prefix):]
	// base58 decoding is quadratic in the input length, and this runs BEFORE
	// any signature check on a caller-supplied string - a 16 KiB did burned
	// 80 ms of CPU per request, and twice over, since both candidate encodings
	// are tried. A real did:key body is 48-49 characters; 64 leaves room for
	// other multicodecs without leaving a CPU amplifier in front of the gate.
	if len(body) > 64 {
		return nil, fmt.Errorf("did too long")
	}
	for _, s := range []string{body, strings.TrimPrefix(body, "z")} {
		raw, err := base58.Decode(s)
		if err == nil && len(raw) == 34 && raw[0] == 0xed && raw[1] == 0x01 {
			return ed25519.PublicKey(raw[2:]), nil
		}
	}
	return nil, fmt.Errorf("not an ed25519 did:key")
}

func mailboxIDForDid(did string) string {
	sum := sha256.Sum256([]byte(did))
	return hex.EncodeToString(sum[:])
}

// The canonical and non-canonical encodings of the eight ed25519 points with
// order dividing 8. Rejecting them is what libsodium does and what
// RFC8032-strict verifiers do; Go's stdlib does neither.

// isSmallOrderPubKey reports whether pub is one of the ed25519 points of order
// dividing 8, for which a signature proves nothing.
func isSmallOrderPubKey(pub []byte) bool {
	// A real subgroup check rather than a list of known-bad encodings. The
	// list this replaces was written from the CURVE25519 (Montgomery
	// u-coordinate) blocklist used by Signal and WireGuard, but a did:key
	// carries an ed25519 y-coordinate - a different curve with a different
	// encoding - so those bytes could never match a real key and the two
	// canonical ed25519 order-8 points went straight through. Verified: both
	// 0xc7176a70... and 0x26e8958f... forged a valid mailbox auth against
	// Go's ed25519 for roughly one timestamp in eight.
	//
	// A point has order dividing 8 exactly when [8]A is the identity, which
	// MultByCofactor computes directly. That catches all eight torsion points
	// at once, including non-canonical encodings of them, and cannot drift out
	// of date the way a hand-kept list did.
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		// Not a valid point encoding at all, so not a usable identity either.
		return true
	}
	return new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1
}

// verifyMailboxAuth checks the LEGACY (v1) proof: a signature over
// "awful-mailbox:{unix-seconds}" and nothing else. See authenticateMailbox
// for the one place it is still accepted, and why.
func verifyMailboxAuth(did string, ts int64, sigB64 string) (string, error) {
	return verifyMailboxSignature(did, ts, sigB64, []byte("awful-mailbox:"+strconv.FormatInt(ts, 10)))
}

// verifyMailboxSignature checks that sigB64 is the did's signature over msg,
// made within the freshness window around ts, and returns the did's box.
func verifyMailboxSignature(did string, ts int64, sigB64 string, msg []byte) (string, error) {
	if d := time.Since(time.Unix(ts, 0)); d > mailboxAuthSkew || d < -mailboxAuthFutureSkew {
		return "", fmt.Errorf("stale timestamp")
	}
	pub, err := didToPubKey(did)
	if err != nil {
		return "", err
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return "", err
	}
	// Go's crypto/ed25519 accepts small-order public keys (verified: the
	// identity point verifies a zero-ish signature over any message), so a
	// did:key naming a torsion point would authenticate without anybody
	// holding a private key - and every attacker could claim that same did.
	// A did has to prove key possession or it is not an identity.
	if isSmallOrderPubKey(pub) {
		return "", fmt.Errorf("small-order public key")
	}
	if !ed25519.Verify(pub, msg, sig) {
		return "", fmt.Errorf("bad signature")
	}
	return mailboxIDForDid(did), nil
}

// ── Request auth, v2 ─────────────────────────────────────────────────────

// The v1 proof was a signature over "awful-mailbox:<ts>" and nothing else,
// so ONE captured proof was good for about two and a half minutes on all
// four authenticated calls: collect, ack, push subscribe and push
// unsubscribe. The device field that scopes an ack sat outside the
// signature too. Anyone who saw one request - a proxy log, a shared
// network, a browser extension - could replay it as an ack naming the
// victim's device (hiding its offline mail from it), subscribe their OWN
// push endpoint to the victim's box, or unsubscribe the victim's.
//
// A v2 proof signs what the request does:
//
//	awful-mailbox:v2:<action>:<host>:<device>:<ts>:<hex sha256 of the body>
//
// action is one of the four below, host is the relay's Host as the client
// addressed it (so a proof for one relay is worthless at another), device is
// the body's device field, and the body hash covers everything else in the
// request - the ack's ids, the subscription's endpoint and keys. The proof
// travels in the Authorization header, which the CORS preflight already
// allows, since it cannot be inside the body it signs. The client puts a
// random nonce in the body, so two otherwise identical requests in the same
// second are still two different proofs, and each proof is accepted once
// (mailboxAuthFirstUse).
const (
	mailboxActionCollect  = "collect"
	mailboxActionAck      = "ack"
	pushActionSubscribe   = "push-subscribe"
	pushActionUnsubscribe = "push-unsubscribe"
	mailboxAuthScheme     = "AwfulMailbox-v2"
)

func mailboxAuthMessage(action, host, device string, ts int64, bodySha256Hex string) []byte {
	return []byte("awful-mailbox:v2:" + action + ":" + host + ":" + device + ":" +
		strconv.FormatInt(ts, 10) + ":" + bodySha256Hex)
}

// readMailboxBody reads an authenticated call's body whole, bounded, since
// the v2 proof is over its exact bytes.
func readMailboxBody(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return nil, false
	}
	return body, true
}

// authenticateMailbox proves the request's did for one action and returns
// its box. A v2 proof comes in the Authorization header. Without one, the
// v1 fields from the body are accepted for COLLECT ONLY, during the
// transition:
//
// A cached app from before v2 keeps working for the thing that matters most
// - receiving offline DMs - until it reloads, and collect is the one call
// whose replay changes nothing: the blobs it returns are sealed to the
// recipient, and a captured proof reveals only what is waiting (count,
// padded sizes, times), not what it says. Its acks and push calls fail
// until the reload, which costs a duplicate delivery (deduplicated by id)
// and a missed wake-up, not a message. Those three are the calls a replay
// can do harm with, so none of them takes v1. A v1 collect is not put
// through the replay cache: v1 signatures are deterministic per second, so
// an old client collecting twice in one second would be refused its own
// second collect, and a replay of a read gains nothing a replay cache would
// stop. Remove the v1 branch once old clients have aged out.
func authenticateMailbox(r *http.Request, action string, body []byte, device, legacyDid string, legacyTs int64, legacySig string) (string, error) {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, mailboxAuthScheme+" ") {
		f := strings.Fields(h[len(mailboxAuthScheme)+1:])
		if len(f) != 3 {
			return "", errors.New("malformed authorization")
		}
		ts, err := strconv.ParseInt(f[1], 10, 64)
		if err != nil {
			return "", errors.New("malformed timestamp")
		}
		sum := sha256.Sum256(body)
		msg := mailboxAuthMessage(action, strings.ToLower(r.Host), device, ts, hex.EncodeToString(sum[:]))
		box, err := verifyMailboxSignature(f[0], ts, f[2], msg)
		if err != nil {
			return "", err
		}
		if !mailboxAuthFirstUse(f[2], ts) {
			return "", errors.New("replayed proof")
		}
		return box, nil
	}
	if action != mailboxActionCollect {
		return "", errors.New("this call needs a v2 proof")
	}
	return verifyMailboxAuth(legacyDid, legacyTs, legacySig)
}

// Proofs already accepted, so each one works once. An entry is needed only
// while its timestamp is still inside the freshness window; after that the
// timestamp check refuses the proof on its own. The cap bounds memory
// against a flood of freshly signed proofs from free dids; past it the
// oldest entries go first, which can only reopen a proof that has almost
// certainly expired already - and a v2 replay repeats one request exactly,
// so even that would do nothing new.
const mailboxSeenMax = 1 << 16

var (
	mailboxSeenMu    sync.Mutex
	mailboxSeen      = map[string]time.Time{}
	mailboxSeenOrder []string
)

func mailboxAuthFirstUse(sig string, ts int64) bool {
	now := time.Now()
	expires := time.Unix(ts, 0).Add(mailboxAuthSkew + time.Second)
	mailboxSeenMu.Lock()
	defer mailboxSeenMu.Unlock()
	for len(mailboxSeenOrder) > 0 {
		oldest := mailboxSeenOrder[0]
		if exp, ok := mailboxSeen[oldest]; ok && now.Before(exp) && len(mailboxSeenOrder) < mailboxSeenMax {
			break
		}
		delete(mailboxSeen, oldest)
		mailboxSeenOrder = mailboxSeenOrder[1:]
	}
	if exp, ok := mailboxSeen[sig]; ok && now.Before(exp) {
		return false
	}
	mailboxSeen[sig] = expires
	mailboxSeenOrder = append(mailboxSeenOrder, sig)
	return true
}

func mailboxCORS(w http.ResponseWriter, r *http.Request) bool {
	h := corsHeaders(r)
	h.Set("Access-Control-Allow-Methods", "POST,OPTIONS")
	for k, v := range h {
		w.Header()[k] = v
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return false
	}
	return true
}

type mailboxEntry struct {
	ID   string `json:"id"`
	Blob string `json:"blob"` // base64
	Ts   int64  `json:"ts"`   // deposit unix seconds
}

func boxPath(box string) string { return filepath.Join(mailboxDir, box) }

// mailboxUsedBytes tracks the global quota incrementally: a full-tree walk
// per deposit was tens of thousands of syscalls under mailboxMu at scale,
// serializing every deposit and ack behind disk I/O. One walk at startup
// (mailboxInitUsedBytes, before the sweeper loop), then deposits add and
// removals subtract. mailboxFiles and mailboxBoxes track the inode side of
// the same budget. All three are guarded by mailboxMu like everything else
// here, and every one of them must be adjusted at every removal site.
var (
	mailboxUsedBytes int64
	mailboxFiles     int
	mailboxBoxes     int
)

// mailboxCharge is what a blob costs the global budget: at least one
// filesystem block, whatever its logical length.
func mailboxCharge(size int64) int64 {
	if size < mailboxBlockSize {
		return mailboxBlockSize
	}
	return size
}

func mailboxInitUsedBytes() {
	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	mailboxUsedBytes = 0
	mailboxFiles = 0
	mailboxBoxes = 0
	mailboxBlobOrigin = map[string]mailboxOrigin{}
	mailboxHeld = map[string]mailboxShare{}
	boxes, _ := os.ReadDir(mailboxDir)
	for _, b := range boxes {
		if !b.IsDir() {
			continue
		}
		mailboxBoxes++
		entries, _ := os.ReadDir(filepath.Join(mailboxDir, b.Name()))
		for _, e := range entries {
			if info, err := e.Info(); err == nil {
				mailboxUsedBytes += mailboxCharge(info.Size())
				mailboxFiles++
			}
		}
	}
}

// readAckIndex returns the box's per-blob device ack sets. A missing or
// unreadable file means "nothing acked yet", which only ever costs a device a
// duplicate. Caller holds mailboxMu.
func readAckIndex(box string) map[string][]string {
	idx := map[string][]string{}
	data, err := os.ReadFile(filepath.Join(boxPath(box), ackIndexName))
	if err != nil {
		return idx
	}
	if json.Unmarshal(data, &idx) != nil {
		return map[string][]string{}
	}
	return idx
}

// writeAckIndex persists the index, removing the file once nothing is acked so
// an emptied box can still be rmdir'd. It is charged to the global budget like
// any other file here, so create/grow/remove all have to move the counters.
// Caller holds mailboxMu.
func writeAckIndex(box string, idx map[string][]string) {
	p := filepath.Join(boxPath(box), ackIndexName)
	var oldCharge int64
	existed := false
	if info, err := os.Stat(p); err == nil {
		existed, oldCharge = true, mailboxCharge(info.Size())
	}
	if len(idx) == 0 {
		if existed && os.Remove(p) == nil {
			if mailboxUsedBytes >= oldCharge {
				mailboxUsedBytes -= oldCharge
			}
			if mailboxFiles > 0 {
				mailboxFiles--
			}
		}
		return
	}
	data, err := json.Marshal(idx)
	if err != nil {
		return
	}
	if os.WriteFile(p, data, 0o600) != nil {
		return
	}
	if !existed {
		mailboxFiles++
	}
	mailboxUsedBytes += mailboxCharge(int64(len(data))) - oldCharge
	if mailboxUsedBytes < 0 {
		mailboxUsedBytes = 0
	}
}

// pruneAckIndex drops entries for blobs that are no longer on disk and reports
// whether it changed anything. Without it an expired blob's device list would
// outlive it and the index would grow for the life of the box.
func pruneAckIndex(idx map[string][]string, alive map[string]struct{}) bool {
	changed := false
	for id := range idx {
		if _, ok := alive[id]; !ok {
			delete(idx, id)
			changed = true
		}
	}
	return changed
}

// aliveBlobs lists the blob ids currently in a box, excluding the ack index
// and anything else that is not a blob name.
func aliveBlobs(box string) map[string]struct{} {
	alive := map[string]struct{}{}
	entries, _ := os.ReadDir(boxPath(box))
	for _, e := range entries {
		if mailboxIDRe.MatchString(e.Name()) {
			alive[e.Name()] = struct{}{}
		}
	}
	return alive
}

// evictOldestStaleBox frees one box directory when the box ceiling is hit, so
// a flood of tiny deposits cannot close the door on every NEW recipient for a
// full TTL while the boxes it created sit expired. A directory's mtime moves
// on every deposit and every ack, so one older than the TTL holds nothing that
// has not already expired: those are the only candidates, and the oldest goes
// first. The sweeper collects them too, but only hourly, and refusing real
// deposits in between is the failure this avoids. Caller holds mailboxMu.
func evictOldestStaleBox() bool {
	cutoff := time.Now().Add(-mailboxTTL)
	var oldest string
	var oldestMod time.Time
	boxes, _ := os.ReadDir(mailboxDir)
	for _, b := range boxes {
		if !b.IsDir() || !mailboxBoxRe.MatchString(b.Name()) {
			continue
		}
		info, err := b.Info()
		if err != nil || !info.ModTime().Before(cutoff) {
			continue
		}
		if oldest == "" || info.ModTime().Before(oldestMod) {
			oldest, oldestMod = b.Name(), info.ModTime()
		}
	}
	if oldest == "" {
		return false
	}
	dir := filepath.Join(mailboxDir, oldest)
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		if os.Remove(filepath.Join(dir, e.Name())) == nil {
			mailboxForgetBlob(oldest, e.Name())
			// Same non-negative guard as ack: a counter that can go negative
			// silently disables the ceiling it enforces.
			if charge := mailboxCharge(info.Size()); mailboxUsedBytes >= charge {
				mailboxUsedBytes -= charge
			}
			if mailboxFiles > 0 {
				mailboxFiles--
			}
		}
	}
	if os.Remove(dir) != nil { // succeeds only when empty
		return false
	}
	if mailboxBoxes > 0 {
		mailboxBoxes--
	}
	return true
}

// handleMailboxDeposit stores one sealed blob. Anonymous by design; only
// rate limits and caps stand between it and abuse.
func handleMailboxDeposit(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllowClient(r, "mb:", mailboxDepositLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Box  string `json:"box"`
		Blob string `json:"blob"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mailboxMaxBlob*2)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxBoxRe.MatchString(req.Box) {
		http.Error(w, "bad mailbox", http.StatusBadRequest)
		return
	}
	blob, err := base64.StdEncoding.DecodeString(req.Blob)
	if err != nil || len(blob) == 0 || len(blob) > mailboxMaxBlob {
		http.Error(w, "bad blob", http.StatusBadRequest)
		return
	}

	source := mailboxSourceTag(r)

	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	dir := boxPath(req.Box)
	// Stat before MkdirAll: a box that does not exist yet costs a directory,
	// and that has to be refused before it is created, not after.
	newBox := false
	if _, err := os.Stat(dir); err != nil {
		newBox = true
		if mailboxBoxes >= mailboxGlobalMaxBoxes && !evictOldestStaleBox() {
			http.Error(w, "mailbox full", http.StatusInsufficientStorage)
			return
		}
	}

	type storedBlob struct {
		name string
		size int64
		mod  time.Time
	}
	var stored []storedBlob
	var total int64
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		// Blobs only: the ack index shares the directory and is neither a
		// message for the per-box count nor something eviction may unlink.
		if !mailboxIDRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		stored = append(stored, storedBlob{name: e.Name(), size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	// Tie-broken by name because not every filesystem carries sub-second
	// mtimes, and ids are hex nanoseconds of the same width, so the name
	// ordering is the deposit ordering whenever the timestamps collide.
	sort.Slice(stored, func(i, j int) bool {
		if stored[i].mod.Equal(stored[j].mod) {
			return stored[i].name < stored[j].name
		}
		return stored[i].mod.Before(stored[j].mod)
	})

	// STORE FIRST, evict after. The global ceilings below are refusals, and
	// evicting before them meant a deposit that was ultimately refused had
	// already unlinked one of the recipient's pending messages: on a
	// saturated instance every 507 destroyed a real offline DM for a named
	// user whose box id is public. Nothing is removed now until the new blob
	// is safely on disk, so the box can exceed its cap by one blob for the
	// few microseconds in between, which costs nothing.
	charge := mailboxCharge(int64(len(blob)))
	if mailboxUsedBytes+charge > mailboxGlobalMaxBytes || mailboxFiles >= mailboxGlobalMaxFiles {
		http.Error(w, "mailbox full", http.StatusInsufficientStorage)
		return
	}
	// A full box sheds this source's OWN oldest blobs first, then everyone
	// else's oldest. Anyone can still push a named user's pending mail out
	// by depositing into their box - the box id is public and deposits are
	// anonymous - but one source now only ever pushes out one blob that is
	// not its own: after that the box is shedding its own junk. Clearing a
	// hundred real messages takes a hundred separate sources rather than a
	// hundred requests.
	// A source with no share (source == "") has no "own" blobs either: it
	// sheds plain oldest-first, as before shares existed.
	if source != "" {
		sort.SliceStable(stored, func(i, j int) bool {
			oi := mailboxBlobOrigin[req.Box+"/"+stored[i].name].source == source
			oj := mailboxBlobOrigin[req.Box+"/"+stored[j].name].source == source
			return oi && !oj
		})
		boxFull := len(stored)+1 > mailboxMaxMsgs || total+int64(len(blob)) > mailboxMaxBytes
		ownInBox := len(stored) > 0 && mailboxBlobOrigin[req.Box+"/"+stored[0].name].source == source
		// Over its share, a source may still deposit where doing so evicts
		// one of its own blobs, which does not grow what it holds.
		if held := mailboxHeld[source]; (held.files >= mailboxMaxHeldPerSource ||
			held.bytes+charge > mailboxMaxHeldBytesPerSource) && !(boxFull && ownInBox) {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	id := strconv.FormatInt(time.Now().UnixNano(), 16)
	if err := mailboxWriteFile(filepath.Join(dir, id), blob, 0o600); err != nil {
		// A failed write leaves a partial file on disk. Remove it and the
		// directory if this deposit created it, so the on-disk state matches
		// the quota counters which were not incremented.
		_ = os.Remove(filepath.Join(dir, id))
		if newBox {
			_ = os.Remove(dir)
		}
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	if newBox {
		mailboxBoxes++
	}
	mailboxFiles++
	mailboxUsedBytes += charge
	if source != "" {
		mailboxRecordBlob(req.Box, id, source, charge)
	}
	total += int64(len(blob))

	// A full box evicts its OLDEST blob rather than refusing the new one. The
	// box id is public - SHA-256 of the recipient did, which the frontend
	// derives the same way - and deposits are anonymous by design, so
	// refusing would let anyone permanently close one NAMED user's offline
	// delivery by parking 100 blobs in it. Eviction costs nothing that is not
	// recoverable: the mailbox is only a latency shortcut, and the sender's
	// P2P offline queue keeps the message and retries regardless.
	evicted := 0
	var evictedIDs []string
	for len(stored) > 0 &&
		(len(stored)+1 > mailboxMaxMsgs || total > mailboxMaxBytes) {
		oldest := stored[0]
		stored = stored[1:]
		if os.Remove(filepath.Join(dir, oldest.name)) == nil {
			mailboxForgetBlob(req.Box, oldest.name)
			total -= oldest.size
			mailboxUsedBytes -= mailboxCharge(oldest.size)
			mailboxFiles--
			evicted++
			evictedIDs = append(evictedIDs, oldest.name)
		}
	}
	if evicted > 0 {
		// The evicted blobs' device lists go with them; only touch the index
		// file when something was actually removed.
		if idx := readAckIndex(req.Box); len(idx) > 0 {
			for _, id := range evictedIDs {
				delete(idx, id)
			}
			writeAckIndex(req.Box, idx)
		}
		log.Printf("[mailbox] evicted %d blob(s) from a full box", evicted)
	}
	// The relay only learns THAT this box has mail, and that is all the push
	// says. Enqueue only - never a push service round trip on this request.
	pushNotifyBox(req.Box)
	w.WriteHeader(http.StatusNoContent)
}

// handleMailboxCollect returns every pending blob for the proven did.
func handleMailboxCollect(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	// Unlimited, these endpoints were a free signature-verification and
	// ReadDir sink for anyone with curl. 30/min covers the 5-minute collect
	// loop plus its acks many times over.
	if !rateAllowClient(r, "mba:", mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did    string `json:"did"`
		Ts     int64  `json:"ts"`
		Sig    string `json:"sig"`
		Device string `json:"device"`
	}
	body, ok := readMailboxBody(w, r, 4096)
	if !ok {
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Device != "" && !mailboxDeviceRe.MatchString(req.Device) {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}
	box, err := authenticateMailbox(r, mailboxActionCollect, body, req.Device, req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Under mailboxMu only for the small index read, not for the blob reads
	// below: collect deliberately does no I/O under the lock that a deposit
	// would then queue behind.
	acked := map[string][]string{}
	if req.Device != "" {
		mailboxMu.Lock()
		acked = readAckIndex(box)
		mailboxMu.Unlock()
	}
	entries, _ := os.ReadDir(boxPath(box))
	out := []mailboxEntry{}
	for _, e := range entries {
		if !mailboxIDRe.MatchString(e.Name()) {
			continue
		}
		// A blob this device has already acked is still on disk for the
		// identity's OTHER devices; it is just not this device's mail any more.
		if req.Device != "" && slices.Contains(acked[e.Name()], req.Device) {
			continue
		}
		blob, err := os.ReadFile(filepath.Join(boxPath(box), e.Name()))
		if err != nil {
			continue
		}
		ts := int64(0)
		if info, err := e.Info(); err == nil {
			ts = info.ModTime().Unix()
		}
		out = append(out, mailboxEntry{
			ID:   e.Name(),
			Blob: base64.StdEncoding.EncodeToString(blob),
			Ts:   ts,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleMailboxAck deletes collected blobs for the proven did.
func handleMailboxAck(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllowClient(r, "mba:", mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		IDs    []string `json:"ids"`
		Device string   `json:"device"`
	}
	body, ok := readMailboxBody(w, r, 16*1024)
	if !ok {
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if req.Device != "" && !mailboxDeviceRe.MatchString(req.Device) {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}
	box, err := authenticateMailbox(r, mailboxActionAck, body, req.Device, "", 0, "")
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Validate and bound the ID list before taking the lock. This is cheap
	// work (regex) that every other mailbox operation needs, and doing it
	// outside the lock means the lock holds only for real filesystem work.
	if len(req.IDs) > mailboxMaxAckIDs {
		http.Error(w, "too many ids", http.StatusBadRequest)
		return
	}
	var validIDs []string
	for _, id := range req.IDs {
		if mailboxIDRe.MatchString(id) {
			validIDs = append(validIDs, id)
		}
	}
	// Under mailboxMu: the empty-directory Remove racing a concurrent
	// deposit's ReadDir->WriteFile window turned that deposit into a
	// spurious 500 (WriteFile into a just-removed directory).
	mailboxMu.Lock()
	defer mailboxMu.Unlock()

	// Per-device ack: record the device and keep the blob for this identity's
	// other devices. Nothing is deleted here - TTL and the deposit-time quota
	// eviction remain the only ways a blob leaves the box.
	if req.Device != "" {
		alive := aliveBlobs(box)
		idx := readAckIndex(box)
		pruneAckIndex(idx, alive)
		for _, id := range validIDs {
			if _, ok := alive[id]; !ok {
				continue
			}
			devs := idx[id]
			if slices.Contains(devs, req.Device) {
				continue
			}
			if len(devs) >= mailboxMaxAckDevices {
				// Oldest out first. An identity that runs through more than
				// sixteen devices gets its earliest one re-delivered once,
				// which is cheaper than an unbounded list on disk.
				devs = devs[1:]
			}
			idx[id] = append(devs, req.Device)
		}
		writeAckIndex(box, idx)
		w.WriteHeader(http.StatusNoContent)
		return
	}

	for _, id := range validIDs {
		p := filepath.Join(boxPath(box), id)
		if info, err := os.Stat(p); err == nil && os.Remove(p) == nil {
			mailboxForgetBlob(box, id)
			charge := mailboxCharge(info.Size())
			// Prevent counters from going negative. A counter that can go
			// negative silently disables the ceiling it exists to enforce -
			// the global budget would no longer bound new deposits.
			if mailboxUsedBytes >= charge {
				mailboxUsedBytes -= charge
			}
			if mailboxFiles > 0 {
				mailboxFiles--
			}
		}
	}
	// A blob deleted the old way takes its device list with it, and emptying
	// the index removes the file - without which the box below could never be
	// rmdir'd again.
	if idx := readAckIndex(box); len(idx) > 0 {
		for _, id := range validIDs {
			delete(idx, id)
		}
		writeAckIndex(box, idx)
	}
	if os.Remove(boxPath(box)) == nil { // succeeds only when empty
		if mailboxBoxes > 0 {
			mailboxBoxes--
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// sweepMailboxOnce expires blobs past mailboxTTL and returns how many it
// removed. Split out of startMailboxSweeper so a test can drive one pass;
// TTL is the only thing that still frees a blob every device has acked.
func sweepMailboxOnce(now time.Time) int {
	cutoff := now.Add(-mailboxTTL)
	boxes, _ := os.ReadDir(mailboxDir)
	removed := 0
	for _, b := range boxes {
		dir := filepath.Join(mailboxDir, b.Name())
		// Same deposit-vs-remove race as ack: the empty-dir Remove must not
		// land inside a deposit's quota-check window.
		mailboxMu.Lock()
		alive := map[string]struct{}{}
		entries, _ := os.ReadDir(dir)
		for _, e := range entries {
			// The ack index is expired with its blobs, not on its own mtime:
			// an ack moves that mtime, so ageing it separately would drop
			// live ack state while the blobs it describes stayed.
			if !mailboxIDRe.MatchString(e.Name()) {
				continue
			}
			info, err := e.Info()
			if err != nil {
				continue
			}
			if info.ModTime().Before(cutoff) {
				if os.Remove(filepath.Join(dir, e.Name())) == nil {
					mailboxForgetBlob(b.Name(), e.Name())
					mailboxUsedBytes -= mailboxCharge(info.Size())
					mailboxFiles--
				}
				removed++
				continue
			}
			alive[e.Name()] = struct{}{}
		}
		if idx := readAckIndex(b.Name()); len(idx) > 0 && pruneAckIndex(idx, alive) {
			writeAckIndex(b.Name(), idx)
		}
		if os.Remove(dir) == nil { // only if empty
			mailboxBoxes--
		}
		mailboxMu.Unlock()
	}
	return removed
}

// startMailboxSweeper expires unclaimed blobs. Runs hourly; a restart
// changes nothing because the state is plain files under the data volume.
func startMailboxSweeper() {
	mailboxInitUsedBytes()
	go func() {
		for {
			if removed := sweepMailboxOnce(time.Now()); removed > 0 {
				log.Printf("[mailbox] expired %d blob(s)", removed)
			}
			time.Sleep(time.Hour)
		}
	}()
}
