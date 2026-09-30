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

// ke1 is a start payload of the shape a real one has: an OPAQUE KE1, 128
// characters of base64url. The tag keeps two of them apart.
func ke1(tag string) string {
	return tag + strings.Repeat("A", 128-len(tag))
}

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
	send("start", "start", ke1("opaque_request"), "", 200)
	send("start", "start", ke1("opaque_request"), "", 409)
	send("reply", "response", "opaque_response", "", 409)
	send("host-poll", "", "", "wrong", 403)
	rec := send("host-poll", "", "", token, 200)
	if !strings.Contains(rec.Body.String(), ke1("opaque_request")) {
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
	send("start", "start", ke1("another_request"), "", 409)
	rec = send("join-poll", "", "", "", 200)
	if !strings.Contains(rec.Body.String(), "nonce.ciphertext") {
		t.Fatal("missing encrypted transfer")
	}
	if strings.Contains(send("join-poll", "", "", "", 200).Body.String(), "ciphertext") {
		t.Fatal("transfer replay")
	}
	send("cancel", "", "", token, 200)
	// Gone now, and answered as a live pairing answers a wrong token.
	send("host-poll", "", "", token, 403)
}
func TestPairingLimitsAndExpiry(t *testing.T) {
	resetPairing(t)
	token := createPairing(t)
	for i := 0; i < 6; i++ {
		rec := pairingRequest(t, "10.0.0.2", map[string]any{"action": "start", "kind": "start", "payload": ke1("opaque"), "attempt": strings.Repeat(string(rune('a'+i)), 32)})
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
	if rec := pairingRequest(t, "10.0.0.1", map[string]any{"action": "host-poll", "token": token}); rec.Code != 403 {
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
	start := func(ip, locator string) int {
		return pairingRequest(t, ip, map[string]any{"action": "start", "kind": "start", "locator": locator,
			"payload": ke1("x"), "attempt": strings.Repeat("a", 32)}).Code
	}
	// Per client, misses included, spread over locators.
	for i := 0; i < pairingStartsPerClient+1; i++ {
		want := http.StatusConflict
		if i == pairingStartsPerClient {
			want = http.StatusTooManyRequests
		}
		if code := start("10.0.0.2", fmt.Sprintf("%c%c", "0123456789"[i%10], 'a'+i/10)); code != want {
			t.Fatalf("per-IP %d: %d", i, code)
		}
	}
	// Per locator, from many clients.
	resetPairing(t)
	for i := 0; i < pairingStartsPerLocator+1; i++ {
		want := http.StatusConflict
		if i == pairingStartsPerLocator {
			want = http.StatusTooManyRequests
		}
		if code := start(fmt.Sprintf("10.1.0.%d", i+1), "k5"); code != want {
			t.Fatalf("per-locator %d: %d", i, code)
		}
	}
}

// There is no global start or create bucket for a few dozen clients to
// empty: many clients, each well inside its own budget, never lock
// everybody else out.
func TestPairingHasNoGlobalBucketToStarve(t *testing.T) {
	resetPairing(t)
	locators := "0123456789abcdefghjkmnpqrstvwxyz"
	for i := 0; i < 600; i++ {
		loc := string(locators[i%32]) + string(locators[(i/32)%32])
		code := pairingRequest(t, fmt.Sprintf("10.2.%d.%d", i/250, i%250+1), map[string]any{
			"action": "start", "kind": "start", "locator": loc, "payload": ke1("x"), "attempt": strings.Repeat("b", 32),
		}).Code
		if code == http.StatusTooManyRequests {
			t.Fatalf("start %d refused by a shared bucket", i)
		}
	}
	// A real pairing still works after all that.
	createPairing(t)
}

// Nothing tells a stranger which locators are live except a start, which
// spends one of that pairing's attempts. Every other request gets the same
// answer from a live pairing as from an empty locator.
func TestPairingDoesNotRevealLiveness(t *testing.T) {
	resetPairing(t)
	createPairing(t) // live at k5
	stranger := []map[string]any{
		{"action": "host-poll"},
		{"action": "host-poll", "token": strings.Repeat("t", 43)},
		{"action": "cancel"},
		{"action": "join-poll", "attempt": strings.Repeat("c", 32)},
		{"action": "finish", "kind": "finish", "payload": "proof", "attempt": strings.Repeat("c", 32)},
		{"action": "reply", "kind": "response", "payload": "resp", "attempt": strings.Repeat("c", 32)},
		{"action": "start", "kind": "start", "payload": "short", "attempt": strings.Repeat("c", 32)},
		{"action": "join-poll", "attempt": "bad"},
	}
	for _, body := range stranger {
		live := map[string]any{"locator": "k5"}
		empty := map[string]any{"locator": "q7"}
		for k, v := range body {
			live[k], empty[k] = v, v
		}
		a := pairingRequest(t, "10.0.0.9", live)
		b := pairingRequest(t, "10.0.0.9", empty)
		if a.Code != b.Code || a.Body.String() != b.Body.String() {
			t.Errorf("%v: live answered %d %s, empty %d %s", body, a.Code, a.Body, b.Code, b.Body)
		}
	}
}

// A start that is not the shape of a real one is refused before it can
// spend one of the pairing's attempts.
func TestPairingMalformedStartSpendsNoAttempt(t *testing.T) {
	resetPairing(t)
	createPairing(t)
	for i, payload := range []string{"x", ke1("x") + "A", strings.Repeat("A", 127), strings.Repeat("A", 126) + ".A"} {
		rec := pairingRequest(t, "10.0.0.5", map[string]any{"action": "start", "kind": "start", "payload": payload, "attempt": strings.Repeat(string(rune('a'+i)), 32)})
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("malformed start %d: %d", i, rec.Code)
		}
	}
	pairingMu.Lock()
	spent := len(pairingStore["k5"].attempts)
	pairingMu.Unlock()
	if spent != 0 {
		t.Fatalf("malformed starts spent %d attempts", spent)
	}
}

// One source holds at most pairingMaxLivePerSource pairings, so filling
// the store takes many.
func TestPairingLivePerSource(t *testing.T) {
	resetPairing(t)
	locators := "0123456789abcdefghjkmnpqrstvwxyz"
	for i := 0; i < pairingMaxLivePerSource+1; i++ {
		want := 200
		if i == pairingMaxLivePerSource {
			want = http.StatusTooManyRequests
		}
		if rec := pairingRequest(t, "10.0.7.7", map[string]any{"action": "create", "locator": "a" + string(locators[i])}); rec.Code != want {
			t.Fatalf("create %d: %d", i, rec.Code)
		}
	}
	if rec := pairingRequest(t, "10.0.7.8", map[string]any{"action": "create", "locator": "zz"}); rec.Code != 200 {
		t.Fatalf("another source refused: %d", rec.Code)
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
