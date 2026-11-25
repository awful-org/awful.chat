package main

import (
	"context"
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
	ogFetchPage = func(_ context.Context, candidate string) (ogPage, bool) {
		f.fetches.Add(1)
		if f.release != nil {
			<-f.release
		}
		if f.fail {
			return ogPage{}, false
		}
		return ogPage{url: candidate, html: `<html><head><meta property="og:title" content="A page"></head></html>`}, true
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

// Only an ask that really fetches spends the budget, and one refused for want
// of it says when there will be some.
func TestOgPreviewCacheHitsAreNotRateLimited(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{}
	up.install(t)
	const addr = "203.0.113.20"

	for i := 0; i < ogRateLimit*3; i++ {
		if w := ogRequest(t, addr, "https://example.com/same"); w.Code != http.StatusOK {
			t.Fatalf("ask %d for one link: %d", i, w.Code)
		}
	}
	// The budget is spent only by fetches: one fewer than it distinct links
	// fit, the one after does not.
	for i := 0; i < ogRateLimit-1; i++ {
		if w := ogRequest(t, addr, "https://example.com/p"+strconv.Itoa(i)); w.Code != http.StatusOK {
			t.Fatalf("distinct link %d: %d", i, w.Code)
		}
	}
	w := ogRequest(t, addr, "https://example.com/one-too-many")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("a fetch past the budget got %d, want 429", w.Code)
	}
	// The wait it names is the window's real end, and asking again after it
	// works.
	wait, err := strconv.Atoi(w.Header().Get("Retry-After"))
	if err != nil || wait < 1 || wait > int(pluginProxyRateWindow/time.Second)+1 {
		t.Fatalf("Retry-After %q", w.Header().Get("Retry-After"))
	}
	rateMu.Lock()
	for k, e := range rateBy {
		if time.Until(e.resetAt) > time.Duration(wait)*time.Second {
			t.Errorf("the window %s outlasts Retry-After %d", k, wait)
		}
		e.resetAt = e.resetAt.Add(-time.Duration(wait) * time.Second)
		rateBy[k] = e
	}
	rateMu.Unlock()
	if w := ogRequest(t, addr, "https://example.com/one-too-many"); w.Code != http.StatusOK {
		t.Fatalf("asked again after Retry-After: %d", w.Code)
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
	for i := 0; i < ogRateLimit; i++ {
		if w := ogRequest(t, "203.0.113.30", link); w.Code != http.StatusOK {
			t.Fatalf("ask %d for a long link: %d", i, w.Code)
		}
	}
	if n := up.fetches.Load() - before; n != ogRateLimit {
		t.Fatalf("%d asks for one long link cost %d fetches, want one each", ogRateLimit, n)
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

// An answer too long to keep pushed every other preview out of the cache on
// its way to being dropped itself.
func TestOgPreviewLongAnswerDoesNotEmptyTheCache(t *testing.T) {
	resetOgCache(t)
	ogCacheMu.Lock()
	defer ogCacheMu.Unlock()
	now := time.Now()
	ogCacheStoreLocked("https://example.com/a", []byte("{}"), now)
	ogCacheStoreLocked("https://example.com/b", make([]byte, ogCacheMaxBytes+1), now)
	ogCacheStoreLocked("https://example.com/c", make([]byte, ogCacheMaxBodyBytes+1), now)
	if len(ogCache) != 1 || ogCache["https://example.com/a"].body == nil {
		t.Fatalf("%d entries left, want the one that fits", len(ogCache))
	}
}

// However many links are asked for, so many are fetched at once. One that
// never got its turn is answered as busy, and not remembered as dead.
func TestOgPreviewBoundsFetchesAtOnce(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{release: make(chan struct{})}
	up.install(t)
	var wg sync.WaitGroup
	codes := make([]int, ogMaxFetches*2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			codes[i] = ogRequest(t, "198.51.100."+strconv.Itoa(i+1), "https://example.com/"+strconv.Itoa(i)).Code
		}(i)
	}
	deadline := time.Now().Add(2 * time.Second)
	for up.fetches.Load() < ogMaxFetches && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	if n := up.fetches.Load(); n != ogMaxFetches {
		t.Fatalf("%d fetches at once, want %d", n, ogMaxFetches)
	}
	close(up.release)
	wg.Wait()
	for i, c := range codes {
		if c != http.StatusOK {
			t.Fatalf("link %d: %d", i, c)
		}
	}
	if len(ogFetchSlots) != 0 || len(ogParseSlots) != 0 {
		t.Fatalf("slots still held: %d and %d", len(ogFetchSlots), len(ogParseSlots))
	}

	if len(ogClients) != 0 {
		t.Fatalf("%d clients still kept", len(ogClients))
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	full := make(chan struct{}, 1)
	full <- struct{}{}
	if ogTake(ctx, full) {
		t.Fatal("took a slot that was not free")
	}
}

// One client's slow links leave slots for everybody else's.
func TestOgPreviewLeavesRoomForOtherClients(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{release: make(chan struct{})}
	up.install(t)
	var wg sync.WaitGroup
	ask := func(addr string, n int) {
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				ogRequest(t, addr, "https://"+addr+".example/"+strconv.Itoa(i))
			}(i)
		}
	}
	reached := func(n int32) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for up.fetches.Load() < n && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond)
		if got := up.fetches.Load(); got != n {
			t.Fatalf("%d fetches under way, want %d", got, n)
		}
	}
	ask("198.51.100.1", ogRateLimit)
	reached(ogMaxClientFetches)
	ask("198.51.100.2", 1)
	reached(ogMaxClientFetches + 1)
	close(up.release)
	wg.Wait()
}

// A link whose turn never came is busy, and is tried afresh when asked again.
func TestOgPreviewBusyIsNotRemembered(t *testing.T) {
	resetRateLimiter(t)
	resetOgCache(t)
	up := &fakeOgUpstream{}
	up.install(t)
	saved := ogFetchSlots
	ogFetchSlots = make(chan struct{}) // none, ever
	w := ogRequest(t, "198.51.100.3", "https://example.com/busy")
	ogFetchSlots = saved
	if w.Code != http.StatusServiceUnavailable || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%d, Cache-Control %q", w.Code, w.Header().Get("Cache-Control"))
	}
	if len(ogCache) != 0 || len(ogClients) != 0 || up.fetches.Load() != 0 {
		t.Fatalf("%d cached, %d clients, %d fetches", len(ogCache), len(ogClients), up.fetches.Load())
	}
	if w := ogRequest(t, "198.51.100.3", "https://example.com/busy"); w.Code != http.StatusOK {
		t.Fatalf("asked again: %d", w.Code)
	}
}
