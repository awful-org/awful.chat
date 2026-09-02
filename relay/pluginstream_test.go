package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

// pluginProxySafeDial refuses loopback by design, so an httptest upstream is
// unreachable through the shared transport. A TLS test server's own client
// transport dials it and trusts its certificate, which lets these tests drive
// the real handler over a real https url; the SSRF dialer itself is covered
// by og's tests.
func streamUpstream(t *testing.T, h http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewTLSServer(h)
	prev := pluginStreamTransport
	pluginStreamTransport = srv.Client().Transport
	t.Cleanup(func() {
		pluginStreamTransport = prev
		srv.Close()
	})
	// The server listens on 127.0.0.1, so that is the hostname the handler
	// checks the allowlist for.
	t.Setenv("PLUGIN_PROXY_HOSTS", "127.0.0.1")
	return srv
}

func resetStreamSlots(t *testing.T) {
	t.Helper()
	pluginStreamMu.Lock()
	defer pluginStreamMu.Unlock()
	pluginStreamPerIP = map[string]int{}
	pluginStreamOpen = 0
}

func streamRequest(rawurl string) *http.Request {
	return httptest.NewRequest(http.MethodGet, "/plugin-stream?url="+url.QueryEscape(rawurl), nil)
}

// A ranged request is the whole point of this path: hls.js seeks with Range
// and the 206 plus Content-Range have to survive the hop, or the player sees
// a full-object answer to a partial request.
func TestPluginStreamPassesRangeThrough(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)

	var gotRange string
	var gotCookie string
	srv := streamUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		gotRange = r.Header.Get("Range")
		gotCookie = r.Header.Get("Cookie")
		w.Header().Set("Content-Type", "video/mp2t")
		w.Header().Set("Content-Range", "bytes 0-3/64")
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Cache-Control", "public, max-age=31536000")
		w.Header().Set("ETag", `"abc"`)
		w.WriteHeader(http.StatusPartialContent)
		w.Write([]byte("SEG!"))
	})

	req := streamRequest(srv.URL + "/seg.ts")
	req.Header.Set("Range", "bytes=0-3")
	req.Header.Set("Cookie", "session=nope")
	rec := httptest.NewRecorder()
	handlePluginStream(rec, req)

	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status %d, want 206: %s", rec.Code, rec.Body.String())
	}
	if gotRange != "bytes=0-3" {
		t.Errorf("upstream saw Range %q, want %q", gotRange, "bytes=0-3")
	}
	// Range is the only client header that may travel.
	if gotCookie != "" {
		t.Errorf("client Cookie reached the upstream: %q", gotCookie)
	}
	for h, want := range map[string]string{
		"Content-Range":          "bytes 0-3/64",
		"Content-Type":           "video/mp2t",
		"Accept-Ranges":          "bytes",
		"Cache-Control":          "public, max-age=31536000",
		"ETag":                   `"abc"`,
		"X-Content-Type-Options": "nosniff",
		// A tab opened straight at this endpoint sends no Origin, which is
		// allowed, so an allowlisted host's HTML must be forced to download
		// rather than render on the relay's origin.
		"Content-Disposition": "attachment",
	} {
		if got := rec.Header().Get(h); got != want {
			t.Errorf("%s = %q, want %q", h, got, want)
		}
	}
	if rec.Header().Get("Access-Control-Allow-Origin") == "" {
		t.Error("response is missing CORS headers")
	}
	if rec.Body.String() != "SEG!" {
		t.Errorf("body %q", rec.Body.String())
	}
}

// Anything that is not 200, 206, 404 or 416 is the relay's own 502, never the
// upstream's status and body handed to the page.
func TestPluginStreamRefusesUpstreamError(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	srv := streamUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	})
	rec := httptest.NewRecorder()
	handlePluginStream(rec, streamRequest(srv.URL+"/broken.ts"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502: %s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() == "boom\n" {
		t.Error("the upstream's own body was handed to the page")
	}
}

// 404 and 416 describe the object, not the hop. hls.js has to be able to tell
// a missing segment or an unsatisfiable range from a relay that is broken, so
// those two travel as themselves with an empty body.
func TestPluginStreamPassesNotFoundAndRangeNotSatisfiable(t *testing.T) {
	for _, tc := range []struct {
		name        string
		status      int
		rangeHeader string
	}{
		{"404", http.StatusNotFound, ""},
		{"416", http.StatusRequestedRangeNotSatisfiable, "bytes */64"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resetRateLimiter(t)
			resetStreamSlots(t)
			srv := streamUpstream(t, func(w http.ResponseWriter, r *http.Request) {
				if tc.rangeHeader != "" {
					w.Header().Set("Content-Range", tc.rangeHeader)
				}
				w.WriteHeader(tc.status)
				w.Write([]byte("upstream body"))
			})
			rec := httptest.NewRecorder()
			handlePluginStream(rec, streamRequest(srv.URL+"/seg.ts"))

			if rec.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", rec.Code, tc.status, rec.Body.String())
			}
			if rec.Body.Len() != 0 {
				t.Errorf("body %q, want empty", rec.Body.String())
			}
			if rec.Header().Get("Access-Control-Allow-Origin") == "" {
				t.Error("response is missing CORS headers")
			}
			if got := rec.Header().Get("Content-Range"); got != tc.rangeHeader {
				t.Errorf("Content-Range = %q, want %q", got, tc.rangeHeader)
			}
		})
	}
}

