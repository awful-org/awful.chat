package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeOgUpstream stands in for the pages previews are fetched from, counting
// fetches. A nil release lets every fetch through at once.
type fakeOgUpstream struct {
	fetches atomic.Int32
	release chan struct{}
	fail    bool
}

func (f *fakeOgUpstream) install(t *testing.T) {
	t.Helper()
	saved := ogFetchPage
	ogFetchPage = func(target *url.URL) (string, string) {
		f.fetches.Add(1)
		if f.release != nil {
			<-f.release
		}
		if f.fail {
			return "", target.String()
		}
		return `<html><head><meta property="og:title" content="A page"></head></html>`, target.String()
	}
	t.Cleanup(func() { ogFetchPage = saved })
}

// resetOgCache empties the preview cache, so each test starts cold.
func resetOgCache(t *testing.T) {
	t.Helper()
	ogCacheMu.Lock()
	defer ogCacheMu.Unlock()
	ogCache = map[string]ogCacheEntry{}
	ogCacheOrder = nil
	ogCacheBytes = 0
	ogInflight = map[string]*ogCall{}
}

func ogRequest(t *testing.T, addr, target string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/og/preview?url="+url.QueryEscape(target), nil)
	req.RemoteAddr = addr + ":5000"
	w := httptest.NewRecorder()
	handleOgPreview(w, req)
	return w
}

// A link drawn in every member's view, or again on every room open, was a
// full upstream fetch each time. Asks for the same url while one fetch runs
// now share it, later ones are answered from memory, and the answer tells
// the browser it may keep it.
func TestOgPreviewIsFetchedOnceForEveryone(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{release: make(chan struct{})}
	up.install(t)
	const link = "https://example.com/article"

	var wg sync.WaitGroup
	codes := make([]int, 20)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = ogRequest(t, "198.51.100."+strconv.Itoa(i+1), link).Code
		}(i)
	}
	// Let every ask arrive before the one fetch finishes.
	deadline := time.Now().Add(2 * time.Second)
	for up.fetches.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(up.release)
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("viewer %d got %d", i, c)
		}
	}
	if n := up.fetches.Load(); n != 1 {
		t.Fatalf("20 viewers of one link cost %d upstream fetches, want 1", n)
	}

	w := ogRequest(t, "198.51.100.99", link)
	if w.Code != http.StatusOK || up.fetches.Load() != 1 {
		t.Fatalf("a later ask got %d after %d fetches, want 200 from memory", w.Code, up.fetches.Load())
	}
	var preview OgPreview
	if err := json.Unmarshal(w.Body.Bytes(), &preview); err != nil || preview.Title == nil || *preview.Title != "A page" {
		t.Fatalf("cached answer is not the preview: %s", w.Body.String())
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=3600") {
		t.Fatalf("Cache-Control %q, want the browser allowed to keep it for the hour", cc)
	}

	// Another link is its own fetch.
	if w := ogRequest(t, "198.51.100.99", "https://example.com/other"); w.Code != http.StatusOK || up.fetches.Load() != 2 {
		t.Fatalf("a second link: %d after %d fetches", w.Code, up.fetches.Load())
	}
}

// Ten previews a minute from one address used to be ten upstream fetches;
// opening a room with a dozen links degraded the newest to bare domains.
// Only an ask that really fetches spends the budget now.
func TestOgPreviewCacheHitsAreNotRateLimited(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{}
	up.install(t)
	const addr = "203.0.113.20"

	for i := 0; i < pluginProxyRateLimit*3; i++ {
		if w := ogRequest(t, addr, "https://example.com/same"); w.Code != http.StatusOK {
			t.Fatalf("ask %d for one link: %d", i, w.Code)
		}
	}
	// The budget is spent only by fetches: nine more distinct links fit,
	// the one after does not.
	for i := 0; i < pluginProxyRateLimit-1; i++ {
		if w := ogRequest(t, addr, "https://example.com/p"+strconv.Itoa(i)); w.Code != http.StatusOK {
			t.Fatalf("distinct link %d: %d", i, w.Code)
		}
	}
	if w := ogRequest(t, addr, "https://example.com/one-too-many"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("a fetch past the budget got %d, want 429", w.Code)
	}
	if w := ogRequest(t, addr, "https://example.com/same"); w.Code != http.StatusOK {
		t.Fatalf("a cached link after the budget ran out: %d", w.Code)
	}
}

