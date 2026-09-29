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
}

var pairingMu sync.Mutex
var pairingStore = map[string]*pairingEntry{}
var pairingLocator = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{8}$`)
var pairingAttempt = regexp.MustCompile(`^[0-9A-HJKMNP-TV-Z]{32}$`)
var pairingPayload = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

const pairingMaxLive = 1024
const pairingMaxAttempts = 5

func handlePairing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllow("pairing:"+clientIP(r), 240) || !rateAllow("pairing-global", 12000) {
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
	}
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	d.DisallowUnknownFields()
	if d.Decode(&b) != nil || d.Decode(new(any)) != io.EOF || b.Version != 2 || !pairingLocator.MatchString(b.Locator) {
		apiError(w, r, "invalid pairing request", http.StatusBadRequest)
		return
	}
	// Meter starts independently from polling, including misses, across all IPs.
	if b.Action == "start" && (!rateAllow("pairing-start:"+clientIP(r), 10) || !rateAllow("pairing-start-global", 300)) {
		apiError(w, r, "rate limited", 429)
		return
	}
	pairingMu.Lock()
	defer pairingMu.Unlock()
	now := time.Now()
	for key, e := range pairingStore {
		if !now.Before(e.expires) {
			delete(pairingStore, key)
		}
	}
	e := pairingStore[b.Locator]
	if b.Action == "create" {
		if !rateAllow("pairing-create:"+clientIP(r), 10) || !rateAllow("pairing-create-global", 300) || len(pairingStore) >= pairingMaxLive || e != nil {
			apiError(w, r, "pairing unavailable", http.StatusTooManyRequests)
			return
		}
		token := make([]byte, 32)
		if _, err := rand.Read(token); err != nil {
			apiError(w, r, "unavailable", 500)
			return
		}
		e = &pairingEntry{token: base64.RawURLEncoding.EncodeToString(token), expires: now.Add(5 * time.Minute), attempts: map[string][]pairingMessage{}, stages: map[string]string{}}
		pairingStore[b.Locator] = e
		inviteJSON(w, r, 200, map[string]string{"token": e.token})
		return
	}
	if e == nil {
		apiError(w, r, "pairing expired", 404)
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
		reply = e.inbox
		e.inbox = nil
	case "join-poll":
		if !pairingAttempt.MatchString(b.Attempt) {
			apiError(w, r, "invalid attempt", 400)
			return
		}
		messages, ok := e.attempts[b.Attempt]
		if !ok {
			apiError(w, r, "unknown attempt", 404)
			return
		}
		reply = messages
		e.attempts[b.Attempt] = nil
	default:
		if !pairingAttempt.MatchString(b.Attempt) || len(b.Payload) > 2048 || !pairingPayload.MatchString(b.Payload) {
			apiError(w, r, "invalid message", 400)
			return
		}
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

func pairingDeliver(e *pairingEntry, host bool, action, attempt, kind, payload string) bool {
	if e.closed {
		return false
	}
	m := pairingMessage{Attempt: attempt, Kind: kind, Payload: payload}
	stage, exists := e.stages[attempt]
	if action == "start" && !host && !exists && kind == "start" && len(e.attempts) < pairingMaxAttempts {
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
		if kind == "transfer" {
			e.closed = true
			e.inbox = nil
		}
		return true
	}
	return false
}
