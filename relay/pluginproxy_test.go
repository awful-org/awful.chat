package main

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
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
		"STEAM":  {value: "k&y 123", host: "api.steampowered.com", path: "/ISteamUser/", param: "key"},
		"EXACT":  {value: "e", host: "api.example", path: "/v1/lookup", param: "token"},
		"LEGACY": {value: "old", host: "api.steampowered.com", legacy: true},
	}
	const host = "api.steampowered.com"
	out, err := substituteSecrets("https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={{secret:steam}}&id=7", secrets, host)
	if err != nil {
		t.Fatal(err)
	}
	if want := "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=k%26y+123&id=7"; out != want {
		t.Errorf("got %q want %q", out, want)
	}
	if _, err := substituteSecrets("https://api.example/v1/lookup?token={{secret:exact}}", secrets, "api.example"); err != nil {
		t.Errorf("exact path: %v", err)
	}
	if _, err := substituteSecrets("https://api.example/v1/lookup/more?token={{secret:exact}}", secrets, "api.example"); err != nil {
		t.Errorf("below an exact path: %v", err)
	}

	// Every way of steering the key somewhere it was not bound to.
	for name, raw := range map[string]string{
		"another host":            "https://evil.example/ISteamUser/x?key={{secret:steam}}",
		"another parameter":       "https://api.steampowered.com/ISteamUser/x?callback={{secret:steam}}",
		"another path":            "https://api.steampowered.com/IEcho/x?key={{secret:steam}}",
		"a path that climbs out":  "https://api.steampowered.com/ISteamUser/../IEcho/x?key={{secret:steam}}",
		"an encoded climb":        "https://api.steampowered.com/ISteamUser%2F..%2FIEcho?key={{secret:steam}}",
		"an empty segment":        "https://api.steampowered.com/ISteamUser//x?key={{secret:steam}}",
		"a prefix lookalike":      "https://api.example/v1/lookupall?token={{secret:exact}}",
		"glued to another value":  "https://api.steampowered.com/ISteamUser/x?key=echo{{secret:steam}}",
		"as the parameter name":   "https://api.steampowered.com/ISteamUser/x?{{secret:steam}}=1",
		"an unbound (old) secret": "https://api.steampowered.com/ISteamUser/x?key={{secret:legacy}}",
		"a secret nobody set":     "https://api.steampowered.com/ISteamUser/x?key={{secret:missing}}",
	} {
		target := host
		if name == "another host" {
			target = "evil.example"
		}
		if name == "a prefix lookalike" {
			target = "api.example"
		}
		if out, err := substituteSecrets(raw, secrets, target); err == nil {
			t.Errorf("%s: substituted into %q", name, out)
		}
	}
	if out, _ := substituteSecrets("https://x/plain", secrets, "h"); out != "https://x/plain" {
		t.Errorf("plain url mangled: %q", out)
	}
}

func TestPluginProxyRateLimit(t *testing.T) {
	resetRateLimiter(t)
	ip := "203.0.113.9"
	for i := 0; i < pluginProxyRateLimit; i++ {
		if !pluginProxyAllow(reqFrom(ip)) {
			t.Fatalf("request %d refused inside the window", i)
		}
	}
	if pluginProxyAllow(reqFrom(ip)) {
		t.Error("request over the limit allowed")
	}
	if !pluginProxyAllow(reqFrom("203.0.113.10")) {
		t.Error("another client caught by the first client's bucket")
	}
}

// reqFrom is a request whose socket peer is addr, so it is its own client.
func reqFrom(addr string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = net.JoinHostPort(addr, "1234")
	return req
}