// The allowlist is checked once before the request goes out, so the redirect
// hook is the only thing standing between an allowlisted host and any origin
// it feels like naming.
func TestPluginStreamRefusesRedirectOffTheAllowlist(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	srv := streamUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example/x", http.StatusFound)
	})
	rec := httptest.NewRecorder()
	handlePluginStream(rec, streamRequest(srv.URL+"/master.m3u8"))
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502: %s", rec.Code, rec.Body.String())
	}
}

func TestPluginStreamRefusesUnallowlistedHost(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "allowed.host")
	rec := httptest.NewRecorder()
	handlePluginStream(rec, streamRequest("https://evil.example/master.m3u8"))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d, want 403: %s", rec.Code, rec.Body.String())
	}
}

// Secrets stay on the buffered path. A streamed url is handed to a player
// that fetches playlist-relative urls of its own, so a substituted key would
// travel in urls the relay never composed.
func TestPluginStreamRefusesSecretPlaceholders(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "allowed.host")
	rec := httptest.NewRecorder()
	handlePluginStream(rec, streamRequest("https://allowed.host/v.m3u8?key={{secret:NAME}}"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status %d, want 400: %s", rec.Code, rec.Body.String())
	}
}

func TestPluginStreamRefusesUserinfoAndNonHTTPS(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "allowed.host")
	for _, raw := range []string{
		"https://u:p@allowed.host/v.m3u8",
		"http://allowed.host/v.m3u8",
	} {
		rec := httptest.NewRecorder()
		handlePluginStream(rec, streamRequest(raw))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", raw, rec.Code)
		}
	}
}

// An instance with no allowlist answers 204, the same "not configured here"
// signal /plugin-proxy gives, so a plugin can say so instead of erroring.
func TestPluginStreamUnconfiguredAnswers204(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)
	t.Setenv("PLUGIN_PROXY_HOSTS", "")
	rec := httptest.NewRecorder()
	handlePluginStream(rec, streamRequest("https://allowed.host/v.m3u8"))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
}

// The rate limiter counts requests started, not what is still open, so
// without this ceiling one client could hold arbitrarily many transfers at
// once and pay for none of them.
func TestPluginStreamPerClientConcurrencyCap(t *testing.T) {
	resetRateLimiter(t)
	resetStreamSlots(t)

	release := make(chan struct{})
	arrived := make(chan struct{}, pluginStreamPerClient)
	srv := streamUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		arrived <- struct{}{}
		<-release
		w.Write([]byte("x"))
	})

	var wg sync.WaitGroup
	for i := 0; i < pluginStreamPerClient; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := streamRequest(fmt.Sprintf("%s/seg%d.ts", srv.URL, i))
			req.RemoteAddr = "203.0.113.77:1234"
			handlePluginStream(httptest.NewRecorder(), req)
		}(i)
	}
	// All slots are held once every request is inside the upstream handler.
	for i := 0; i < pluginStreamPerClient; i++ {
		<-arrived
	}

	req := streamRequest(srv.URL + "/one-too-many.ts")
	req.RemoteAddr = "203.0.113.77:1234"
	rec := httptest.NewRecorder()
	handlePluginStream(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("saturated client got %d, want 503: %s", rec.Code, rec.Body.String())
	}

	// A different client must not be caught by the first one's slots.
	if !pluginStreamAcquire("203.0.113.78") {
		t.Error("another client was refused by the first client's slots")
	} else {
		pluginStreamRelease("203.0.113.78")
	}

	close(release)
	wg.Wait()

	// Slots have to come back, or the endpoint wedges after one burst, and
	// the per-IP map has to shed spent keys or it grows forever.
	pluginStreamMu.Lock()
	open, entries := pluginStreamOpen, len(pluginStreamPerIP)
	pluginStreamMu.Unlock()
	if open != 0 || entries != 0 {
		t.Fatalf("slots leaked: open=%d entries=%d", open, entries)
	}
}

func TestPluginStreamRateLimitHasItsOwnBucket(t *testing.T) {
	resetRateLimiter(t)
	ip := "203.0.113.40"
	for i := 0; i < pluginStreamRateLimit; i++ {
		if !rateAllow("ps:"+ip, pluginStreamRateLimit) {
			t.Fatalf("request %d refused inside the window", i)
		}
	}
	if rateAllow("ps:"+ip, pluginStreamRateLimit) {
		t.Error("request over the limit allowed")
	}
	// Draining the stream bucket must not spend the buffered proxy's.
	if !pluginProxyAllow(ip) {
		t.Error("the buffered proxy's budget was spent by the stream path")
	}
}
