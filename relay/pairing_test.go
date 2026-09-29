package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetPairing(t *testing.T) {
	t.Helper()
	pairingMu.Lock()
	pairingStore = map[string]*pairingEntry{}
	pairingMu.Unlock()
	rateMu.Lock()
	for k := range rateBy {
		if strings.HasPrefix(k, "pairing") {
			delete(rateBy, k)
		}
	}
	rateMu.Unlock()
}
func pairingRequest(t *testing.T, ip string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body["version"] = 2
	if body["locator"] == nil {
		body["locator"] = "k5"
	}
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest("POST", "/invite", strings.NewReader(string(data)))
	req.RemoteAddr = ip + ":1234"
	rec := httptest.NewRecorder()
	mux := http.NewServeMux()
	registerInviteEndpoints(mux)
	mux.ServeHTTP(rec, req)
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("pairing response cached")
	}
	return rec
}
func createPairing(t *testing.T) string {
	t.Helper()
	rec := pairingRequest(t, "10.0.0.1", map[string]any{"action": "create"})
	if rec.Code != 200 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var body struct{ Token string }
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Token) != 43 {
		t.Fatal("invalid host token")
	}
	return body.Token
}
func TestPairingMountedExchangeSingleUse(t *testing.T) {
	resetPairing(t)
	token := createPairing(t)
	attempt := strings.Repeat("a", 32)
	send := func(action, kind, payload, auth string, want int) *httptest.ResponseRecorder {
		t.Helper()
		rec := pairingRequest(t, "10.0.0.2", map[string]any{"action": action, "kind": kind, "payload": payload, "token": auth, "attempt": attempt})
		if rec.Code != want {
			t.Fatalf("%s: %d %s", action, rec.Code, rec.Body)
		}
		return rec
	}
	send("start", "start", "opaque_request", "", 200)
	send("start", "start", "opaque_request", "", 409)
	send("reply", "response", "opaque_response", "", 409)
	send("host-poll", "", "", "wrong", 403)
	rec := send("host-poll", "", "", token, 200)
	if !strings.Contains(rec.Body.String(), "opaque_request") {
		t.Fatal("host lost request")
	}
	if strings.Contains(send("host-poll", "", "", token, 200).Body.String(), "opaque_request") {
		t.Fatal("inbox replay")
	}
	send("finish", "finish", "proof", "", 409)
	send("reply", "response", "opaque_response", token, 200)
	rec = send("join-poll", "", "", "", 200)
	if !strings.Contains(rec.Body.String(), "opaque_response") {
		t.Fatal("missing response")
	}
	send("finish", "finish", "proof", "", 200)
	send("finish", "finish", "proof", "", 409)
	send("reply", "transfer", "nonce.ciphertext", token, 200)
	send("start", "start", "another_request", "", 409)
	rec = send("join-poll", "", "", "", 200)
	if !strings.Contains(rec.Body.String(), "nonce.ciphertext") {
		t.Fatal("missing encrypted transfer")
	}
	if strings.Contains(send("join-poll", "", "", "", 200).Body.String(), "ciphertext") {
		t.Fatal("transfer replay")
	}
	send("cancel", "", "", token, 200)
	send("host-poll", "", "", token, 404)
}
func TestPairingLimitsAndExpiry(t *testing.T) {
	resetPairing(t)
	token := createPairing(t)
	for i := 0; i < 6; i++ {
		rec := pairingRequest(t, "10.0.0.2", map[string]any{"action": "start", "kind": "start", "payload": "opaque", "attempt": strings.Repeat(string(rune('a'+i)), 32)})
		want := 200
		if i == 5 {
			want = 409
		}
		if rec.Code != want {
			t.Fatalf("attempt %d: %d", i, rec.Code)
		}
	}
	pairingMu.Lock()
	pairingStore["k5"].expires = time.Now().Add(-time.Second)
	pairingMu.Unlock()
	if rec := pairingRequest(t, "10.0.0.1", map[string]any{"action": "host-poll", "token": token}); rec.Code != 404 {
		t.Fatal("expired session admitted")
	}
	pairingMu.Lock()
	for i := 0; i < pairingMaxLive; i++ {
		pairingStore[fmt.Sprint(i)] = &pairingEntry{expires: time.Now().Add(time.Minute)}
	}
	pairingMu.Unlock()
	if rec := pairingRequest(t, "10.0.0.1", map[string]any{"action": "create"}); rec.Code != 429 {
		t.Fatal("capacity exceeded")
	}
}
func TestPairingStartBudgetsIncludeMisses(t *testing.T) {
	resetPairing(t)
	for i := 0; i < 11; i++ {
		rec := pairingRequest(t, "10.0.0.2", map[string]any{"action": "start"})
		want := 404
		if i == 10 {
			want = 429
		}
		if rec.Code != want {
			t.Fatalf("per-IP %d: %d", i, rec.Code)
		}
	}
	resetPairing(t)
	for i := 0; i < 301; i++ {
		rec := pairingRequest(t, fmt.Sprintf("10.1.%d.%d", i/250, i%250+1), map[string]any{"action": "start"})
		want := 404
		if i == 300 {
			want = 429
		}
		if rec.Code != want {
			t.Fatalf("global %d: %d", i, rec.Code)
		}
	}
}
func TestPairingRejectsMalformedAndOrigin(t *testing.T) {
	resetPairing(t)
	oldStrict, oldDomain := strictOrigin, domain
	strictOrigin, domain = true, "chat.example"
	defer func() { strictOrigin, domain = oldStrict, oldDomain }()
	for _, body := range []string{
		`{"version":2,"action":"create","locator":"k5","password":"secret"}`,
		`{"version":2,"action":"create","locator":"k5"} {}`,
		`{"version":1,"action":"create","locator":"k5"}`,
		`{"version":2,"action":"create","locator":"k5","payload":"` + strings.Repeat("A", 4096) + `"}`,
	} {
		rec := httptest.NewRecorder()
		postOnly(handleInviteCreate)(rec, httptest.NewRequest("POST", "/invite", strings.NewReader(body)))
		if rec.Code != 400 {
			t.Fatalf("malformed: %d", rec.Code)
		}
	}
	req := httptest.NewRequest("POST", "/invite", strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://evil.invalid")
	rec := httptest.NewRecorder()
	postOnly(handleInviteCreate)(rec, req)
	if rec.Code != 403 {
		t.Fatalf("origin: %d", rec.Code)
	}
}

// Two characters leave room for two live pairings to draw the same locator.
// The second create gets 409 of its own - not the 429 of a full or throttled
// relay - so the client knows a fresh draw will do.
func TestPairingLocatorInUseIsConflict(t *testing.T) {
	resetPairing(t)
	createPairing(t)
	if rec := pairingRequest(t, "10.0.0.3", map[string]any{"action": "create"}); rec.Code != http.StatusConflict {
		t.Fatalf("live locator: %d", rec.Code)
	}
	if rec := pairingRequest(t, "10.0.0.3", map[string]any{"action": "create", "locator": "q7"}); rec.Code != 200 {
		t.Fatalf("fresh locator: %d", rec.Code)
	}
}

// Lowercase only, two characters, Crockford alphabet: the old eight-character
// uppercase locator and confusable letters are refused before any lookup.
func TestPairingLocatorFormat(t *testing.T) {
	resetPairing(t)
	for _, locator := range []string{"K5", "k", "k5t", "12345678", "ku", "ki"} {
		if rec := pairingRequest(t, "10.0.0.4", map[string]any{"action": "create", "locator": locator}); rec.Code != 400 {
			t.Fatalf("locator %q: %d", locator, rec.Code)
		}
	}
}
