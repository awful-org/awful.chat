package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKlipyIntParam(t *testing.T) {
	cases := []struct {
		raw  string
		want int
	}{
		{"", 18},                      // absent, keep the old default
		{" 24 ", 24},                  // the picker sends plain numbers
		{"0", 18},                     // zero and negatives are not counts
		{"-5", 18},                    //
		{"999", 50},                   // clamped, not refused
		{"18&customer_id=x", 18},      // the injection this replaces
		{"1 OR 1", 18},                //
		{"1e3", 18},                   //
		{strings.Repeat("9", 40), 18}, // overflows Atoi, must not panic or pass through
	}
	for _, c := range cases {
		if got := klipyIntParam(c.raw, 18, 50); got != c.want {
			t.Errorf("klipyIntParam(%q) = %d, want %d", c.raw, got, c.want)
		}
	}
}

func TestKlipyRedact(t *testing.T) {
	old := klipyAPIKey
	defer func() { klipyAPIKey = old }()

	klipyAPIKey = "sk-secret-123"
	msg := `Get "https://api.klipy.com/api/v1/sk-secret-123/gifs/search?q=cat": dial tcp: timeout`
	got := klipyRedact(msg)
	if strings.Contains(got, "sk-secret-123") {
		t.Errorf("key survived redaction: %s", got)
	}
	if !strings.Contains(got, "<redacted>") {
		t.Errorf("redaction marker missing: %s", got)
	}

	// With no key configured the replacement must be a no-op: ReplaceAll on an
	// empty needle would otherwise splice the marker between every character.
	klipyAPIKey = ""
	if got := klipyRedact("plain message"); got != "plain message" {
		t.Errorf("empty key mangled the message: %q", got)
	}
}

func TestKlipyRateLimit(t *testing.T) {
	resetRateLimiter(t)
	// The key is deliberately left unset: the budget is checked before the
	// key, so the handler answers without ever touching the network.
	old := klipyAPIKey
	klipyAPIKey = ""
	defer func() { klipyAPIKey = old }()

	// An IP of its own so this test cannot be starved by, or starve, another.
	const ip = "203.0.113.77"
	// clientIP only honours X-Forwarded-For when the SOCKET PEER is a trusted
	// proxy; httptest's default RemoteAddr (192.0.2.1, TEST-NET-1) is not one,
	// so without this every request would land in the same bucket and the
	// per-client assertion below would be meaningless.
	const proxy = "127.0.0.1:9999"
	call := func(h http.HandlerFunc, path string) int {
		req := httptest.NewRequest("GET", path, nil)
		req.RemoteAddr = proxy
		req.Header.Set("X-Forwarded-For", ip)
		rec := httptest.NewRecorder()
		h(rec, req)
		return rec.Code
	}

	// Search and trending share one bucket because they share one paid quota.
	for i := 0; i < klipyRateLimit; i++ {
		h, path := handleKlipySearch, "/klipy/search?q=cat"
		if i%2 == 1 {
			h, path = handleKlipyTrending, "/klipy/trending"
		}
		if code := call(h, path); code == http.StatusTooManyRequests {
			t.Fatalf("request %d throttled inside the budget", i)
		}
	}
	if code := call(handleKlipySearch, "/klipy/search?q=cat"); code != http.StatusTooManyRequests {
		t.Errorf("request over the budget got %d, want 429", code)
	}
	if code := call(handleKlipyTrending, "/klipy/trending"); code != http.StatusTooManyRequests {
		t.Errorf("trending shares the bucket, got %d, want 429", code)
	}

	// A second client must not be caught by the first client's bucket.
	req := httptest.NewRequest("GET", "/klipy/search?q=cat", nil)
	req.RemoteAddr = proxy
	req.Header.Set("X-Forwarded-For", "203.0.113.78")
	rec := httptest.NewRecorder()
	handleKlipySearch(rec, req)
	if rec.Code == http.StatusTooManyRequests {
		t.Error("another client caught by the first client's bucket")
	}
}
