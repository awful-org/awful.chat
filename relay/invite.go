package main

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Short invite codes.
//
// A room code is the room's only secret and stays 64 bits. What people want
// to read across a table is shorter, so the relay keeps a 6-character alias
// for five minutes and resolves it back to the real code. The alias is the
// thing that can be guessed, and the numbers are meant to make that pointless:
// 30 bits of Crockford base32, alive for 5 minutes, looked up through an
// endpoint that allows 10 tries a minute per client IP (HTTP goes through
// Traefik, which forwards the client address - unlike the libp2p rendezvous,
// where the relay only ever sees the proxy). 50 tries against 2^30 per code
// lifetime is nothing, and a hit only hands over what the inviter was about
// to say out loud anyway.
//
// Per-IP alone is not enough against many addresses, so misses also draw on
// one relay-wide budget. That makes the total guess rate against the whole
// store a constant, and the store is small (inviteMaxLive), so the chance a
// guess lands on ANY live code stays negligible: 1024/2^30 per try at 300
// tries a minute is one hit in about 60 hours of saturating the endpoint,
// and a hit is one room the inviter was about to say out loud. The cost of
// the global budget is that a flood can make short codes unresolvable for
// everyone until the window turns; the long link keeps working, so that is a
// convenience degraded, not the app.
//
// A hit does not consume the alias: one code read to a group is resolved by
// everyone in it.

const inviteAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const inviteCodeLen = 6

// Package vars, not consts, so tests can shrink them.
var (
	inviteTTL        = 5 * time.Minute
	inviteMaxLive    = 1024
	inviteRateLimit  = 10  // per client IP per minute, create and lookup alike
	inviteMissLimit  = 300 // relay-wide misses per minute
	inviteMaxBodyLen = int64(4096)
)

type inviteEntry struct {
	roomCode string
	expires  time.Time
}

var (
	inviteMu    sync.Mutex
	inviteStore = map[string]inviteEntry{}
)

// normalizeInviteCode folds what a person types into the canonical form:
// uppercase, look-alikes mapped (O->0, I/L->1), separators dropped. The
// frontend does the same, so a code that survived a voice call still works.
func normalizeInviteCode(s string) string {
	s = strings.ToUpper(strings.TrimSpace(s))
	var b strings.Builder
	for _, c := range s {
		switch c {
		case '-', ' ':
			continue
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		b.WriteRune(c)
	}
	return b.String()
}

func validInviteCode(s string) bool {
	if len(s) != inviteCodeLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !strings.ContainsRune(inviteAlphabet, rune(s[i])) {
			return false
		}
	}
	return true
}

func newInviteCode() (string, error) {
	buf := make([]byte, inviteCodeLen)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	for i := range buf {
		buf[i] = inviteAlphabet[int(buf[i])&31]
	}
	return string(buf), nil
}

// inviteSweepLocked drops expired entries. Called with inviteMu held, on the
// insert path only: lookups are already bounded by the rate limit and the
// map is bounded by inviteMaxLive, so a timer buys nothing.
func inviteSweepLocked(now time.Time) {
	for code, e := range inviteStore {
		if !now.Before(e.expires) {
			delete(inviteStore, code)
		}
	}
}

// createInvite stores a fresh alias for roomCode. Returns "" when the store
// is full.
func createInvite(roomCode string, now time.Time) (string, error) {
	inviteMu.Lock()
	defer inviteMu.Unlock()
	inviteSweepLocked(now)
	if len(inviteStore) >= inviteMaxLive {
		return "", nil
	}
	for {
		code, err := newInviteCode()
		if err != nil {
			return "", err
		}
		if _, taken := inviteStore[code]; taken {
			continue
		}
		inviteStore[code] = inviteEntry{roomCode: roomCode, expires: now.Add(inviteTTL)}
		return code, nil
	}
}

func resolveInvite(code string, now time.Time) (string, bool) {
	inviteMu.Lock()
	defer inviteMu.Unlock()
	e, ok := inviteStore[code]
	if !ok || !now.Before(e.expires) {
		return "", false
	}
	return e.roomCode, true
}

func inviteJSON(w http.ResponseWriter, r *http.Request, status int, v any) {
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	})
}

// POST /invite {"roomCode": "..."} -> {"code": "7QK3M9", "ttl": 300}
func handleInviteCreate(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllow("invite:"+clientIP(r), inviteRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	var body struct {
		RoomCode string `json:"roomCode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, inviteMaxBodyLen)).Decode(&body); err != nil || !validRoom(body.RoomCode) {
		apiError(w, r, "bad roomCode", http.StatusBadRequest)
		return
	}
	code, err := createInvite(body.RoomCode, time.Now())
	if err != nil {
		apiError(w, r, "internal error", http.StatusInternalServerError)
		return
	}
	if code == "" {
		apiError(w, r, "too many live invites", http.StatusServiceUnavailable)
		return
	}
	inviteJSON(w, r, http.StatusOK, map[string]any{
		"code": code,
		"ttl":  int(inviteTTL / time.Second),
	})
}

// GET /invite/{code} -> {"roomCode": "..."} or 404 {}
func handleInviteResolve(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	// Metered before the code is even parsed, and for hits as much as
	// misses: this is the guessing oracle.
	if !rateAllow("invite:"+clientIP(r), inviteRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	code := normalizeInviteCode(strings.TrimPrefix(r.URL.Path, "/invite/"))
	if !validInviteCode(code) {
		apiError(w, r, "bad code", http.StatusBadRequest)
		return
	}
	roomCode, ok := resolveInvite(code, time.Now())
	if !ok {
		// Counted after the miss so a hit never draws on it; a 429 here is
		// indistinguishable from a miss to a guesser and costs a real user
		// nothing but a retry.
		if !rateAllow("invite-miss", inviteMissLimit) {
			apiError(w, r, "rate limited", http.StatusTooManyRequests)
			return
		}
		inviteJSON(w, r, http.StatusNotFound, map[string]any{})
		return
	}
	inviteJSON(w, r, http.StatusOK, map[string]string{"roomCode": roomCode})
}

// postOnly is getOnly's twin for the one endpoint that writes.
func postOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			h(w, r)
		case http.MethodOptions:
			preflight(w, r)
		default:
			w.Header().Set("Allow", "POST, OPTIONS")
			apiError(w, r, "Method not allowed", http.StatusMethodNotAllowed)
		}
	}
}
