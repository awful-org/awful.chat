package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestTurnCredentials_NoSecretFallsBack(t *testing.T) {
	t.Setenv("TURN_SECRET", "")
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 when TURN_SECRET unset, got %d", rec.Code)
	}
}

func TestTurnCredentials_HMACIsValid(t *testing.T) {
	const secret = "test-secret-123"
	t.Setenv("TURN_SECRET", secret)
	// The served URL list is derived from DOMAIN now, and an instance with
	// neither DOMAIN nor TURN_URLS legitimately has no TURN to offer.
	t.Setenv("DOMAIN", "example.com")
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body struct {
		Username   string   `json:"username"`
		Credential string   `json:"credential"`
		TTL        int      `json:"ttl"`
		URLs       []string `json:"urls"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if body.Username == "" || body.Credential == "" || len(body.URLs) == 0 {
		t.Fatalf("incomplete response: %+v", body)
	}
	// The credential must be HMAC-SHA1(secret, username), base64-encoded -
	// exactly what coturn recomputes to authenticate.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(body.Username))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if body.Credential != want {
		t.Fatalf("credential HMAC mismatch: got %q want %q", body.Credential, want)
	}
}

func TestTurnCredentials_CustomURLs(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("TURN_URLS", "turn:a.example:3478 , , turn:b.example:5349")
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)

	var body struct {
		URLs []string `json:"urls"`
	}
	json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.URLs) != 2 || body.URLs[0] != "turn:a.example:3478" || body.URLs[1] != "turn:b.example:5349" {
		t.Fatalf("TURN_URLS not parsed/trimmed correctly: %#v", body.URLs)
	}
}

// Minting was unmetered, so anyone with curl could spin credentials for the
// operator's TURN server without bound.
func TestTurnCredentialsRateLimited(t *testing.T) {
	resetRateLimiter(t)
	t.Setenv("TURN_SECRET", "s")
	call := func() int {
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		req.RemoteAddr = "198.51.100.77:5000"
		rec := httptest.NewRecorder()
		handleTurnCredentials(rec, req)
		return rec.Code
	}
	for i := 0; i < 30; i++ {
		if code := call(); code == http.StatusTooManyRequests {
			t.Fatalf("request %d throttled inside the budget", i)
		}
	}
	if code := call(); code != http.StatusTooManyRequests {
		t.Fatalf("request over the budget got %d, want 429", code)
	}
}

// The default TURN URLs follow DOMAIN. They used to be a hardcoded
// awful.frav.in, so every self-hosted instance handed its users somebody
// else's TURN server, and the original instance broke on a domain move.
func TestTurnUrlsFollowDomain(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("TURN_URLS", "")
	t.Setenv("TURN_HOST", "")
	t.Setenv("DOMAIN", "example.org")

	body := turnBody(t)
	if len(body.URLs) == 0 {
		t.Fatal("no urls served")
	}
	for _, u := range body.URLs {
		if !strings.Contains(u, "example.org") {
			t.Errorf("url %q does not point at DOMAIN", u)
		}
	}

	// TURN_HOST wins over DOMAIN: coturn often lives on a hostname that
	// resolves straight to the box, while the app domain sits behind a CDN
	// that cannot forward TURN's UDP at all.
	t.Setenv("TURN_HOST", "turn.example.net")
	for _, u := range turnBody(t).URLs {
		if !strings.Contains(u, "turn.example.net") {
			t.Errorf("url %q ignored TURN_HOST", u)
		}
	}

	// An explicit list still wins over both.
	t.Setenv("TURN_URLS", "turn:a.example:3478?transport=udp,turn:b.example:3478?transport=udp")
	got := turnBody(t).URLs
	if len(got) != 2 || !strings.Contains(got[1], "b.example") {
		t.Errorf("TURN_URLS not honoured: %v", got)
	}
}

// With no TURN anywhere the endpoint says 204 rather than serving an empty
// list, which the client would turn into a TURN entry pointing nowhere.
func TestTurnCredentialsNoUrlsIsNoContent(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("TURN_URLS", "")
	t.Setenv("TURN_HOST", "")
	t.Setenv("DOMAIN", "")

	resetRateLimiter(t)
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 with no TURN configured, got %d", rec.Code)
	}
}

type turnResponse struct {
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
	TTL        int      `json:"ttl"`
	URLs       []string `json:"urls"`
}

func turnBody(t *testing.T) turnResponse {
	t.Helper()
	resetRateLimiter(t)
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var body turnResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	return body
}

// coturn keys --user-quota on the WHOLE username, so a bare expiry put every
// client that minted in the same wall-clock second into one shared allocation
// bucket. The id half has to be there, and it has to differ per request.
func TestTurnCredentialsUsernameCarriesAPerClientID(t *testing.T) {
	resetRateLimiter(t)
	const secret = "test-secret-123"
	t.Setenv("TURN_SECRET", secret)
	t.Setenv("DOMAIN", "example.com")

	mint := func() (username, credential string) {
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		req.RemoteAddr = "127.0.0.1:9999"
		rec := httptest.NewRecorder()
		handleTurnCredentials(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200, got %d", rec.Code)
		}
		var body struct {
			Username   string `json:"username"`
			Credential string `json:"credential"`
		}
		if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return body.Username, body.Credential
	}

	u1, c1 := mint()
	u2, _ := mint()

	// coturn parses the expiry as everything before the separator, so the form
	// has to be exactly "<unix-seconds>:<id>".
	expiry, id, found := strings.Cut(u1, ":")
	if !found {
		t.Fatalf("username %q carries no per-client id; every client in one second shares a quota bucket", u1)
	}
	if id == "" {
		t.Fatalf("username %q has an empty id half", u1)
	}
	if _, err := strconv.ParseInt(expiry, 10, 64); err != nil {
		t.Fatalf("username %q does not start with a unix expiry: %v", u1, err)
	}
	if u1 == u2 {
		t.Fatalf("two mints produced the same username %q, so they share a bucket after all", u1)
	}

	// The HMAC must still cover the whole username, or coturn rejects it.
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(u1))
	want := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if c1 != want {
		t.Fatalf("credential is not HMAC-SHA1 over the full username")
	}
}