func TestPluginProxyEnvParsing(t *testing.T) {
	t.Setenv("PLUGIN_PROXY_HOSTS", "api.steampowered.com, Other.API ,")
	hosts := pluginProxyHosts()
	if !hosts["api.steampowered.com"] || !hosts["other.api"] || len(hosts) != 2 {
		t.Errorf("hosts parsed wrong: %v", hosts)
	}
	t.Setenv("PLUGIN_PROXY_SECRETS", "steam@API.Steampowered.com/ISteamUser/?key=abc, FOO=a=b, BAR@host.example=x, BAZ@host.example/a/../b?k=y, TOP@host.example?k=a=b")
	secrets := pluginProxySecrets()
	if s := secrets["STEAM"]; s.value != "abc" || s.host != "api.steampowered.com" || s.path != "/ISteamUser/" || s.param != "key" || s.legacy {
		t.Errorf("bound secret parsed wrong: %+v", s)
	}
	if s := secrets["TOP"]; s.value != "a=b" || s.path != "/" || s.param != "k" || s.legacy {
		t.Errorf("host-wide secret parsed wrong: %+v", s)
	}
	// The old forms and anything malformed parse, but are never used.
	for _, name := range []string{"FOO", "BAR", "BAZ"} {
		if !secrets[name].legacy {
			t.Errorf("%s should be unusable: %+v", name, secrets[name])
		}
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
	held := pluginProxyCacheHeldLocked()
	pluginProxyCacheMu.Unlock()
	if entries > pluginProxyCacheMaxEntries || order != entries {
		t.Fatalf("cache held %d entries (order %d), cap is %d", entries, order, pluginProxyCacheMaxEntries)
	}
	if size != held {
		t.Fatalf("byte accounting drifted: %d bytes counted, %d held by %d entries", size, held, entries)
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

// resetPluginProxyCache empties the response cache, so a test starts cold.
func resetPluginProxyCache(t *testing.T) {
	t.Helper()
	pluginProxyCacheMu.Lock()
	defer pluginProxyCacheMu.Unlock()
	pluginProxyCache = map[string]pluginProxyCacheEntry{}
	pluginProxyCacheOrder = nil
	pluginProxyCacheBytes = 0
}

// pluginProxyCacheHeldLocked is what the cache really holds: every key and
// every body. Caller holds pluginProxyCacheMu.
func pluginProxyCacheHeldLocked() int {
	held := 0
	for k, e := range pluginProxyCache {
		held += len(k) + len(e.body)
	}
	return held
}

// The key is the whole url, the caller's choice up to the megabyte request
// line the relay reads, and only bodies counted against the 64 MiB: urls
// with small answers filled every entry while the cache said it held a few
// kilobytes. Keys count now, and one longer than its even share is not kept.
func TestPluginProxyCacheCountsItsKeys(t *testing.T) {
	resetPluginProxyCache(t)
	t.Cleanup(func() { resetPluginProxyCache(t) })

	// Distinct keys of exactly the longest kept length, as windows over one
	// string so the test does not hold 64 MiB of its own.
	r := rand.New(rand.NewPCG(1, 2))
	letters := make([]byte, pluginProxyCacheMaxKeyBytes+pluginProxyCacheMaxEntries+100)
	for i := range letters {
		letters[i] = byte('a' + r.IntN(26))
	}
	all := string(letters)
	body := []byte("{}")
	for i := 0; i < pluginProxyCacheMaxEntries+100; i++ {
		pluginProxyStore(all[i:i+pluginProxyCacheMaxKeyBytes], body, "application/json")

		pluginProxyCacheMu.Lock()
		held, counted, entries := pluginProxyCacheHeldLocked(), pluginProxyCacheBytes, len(pluginProxyCache)
		pluginProxyCacheMu.Unlock()
		if held != counted {
			t.Fatalf("store %d: the cache holds %d bytes of keys and bodies but counts %d", i, held, counted)
		}
		if held > pluginProxyCacheMaxBytes {
			t.Fatalf("store %d: %d entries hold %d bytes, cap %d", i, entries, held, pluginProxyCacheMaxBytes)
		}
	}
	pluginProxyCacheMu.Lock()
	entries := len(pluginProxyCache)
	pluginProxyCacheMu.Unlock()
	if entries >= pluginProxyCacheMaxEntries {
		t.Fatalf("%d urls of %d bytes each with two-byte answers fit, so their keys were not counted", entries, pluginProxyCacheMaxKeyBytes)
	}

	// A url past its share is not kept at all, and costs the cache nothing.
	pluginProxyCacheMu.Lock()
	before := pluginProxyCacheBytes
	pluginProxyCacheMu.Unlock()
	long := "pp:https://h/?" + strings.Repeat("k", pluginProxyCacheMaxKeyBytes)
	pluginProxyStore(long, body, "application/json")
	if _, ok := pluginProxyCached(long); ok {
		t.Fatalf("a %d-byte url was kept, longest kept is %d", len(long), pluginProxyCacheMaxKeyBytes)
	}
	pluginProxyCacheMu.Lock()
	after := pluginProxyCacheBytes
	pluginProxyCacheMu.Unlock()
	if after != before {
		t.Fatalf("an unkept url changed the count: %d -> %d", before, after)
	}
}

// Through the handler: a url longer than its share is fetched for every ask,
// and a normal one is still answered from the cache.
func TestPluginProxyLongURLsAreNotKept(t *testing.T) {
	resetRateLimiter(t)
	resetPluginProxyCache(t)
	t.Cleanup(func() { resetPluginProxyCache(t) })
	var fetches atomic.Int64
	srv := proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	})
	ask := func(raw string) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/plugin-proxy?url="+url.QueryEscape(raw), nil)
		rec := httptest.NewRecorder()
		handlePluginProxy(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
	}

	long := srv.URL + "/card?pad=" + strings.Repeat("a", pluginProxyCacheMaxKeyBytes)
	ask(long)
	ask(long)
	if n := fetches.Load(); n != 2 {
		t.Fatalf("two asks for a url past its share cost %d fetches, want one each", n)
	}

	short := srv.URL + "/card?id=" + t.Name()
	ask(short)
	ask(short)
	if n := fetches.Load(); n != 3 {
		t.Fatalf("two asks for a short url cost %d fetches, want one", n-2)
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

// proxyUpstream points the shared outbound transport at a local test server.
// pluginProxySafeDial refuses loopback by design, so an httptest upstream is
// unreachable through the real one; a TLS test server's own client transport
// dials it and trusts its certificate, which lets these tests drive the real
// handler over a real https url.
func proxyUpstream(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	prev := pluginProxyTransport
	pluginProxyTransport = srv.Client().Transport.(*http.Transport)
	t.Cleanup(func() {
		pluginProxyTransport = prev
		srv.Close()
	})
	t.Setenv("PLUGIN_PROXY_HOSTS", "127.0.0.1")
	return srv
}

// This endpoint passes the upstream's own Content-Type through, and a
// top-level navigation carries no Origin, which isAllowedOrigin permits on
// purpose - so an allowlisted host's HTML or SVG would otherwise render as a
// document on the relay's own origin. Both the fresh and the cached answer
// have to say attachment; pluginstream.go already does the same on its path.
func TestPluginProxyForcesDownloadOnBothPaths(t *testing.T) {
	resetRateLimiter(t)
	srv := proxyUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<script>alert(document.domain)</script>"))
	})

	// A key nothing else in this process has cached.
	raw := srv.URL + "/page.html?disposition=" + t.Name()
	for _, path := range []string{"fresh", "cached"} {
		req := httptest.NewRequest(http.MethodGet, "/plugin-proxy?url="+url.QueryEscape(raw), nil)
		rec := httptest.NewRecorder()
		handlePluginProxy(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: status %d: %s", path, rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Content-Disposition"); got != "attachment" {
			t.Errorf("%s: Content-Disposition = %q, want attachment", path, got)
		}
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: X-Content-Type-Options = %q, want nosniff", path, got)
		}
	}
	if _, ok := pluginProxyCached("pp:" + raw); !ok {
		t.Fatal("the second request did not come from the cache, so only one path was covered")
	}
}

