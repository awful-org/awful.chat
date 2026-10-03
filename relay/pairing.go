package main

// The relay is a bounded mailbox, not a PAKE endpoint. It holds neither a
// password verifier nor a room capability. All requests use POST /invite so
// routing and access logs contain no user-entered pairing code.
import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

type pairingMessage struct {
	Attempt string `json:"attempt"`
	Kind    string `json:"kind"`
	Payload string `json:"payload"`
}
type pairingEntry struct {
	token    string
	expires  time.Time
	attempts map[string][]pairingMessage
	stages   map[string]string
	inbox    []pairingMessage
	closed   bool
	// What the creator asked for, bounded at create: how many people may be
	// let in, and how many starts that buys (one each plus
	// pairingSpareAttempts). delivered counts transfers; the last closes it.
	maxUses, maxAttempts, delivered int
	// The creator's client bucket and its IPv6 /48, for the live-pairing
	// caps; both empty for a creator that holds no share.
	owner, ownerAgg string
}

var pairingMu sync.Mutex
var pairingStore = map[string]*pairingEntry{}
var pairingLastSweep time.Time

// Lowercase Crockford base32, as the client draws them. The locator is two
// characters: the pairing code is six (locator + four-character password),
// short because the password can only be guessed live, a few times, within
// minutes - see frontend/src/lib/room-security/invitation-pairing.ts.
var pairingLocator = regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{2}$`)
var pairingAttempt = regexp.MustCompile(`^[0-9a-hjkmnp-tv-z]{32}$`)
var pairingPayload = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

// pairingStartPayload is what a real start carries: an OPAQUE KE1
// (startLoginRequest) - 96 bytes, 128 characters of unpadded base64url -
// and nothing else. A start is what spends one of a pairing's
// pairingMaxAttempts, so only a start of that exact shape may: anything
// else is refused here with 400 and the pairing keeps its attempt. If the
// OPAQUE suite ever changes size, this has to change with it.
var pairingStartPayload = regexp.MustCompile(`^[A-Za-z0-9_-]{128}$`)

// A quarter of the 1024 two-character locators, so a new pairing rarely
// draws one already live - and when it does, create answers 409 and the
// client draws again.
const pairingMaxLive = 256

// What a creator may ask for. A code lets in 1 to pairingMaxUses people and
// lives 1 to 10 minutes; one that asks for neither (an older client) gets one
// person and five minutes, as every code used to. Each person spends a start,
// and a code buys pairingSpareAttempts more for mistyped tries - the only
// budget a guesser has against the four-character password: 29 tries at the
// most, about 1 in 36,000 for a code that is gone within ten minutes.
const (
	pairingMaxUses       = 25
	pairingSpareAttempts = 4
	pairingMaxAttempts   = pairingMaxUses + pairingSpareAttempts
	pairingMinTTL        = 60
	pairingMaxTTL        = 600
	pairingDefaultTTL    = 300
)

// The per-client and per-locator budgets. There used to be GLOBAL buckets
// as well - 300 starts and 300 creates a minute and 12,000 requests across
// the instance - and a few dozen addresses at their per-IP limit emptied
// them, refusing every real pairing on the instance for the rest of the
// minute. Nothing needed them: the password is protected by the per-pairing
// attempt budget, the store by pairingMaxLive, and the handler's own cost is
// a map lookup. So every budget is now one no single party can drain for
// anyone else:
//
//   - per client (an IPv4 address or IPv6 /64, with a /48 aggregate):
//     240 requests, 10 starts and 10 creates a minute. Ten, even though a
//     group code may be typed by a roomful of people behind one address:
//     the client waits and retries a 429 (invite-pairing.ts paced), so a
//     group is slowed, not refused, and a single-person code keeps the
//     guessing pace it always had;
//   - per locator: 2 x pairingMaxAttempts starts a minute, whoever sends
//     them and whether or not a pairing is live there, which paces how fast
//     any one pairing's attempts can be spent, and lets a full group in;
//   - live pairings at once: pairingMaxLivePerClient per client (an IPv4
//     address or IPv6 /64) and pairingMaxLivePerAggregate per IPv6 /48, so
//     filling the store takes 32 addresses or eight /48s rather than one.
//     A proxy-class creator holds no such share (exemptFromShares): that
//     address is everybody behind the proxy, and 8 pairings would be the
//     whole instance's ceiling.
const (
	pairingRequestsPerClient   = 240
	pairingStartsPerClient     = 10
	pairingCreatesPerClient    = 10
	pairingStartsPerLocator    = 2 * pairingMaxAttempts
	pairingMaxLivePerClient    = 8
	pairingMaxLivePerAggregate = 32
)

func handlePairing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllowClient(r, "pairing:", pairingRequestsPerClient) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	var b struct {
		Version int    `json:"version"`
		Action  string `json:"action"`
		Locator string `json:"locator"`
		Token   string `json:"token"`
		Attempt string `json:"attempt"`
		Kind    string `json:"kind"`
		Payload string `json:"payload"`
		// Create only: people to let in and seconds to live. Zero is the
		// default; anything outside the bounds is refused, not clamped.
		Uses int `json:"uses"`
		TTL  int `json:"ttl"`
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if d.Decode(&b) != nil || d.Decode(new(any)) != io.EOF || b.Version != 2 || !pairingLocator.MatchString(b.Locator) {
		apiError(w, r, "invalid pairing request", http.StatusBadRequest)
		return
	}
	// The request's own shape is checked before the locator is looked up, so
	// a malformed request gets the same answer whether a pairing is live
	// there or not.
	if b.Action != "create" && (b.Uses != 0 || b.TTL != 0) {
		apiError(w, r, "invalid pairing request", 400)
		return
	}
	switch b.Action {
	case "create":
		if b.Uses < 0 || b.Uses > pairingMaxUses || (b.TTL != 0 && (b.TTL < pairingMinTTL || b.TTL > pairingMaxTTL)) {
			apiError(w, r, "invalid pairing limits", 400)
			return
		}
	case "cancel", "host-poll":
	case "join-poll":
		if !pairingAttempt.MatchString(b.Attempt) {
			apiError(w, r, "invalid attempt", 400)
			return
		}
	case "start", "finish", "reply":
		if !pairingAttempt.MatchString(b.Attempt) || len(b.Payload) > 2048 || !pairingPayload.MatchString(b.Payload) ||
			(b.Action == "start" && !pairingStartPayload.MatchString(b.Payload)) {
			apiError(w, r, "invalid message", 400)
			return
		}
	default:
		apiError(w, r, "invalid pairing request", 400)
		return
	}
	// Meter starts independently from polling, including misses.
	if b.Action == "start" && (!rateAllowClient(r, "pairing-start:", pairingStartsPerClient) ||
		!rateAllow("pairing-start-loc:"+b.Locator, pairingStartsPerLocator)) {
		apiError(w, r, "rate limited", 429)
		return
	}
	if b.Action == "create" && !rateAllowClient(r, "pairing-create:", pairingCreatesPerClient) {
		apiError(w, r, "pairing unavailable", http.StatusTooManyRequests)
		return
	}
	pairingMu.Lock()
	defer pairingMu.Unlock()
	now := time.Now()
	// Expired pairings are swept at most once a second, not on every
	// request: the walk is the only part of this handler whose cost grows
	// with the store, and nothing else bounds how often it is asked for.
	if now.Sub(pairingLastSweep) >= time.Second {
		pairingLastSweep = now
		for key, e := range pairingStore {
			if !now.Before(e.expires) {
				delete(pairingStore, key)
			}
		}
	}
	e := pairingStore[b.Locator]
	if e != nil && !now.Before(e.expires) {
		delete(pairingStore, b.Locator)
		e = nil
	}
	if b.Action == "create" {
		var owner, ownerAgg string
		if addr := clientAddr(r); !exemptFromShares(addr) {
			owner, ownerAgg = clientBuckets(addr)
		}
		held, heldAgg := 0, 0
		for _, other := range pairingStore {
			if owner != "" && other.owner == owner {
				held++
			}
			if ownerAgg != "" && other.ownerAgg == ownerAgg {
				heldAgg++
			}
		}
		if len(pairingStore) >= pairingMaxLive || held >= pairingMaxLivePerClient || heldAgg >= pairingMaxLivePerAggregate {
			apiError(w, r, "pairing unavailable", http.StatusTooManyRequests)
			return
		}
		// A live pairing already holds this locator. Its own status, so the
		// client knows to draw another rather than give up. This does say a
		// locator is live, to a caller spending its create budget to ask:
		// the client needs it, and the locator is not the secret.
		if e != nil {
			apiError(w, r, "locator in use", http.StatusConflict)
			return
		}
		token := make([]byte, 32)
		if _, err := rand.Read(token); err != nil {
			apiError(w, r, "unavailable", 500)
			return
		}
		uses, ttl := b.Uses, b.TTL
		if uses == 0 {
			uses = 1
		}
		if ttl == 0 {
			ttl = pairingDefaultTTL
		}
		e = &pairingEntry{
			token:   base64.RawURLEncoding.EncodeToString(token),
			expires: now.Add(time.Duration(ttl) * time.Second),
			maxUses: uses, maxAttempts: uses + pairingSpareAttempts,
			attempts: map[string][]pairingMessage{}, stages: map[string]string{}, owner: owner, ownerAgg: ownerAgg,
		}
		pairingStore[b.Locator] = e
		inviteJSON(w, r, 200, map[string]string{"token": e.token})
		return
	}
	if e == nil {
		// No pairing here: answer exactly as a live one answers a caller that
		// holds neither its token nor a known attempt. A distinct "expired"
		// used to make every locator a free liveness probe - 1024 of them,
		// polled for nothing - which is how an attacker found the live codes
		// worth spending starts on. What a live pairing still reveals, it
		// reveals only to a start, which costs one of its attempts and the
		// caller's start budget.
		switch {
		case b.Token != "", b.Action == "cancel", b.Action == "host-poll":
			apiError(w, r, "denied", 403)
		case b.Action == "join-poll":
			apiError(w, r, "unknown attempt", 404)
		default:
			apiError(w, r, "pairing rejected", 409)
		}
		return
	}
	host := b.Token != "" && subtle.ConstantTimeCompare([]byte(b.Token), []byte(e.token)) == 1
	if b.Token != "" && !host {
		apiError(w, r, "denied", 403)
		return
	}
	reply := []pairingMessage{}
	switch b.Action {
	case "cancel":
		if !host {
			apiError(w, r, "denied", 403)
			return
		}
		delete(pairingStore, b.Locator)
	case "host-poll":
		if !host {
			apiError(w, r, "denied", 403)
			return
		}
		reply, e.inbox = pairingBatch(e.inbox)
	case "join-poll":
		messages, ok := e.attempts[b.Attempt]
		if !ok {
			apiError(w, r, "unknown attempt", 404)
			return
		}
		// A code that let in everyone it was made for answers no one else:
		// a joiner it never got to is told now, not left polling until the
		// code's whole lifetime runs out.
		if e.closed && len(messages) == 0 && e.stages[b.Attempt] != "transfer" {
			apiError(w, r, "pairing rejected", 409)
			return
		}
		reply = messages
		e.attempts[b.Attempt] = nil
	default:
		if !pairingDeliver(e, host, b.Action, b.Attempt, b.Kind, b.Payload) {
			apiError(w, r, "pairing rejected", 409)
			return
		}
	}
	if reply == nil {
		reply = []pairingMessage{}
	}
	inviteJSON(w, r, 200, map[string]any{"messages": reply})
}

// What one host-poll hands out: at most pairingPollMessages messages and
// about pairingPollBytes, the rest kept for the next poll. The client
// refuses a reply of more than 10 messages or 16 KiB, and a code for a group
// can queue far more between two polls - a hybrid finish alone is ~1.6 KB.
const (
	pairingPollMessages = 10
	pairingPollBytes    = 12 * 1024
)

func pairingBatch(inbox []pairingMessage) (batch, rest []pairingMessage) {
	size := 0
	for i, m := range inbox {
		size += len(m.Attempt) + len(m.Kind) + len(m.Payload) + 64 // JSON keys and quotes
		if i == pairingPollMessages || (i > 0 && size > pairingPollBytes) {
			return inbox[:i:i], inbox[i:]
		}
	}
	return inbox, nil
}

func pairingDeliver(e *pairingEntry, host bool, action, attempt, kind, payload string) bool {
	if e.closed {
		return false
	}
	m := pairingMessage{Attempt: attempt, Kind: kind, Payload: payload}
	stage, exists := e.stages[attempt]
	if action == "start" && !host && !exists && kind == "start" && len(e.attempts) < e.maxAttempts {
		e.attempts[attempt] = nil
		e.stages[attempt] = "start"
		e.inbox = append(e.inbox, m)
		return true
	}
	if action == "finish" && !host && stage == "response" && kind == "finish" {
		e.stages[attempt] = "finish"
		e.inbox = append(e.inbox, m)
		return true
	}
	if action == "reply" && host && ((stage == "start" && kind == "response") || (stage == "finish" && kind == "transfer")) {
		e.stages[attempt] = kind
		e.attempts[attempt] = append(e.attempts[attempt], m)
		// The last person it was made for closes it; until then the next
		// one can still start.
		if kind == "transfer" {
			e.delivered++
			if e.delivered >= e.maxUses {
				e.closed = true
				e.inbox = nil
			}
		}
		return true
	}
	return false
}
