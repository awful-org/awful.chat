package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// resetRateLimiter clears the process-global rate buckets. Without it these
// tests only pass on the first run in a process: `go test -count=2` (and any
// future test that spends the same bucket) starts with a drained window and
// the very first request is refused.
func resetRateLimiter(t *testing.T) {
	t.Helper()
	rateMu.Lock()
	defer rateMu.Unlock()
	for k := range rateBy {
		delete(rateBy, k)
	}
	lastSweep = time.Time{}
}

func TestSubstituteSecrets(t *testing.T) {
	secrets := map[string]pluginSecret{
		"STEAM": {value: "k&y 123", host: "api.steampowered.com"},
		"OPEN":  {value: "free"},
	}
	out, err := substituteSecrets("https://x/?key={{secret:steam}}&id=7", secrets, "api.steampowered.com")
	if err != nil {
		t.Fatal(err)
	}
	want := "https://x/?key=k%26y+123&id=7"
	if out != want {
		t.Errorf("got %q want %q", out, want)
	}
	// A bound secret must NOT substitute for another host - this is the
	// cross-host leakage the review flagged.
	if _, err := substituteSecrets("https://x/?k={{secret:steam}}", secrets, "evil.example"); err == nil {
		t.Error("host-bound secret leaked to another host")
	}
	// An unbound secret works for any host.
	if out, err := substituteSecrets("https://x/?k={{secret:open}}", secrets, "evil.example"); err != nil || out != "https://x/?k=free" {
		t.Errorf("unbound secret: %q %v", out, err)
	}
	if _, err := substituteSecrets("https://x/?key={{secret:missing}}", secrets, "h"); err == nil {
		t.Error("missing secret must error")
	}
	if out, _ := substituteSecrets("https://x/plain", secrets, "h"); out != "https://x/plain" {
		t.Errorf("plain url mangled: %q", out)
	}
}

// A caller url carrying userinfo (https://u:p@allowed.host/x) would otherwise
// reach Go's http.Client unchanged, which sends Authorization: Basic derived
// from it to whatever allowlisted host the caller names - letting any caller
// pick the credential an allowlisted upstream sees.
func TestPluginProxyRejectsUserinfoInURL(t *testing.T) {
	resetRateLimiter(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "allowed.host")
	req := httptest.NewRequest(http.MethodGet, "/plugin-proxy?url="+url.QueryEscape("https://u:p@allowed.host/x"), nil)
	rec := httptest.NewRecorder()
	handlePluginProxy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a url with userinfo, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestPluginProxyRateLimit(t *testing.T) {
	resetRateLimiter(t)
	ip := "203.0.113.9"
	for i := 0; i < pluginProxyRateLimit; i++ {
		if !pluginProxyAllow(ip) {
			t.Fatalf("request %d refused inside the window", i)
		}
	}
	if pluginProxyAllow(ip) {
		t.Error("request over the limit allowed")
	}
	if !pluginProxyAllow("203.0.113.10") {
		t.Error("another client caught by the first client's bucket")
	}
}

func TestPluginProxyEnvParsing(t *testing.T) {
	t.Setenv("PLUGIN_PROXY_HOSTS", "api.steampowered.com, Other.API ,")
	hosts := pluginProxyHosts()
	if !hosts["api.steampowered.com"] || !hosts["other.api"] || len(hosts) != 2 {
		t.Errorf("hosts parsed wrong: %v", hosts)
	}
	t.Setenv("PLUGIN_PROXY_SECRETS", "steam@API.Steampowered.com=abc, FOO=a=b,")
	secrets := pluginProxySecrets()
	if secrets["STEAM"].value != "abc" || secrets["STEAM"].host != "api.steampowered.com" {
		t.Errorf("bound secret parsed wrong: %+v", secrets["STEAM"])
	}
	if secrets["FOO"].value != "a=b" || secrets["FOO"].host != "" || len(secrets) != 2 {
		t.Errorf("secrets parsed wrong: %v", secrets)
	}
}

func TestRateAllowConcurrent(t *testing.T) {
	resetRateLimiter(t)
	// The sync.Map predecessor let N concurrent requests all read the same
	// stale count and all pass; the mutexed window must admit exactly the
	// limit no matter the concurrency.
	const attempts = 100
	var allowed int64
	var wg sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if rateAllow("test:concurrent", 10) {
				atomic.AddInt64(&allowed, 1)
			}
		}()
	}
	wg.Wait()
	if allowed != 10 {
		t.Fatalf("admitted %d, want exactly 10", allowed)
	}
}