// Placeholders have always belonged in the query - values are query-escaped,
// which is the wrong escaping anywhere else - but the substitution ran over
// the whole url string. A secret spliced into the PATH is not escaped for one
// (QueryEscape leaves '/' alone), so it could steer the request elsewhere on
// the allowlisted host and land the key in that host's own logs.
func TestPluginProxyRefusesSecretPlaceholderOutsideTheQuery(t *testing.T) {
	secrets := map[string]pluginSecret{"KEY": {value: "s3cret"}}
	for _, raw := range []string{
		"https://allowed.host/v1/{{secret:key}}/data",
		"https://allowed.host/x#{{secret:key}}",
	} {
		if out, err := substituteSecrets(raw, secrets, "allowed.host"); !errors.Is(err, errSecretOutsideQuery) {
			t.Errorf("%s: got %q, %v; want errSecretOutsideQuery", raw, out, err)
		}
	}

	resetRateLimiter(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "allowed.host")
	t.Setenv("PLUGIN_PROXY_SECRETS", "KEY@allowed.host/v1/?key=s3cret")
	req := httptest.NewRequest(http.MethodGet,
		"/plugin-proxy?url="+url.QueryEscape("https://allowed.host/v1/{{secret:key}}/data"), nil)
	rec := httptest.NewRecorder()
	handlePluginProxy(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("a placeholder in the path got %d, want 400: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Error("the refusal echoed the secret")
	}
}

// NAME@host?param=value binds a secret to a host and a parameter, on any
// path: exactly NAME@host/?param=value.
func TestSecretWithoutAPathPrefix(t *testing.T) {
	t.Setenv("PLUGIN_PROXY_SECRETS", "STEAM@api.steampowered.com?key=k&y 1, SLASH@api.steampowered.com/?key=k&y 1")
	secrets := pluginProxySecrets()
	plain, slash := secrets["STEAM"], secrets["SLASH"]
	if plain.legacy || plain.host != "api.steampowered.com" || plain.path != "/" || plain.param != "key" || plain.value != "k&y 1" {
		t.Fatalf("no-path form parsed wrong: %+v", plain)
	}
	if plain.host != slash.host || plain.path != slash.path || plain.param != slash.param {
		t.Fatalf("NAME@host?p differs from NAME@host/?p: %+v vs %+v", plain, slash)
	}

	const host = "api.steampowered.com"
	// Filled on any path of that host, in that parameter.
	for _, raw := range []string{
		"https://api.steampowered.com?key={{secret:steam}}",
		"https://api.steampowered.com/?key={{secret:steam}}",
		"https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key={{secret:steam}}&steamids=7",
		"https://api.steampowered.com/IPlayerService/GetOwnedGames/v1?format=json&key={{secret:steam}}",
	} {
		out, err := substituteSecrets(raw, secrets, host)
		if err != nil {
			t.Errorf("%s: %v", raw, err)
			continue
		}
		if !strings.Contains(out, "key=k%26y+1") || strings.Contains(out, "{{secret:") {
			t.Errorf("%s: not filled: %q", raw, out)
		}
	}
	// Never on another host, and only as the whole value of that parameter.
	for name, c := range map[string]struct{ raw, host string }{
		"another host":         {"https://evil.example/?key={{secret:steam}}", "evil.example"},
		"another parameter":    {"https://api.steampowered.com/x?callback={{secret:steam}}", host},
		"glued to a value":     {"https://api.steampowered.com/x?key=echo{{secret:steam}}", host},
		"value then more text": {"https://api.steampowered.com/x?key={{secret:steam}}tail", host},
		"as a parameter name":  {"https://api.steampowered.com/x?{{secret:steam}}=1", host},
		"a path that climbs":   {"https://api.steampowered.com/a/../b?key={{secret:steam}}", host},
	} {
		if out, err := substituteSecrets(c.raw, secrets, c.host); err == nil {
			t.Errorf("%s: substituted into %q", name, out)
		}
	}
}