// A dead link was fetched again for every viewer. A failure is remembered
// for a few minutes, and then tried again.
func TestOgPreviewFailureIsRememberedBriefly(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{fail: true}
	up.install(t)
	const link = "https://example.com/gone"

	for i := 0; i < 3; i++ {
		w := ogRequest(t, "198.51.100.50", link)
		if w.Code != http.StatusBadGateway {
			t.Fatalf("ask %d for a dead link: %d", i, w.Code)
		}
		if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "max-age=300") {
			t.Fatalf("a failure's Cache-Control is %q", cc)
		}
	}
	if n := up.fetches.Load(); n != 1 {
		t.Fatalf("a dead link was fetched %d times, want 1", n)
	}
	ogCacheMu.Lock()
	e := ogCache[mustURL(t, link).String()]
	e.expires = time.Now().Add(-time.Second)
	ogCache[mustURL(t, link).String()] = e
	ogCacheMu.Unlock()
	up.fail = false
	if w := ogRequest(t, "198.51.100.50", link); w.Code != http.StatusOK || up.fetches.Load() != 2 {
		t.Fatalf("after the failure lapsed: %d after %d fetches", w.Code, up.fetches.Load())
	}
}

// The urls are the caller's choice, and so are the pages behind them, so the
// cache is bounded on entries and on bytes - every url's as well as every
// answer's - whatever anyone asks for.
func TestOgPreviewCacheIsBounded(t *testing.T) {
	resetOgCache(t)
	ogCacheMu.Lock()
	defer ogCacheMu.Unlock()
	now := time.Now()
	for i := 0; i < ogCacheMaxEntries+500; i++ {
		// Urls from short to the longest kept, and answers from none (a
		// failure) to large.
		key := "https://example.com/" + strconv.Itoa(i) + "?" + strings.Repeat("k", (i*509)%(ogCacheMaxKeyBytes-64))
		var body []byte
		if i%3 != 0 {
			body = make([]byte, (i*7919)%(64<<10))
		}
		ogCacheStoreLocked(key, body, now)

		held := 0
		for k, e := range ogCache {
			held += len(k) + len(e.body)
		}
		if held != ogCacheBytes {
			t.Fatalf("store %d: the cache holds %d bytes of urls and answers but counts %d", i, held, ogCacheBytes)
		}
		if held > ogCacheMaxBytes || len(ogCache) > ogCacheMaxEntries || len(ogCacheOrder) != len(ogCache) {
			t.Fatalf("store %d: %d entries (%d in order) holding %d bytes, caps %d and %d",
				i, len(ogCache), len(ogCacheOrder), held, ogCacheMaxEntries, ogCacheMaxBytes)
		}
	}
	// A url past its share is not kept at all.
	long := "https://example.com/long?" + strings.Repeat("k", ogCacheMaxKeyBytes)
	ogCacheStoreLocked(long, []byte("{}"), now)
	if _, ok := ogCache[long]; ok {
		t.Fatalf("a %d-byte url was kept, longest kept is %d", len(long), ogCacheMaxKeyBytes)
	}
}

// A failure is kept with nothing but its url, and the relay reads request
// lines of up to a megabyte, so a cache that counted only answers held a
// thousand made-up urls - a gigabyte - inside its 8 MiB. A url longer than
// its share is now fetched for each ask, charged to it, and never kept.
func TestOgPreviewLongURLsAreNeitherKeptNorShared(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{fail: true}
	up.install(t)

	pad := strings.Repeat("a", 64<<10)
	for i := 0; i < 100; i++ {
		resetRateLimiter(t) // stands in for a few addresses, or a few minutes
		if w := ogRequest(t, "198.51.100.1", "https://attacker.example/"+strconv.Itoa(i)+"?"+pad); w.Code != http.StatusBadGateway {
			t.Fatalf("ask %d: %d", i, w.Code)
		}
	}
	ogCacheMu.Lock()
	entries, held, inflight := len(ogCache), ogCacheBytes, len(ogInflight)
	ogCacheMu.Unlock()
	if entries != 0 || held != 0 || inflight != 0 {
		t.Fatalf("100 failed asks for 64 KiB urls left %d entries and %d bytes in the cache, %d in flight", entries, held, inflight)
	}

	// The same long link asked again is fetched again, and each ask spends
	// its address's budget.
	resetRateLimiter(t)
	up.fail = false
	link := "https://example.com/long?" + pad
	before := up.fetches.Load()
	for i := 0; i < pluginProxyRateLimit; i++ {
		if w := ogRequest(t, "203.0.113.30", link); w.Code != http.StatusOK {
			t.Fatalf("ask %d for a long link: %d", i, w.Code)
		}
	}
	if n := up.fetches.Load() - before; n != pluginProxyRateLimit {
		t.Fatalf("%d asks for one long link cost %d fetches, want one each", pluginProxyRateLimit, n)
	}
	if w := ogRequest(t, "203.0.113.30", link); w.Code != http.StatusTooManyRequests {
		t.Fatalf("an ask past the budget for a long link got %d, want 429", w.Code)
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
