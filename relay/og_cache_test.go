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

// The urls are the caller's choice, so the cache is bounded on entries and
// bytes whatever anyone asks for.
func TestOgPreviewCacheIsBounded(t *testing.T) {
	resetOgCache(t)
	ogCacheMu.Lock()
	defer ogCacheMu.Unlock()
	big := make([]byte, 64<<10)
	for i := 0; i < ogCacheMaxEntries+500; i++ {
		ogCacheStoreLocked("https://example.com/"+strconv.Itoa(i), big, time.Now())
	}
	if len(ogCache) > ogCacheMaxEntries || len(ogCacheOrder) != len(ogCache) {
		t.Fatalf("cache holds %d entries (%d in order), cap %d", len(ogCache), len(ogCacheOrder), ogCacheMaxEntries)
	}
	if ogCacheBytes > ogCacheMaxBytes {
		t.Fatalf("cache holds %d bytes, cap %d", ogCacheBytes, ogCacheMaxBytes)
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