// X-Forwarded-For is a request header, so honouring it from a peer that is
// not our own proxy let any direct caller pick its own rate-limit bucket -
// every per-IP budget in the binary became a formality.
func TestClientIPTrustsOnlyProxies(t *testing.T) {
	cases := []struct {
		name   string
		remote string
		xff    string
		want   string
	}{
		{"direct caller cannot forge a bucket", "198.51.100.4:9000", "203.0.113.1", "198.51.100.4"},
		{"behind the proxy the header is the client", "10.0.0.1:9000", "203.0.113.1", "203.0.113.1"},
		{"a client-prepended hop is ignored", "10.0.0.1:9000", "203.0.113.1, 198.51.100.9", "198.51.100.9"},
		{"a trusted extra hop is skipped", "10.0.0.1:9000", "203.0.113.1, 10.0.0.7", "203.0.113.1"},
		{"no header falls back to the socket peer", "10.0.0.1:9000", "", "10.0.0.1"},
		{"all-private hops keep the last one", "10.0.0.1:9000", "10.4.4.4", "10.4.4.4"},
		{"garbage in the header is skipped", "10.0.0.1:9000", "203.0.113.1, not-an-ip", "203.0.113.1"},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/plugin-proxy", nil)
		req.RemoteAddr = c.remote
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientIP(req); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

// The cache key is caller-chosen and expiry is only ever evaluated on a
// lookup of that exact key, so an unbounded map meant any caller could pin
// memory permanently by never asking for the same url twice.
func TestPluginProxyCacheBounded(t *testing.T) {
	body := bytes.Repeat([]byte("b"), 1024)
	for i := 0; i < pluginProxyCacheMaxEntries*2; i++ {
		pluginProxyStore(fmt.Sprintf("pp:https://h/?i=%d", i), body, "application/json")
	}
	pluginProxyCacheMu.Lock()
	entries, order, size := len(pluginProxyCache), len(pluginProxyCacheOrder), pluginProxyCacheBytes
	pluginProxyCacheMu.Unlock()
	if entries > pluginProxyCacheMaxEntries || order != entries {
		t.Fatalf("cache held %d entries (order %d), cap is %d", entries, order, pluginProxyCacheMaxEntries)
	}
	if size != entries*len(body) {
		t.Fatalf("byte accounting drifted: %d bytes for %d entries", size, entries)
	}
	// Oldest-first: the first key is gone, the last one is still served.
	if _, ok := pluginProxyCached("pp:https://h/?i=0"); ok {
		t.Error("the oldest entry survived eviction")
	}
	last := fmt.Sprintf("pp:https://h/?i=%d", pluginProxyCacheMaxEntries*2-1)
	if _, ok := pluginProxyCached(last); !ok {
		t.Error("the newest entry was evicted")
	}
	// Re-storing a key must not double-count it.
	before := size
	pluginProxyStore(last, body, "application/json")
	pluginProxyCacheMu.Lock()
	after := pluginProxyCacheBytes
	pluginProxyCacheMu.Unlock()
	if after != before {
		t.Fatalf("refresh double-counted: %d -> %d", before, after)
	}
}

// Every /plugin-proxy request used to build its own http.Transport. A
// hand-built Transport does not inherit http.DefaultTransport's 90s
// IdleConnTimeout, and net/http only arms the idle timer when that value is
// above zero - so each request's keep-alive connection, plus the readLoop and
// writeLoop goroutines serving it, stayed alive for the life of the process,
// and the Transport itself could not be collected because those goroutine
// stacks referenced it. Only the Client may vary per request; it has to,
// because CheckRedirect closes over the caller's allowlist and pinned host.
func TestPluginProxyClientsShareOneTransport(t *testing.T) {
	a := pluginProxyClient(map[string]bool{"a.example": true}, "a.example")
	b := pluginProxyClient(map[string]bool{"b.example": true}, "")

	if a == b {
		t.Fatal("the Client must stay per-request: CheckRedirect closes over the allowlist")
	}
	if a.Transport != b.Transport {
		t.Fatal("each call built its own Transport; that is the goroutine and socket leak")
	}
	tr, ok := a.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("unexpected transport type %T", a.Transport)
	}
	if tr.IdleConnTimeout <= 0 {
		t.Fatal("IdleConnTimeout is unset, so idle keep-alive connections are never reaped")
	}

	// The redirect policy must still be per-request, or one caller's allowlist
	// would govern another's.
	req := httptest.NewRequest(http.MethodGet, "https://b.example/x", nil)
	if err := a.CheckRedirect(req, nil); err == nil {
		t.Fatal("client a accepted a redirect to b.example; the closures got shared")
	}
}
