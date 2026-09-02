package main

// Streaming sibling of /plugin-proxy, for plugins that play media from an
// allowlisted host whose CDN pins CORS to its own origin. The buffered proxy
// cannot carry that traffic and should not try: it reads whole bodies into
// memory, caps them at 2 MB, caches for five minutes and spends a 10/min
// budget, so an HLS player asking for one segment every few seconds starves
// inside the first minute and a single segment blows the cap.
//
// GET /plugin-stream?url=<https url> - same PLUGIN_PROXY_HOSTS allowlist,
// same SSRF-safe dialer, no relay-side cache (the upstream's own
// Cache-Control is what lets the browser cache segments), Range forwarded so
// byte-range requests stay byte-range requests. Bounded by a body cap, a
// per-IP and a global concurrency ceiling, and its own rate-limit bucket.
//
// No secrets on this path. A media url is handed to a player that then
// fetches playlist-relative urls of its own, all of them back through here,
// so a substituted key would end up in urls this relay never composed.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const pluginStreamMaxBody = 64 << 20 // 64 MB, an HLS segment is orders below this
const pluginStreamPerClient = 8

// IPv6 clients are bucketed per /64 and one residential /56 owns 256 of those
// buckets, so the global ceiling has to sit well above 32 x per-client or a
// single household can close the endpoint for everyone else.
const pluginStreamGlobal = 1024

// hls.js fetches a segment every ~10s per quality level and bursts on seek,
// so the proxy's 10/min would stall playback within the first minute.
const pluginStreamRateLimit = 240

// Bounds the whole exchange including the body. Client.Timeout is deliberately
// NOT used: it covers the body read too, and a large segment on a slow link is
// a legitimate long transfer, not a hung upstream.
const pluginStreamTimeout = 120 * time.Second

// The Transport is the process-wide one /plugin-proxy already uses, for the
// reason documented there (a per-request Transport leaks goroutines and
// sockets). It is a var only so tests can dial an httptest server, which
// pluginProxySafeDial refuses by design because it is on loopback.
var pluginStreamTransport http.RoundTripper = pluginProxyTransport

// Concurrency ceilings. The rate limiter counts requests started, which says
// nothing about how many are still open: 240 quick segment fetches and 240
// simultaneous 64 MB transfers spend the same budget. These bound what is in
// flight. Both are checked under one lock so N arriving at once cannot each
// read the same stale count and all pass.
var (
	pluginStreamMu    sync.Mutex
	pluginStreamPerIP = map[string]int{}
	pluginStreamOpen  int
)

func pluginStreamAcquire(ip string) bool {
	pluginStreamMu.Lock()
	defer pluginStreamMu.Unlock()
	if pluginStreamOpen >= pluginStreamGlobal || pluginStreamPerIP[ip] >= pluginStreamPerClient {
		return false
	}
	pluginStreamPerIP[ip]++
	pluginStreamOpen++
	return true
}

func pluginStreamRelease(ip string) {
	pluginStreamMu.Lock()
	defer pluginStreamMu.Unlock()
	if pluginStreamOpen > 0 {
		pluginStreamOpen--
	}
	// Deleting at zero matters: the key space is client IPs, so keeping
	// spent entries would grow this map for the life of the process.
	if n := pluginStreamPerIP[ip] - 1; n > 0 {
		pluginStreamPerIP[ip] = n
	} else {
		delete(pluginStreamPerIP, ip)
	}
}

func pluginStreamClient(allowed map[string]bool) *http.Client {
	return &http.Client{
		Transport: pluginStreamTransport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Go copies the previous url into Referer before this runs.
			// Nothing on this path carries a secret, but handing an upstream
			// the exact url a plugin asked for is still gratuitous.
			req.Header.Del("Referer")
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			if req.URL.Scheme != "https" || !allowed[strings.ToLower(req.URL.Hostname())] {
				return fmt.Errorf("redirect outside the allowlist: %s", req.URL.Host)
			}
			return nil
		},
	}
}

// Headers worth passing back: enough for a player to seek and for a browser
// to cache, and nothing that describes the relay or the upstream's session.
var pluginStreamPassthrough = []string{
	"Content-Type",
	"Content-Length",
	"Content-Range",
	"Accept-Ranges",
	"Cache-Control",
	"ETag",
	"Last-Modified",
}

func handlePluginStream(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	allowed := pluginProxyHosts()
	if len(allowed) == 0 {
		// Same "not configured on this instance" answer /plugin-proxy gives,
		// so a plugin can say so in its card instead of showing an error.
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	ip := clientIP(r)
	// Its own bucket, so a plugin streaming video cannot drain the budget the
	// buffered proxy hands out.
	if !rateAllow("ps:"+ip, pluginStreamRateLimit) {
		apiError(w, r, "Slow down", http.StatusTooManyRequests)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}
	if strings.Contains(raw, "{{secret:") {
		apiError(w, r, "Secrets are not available on the streaming path", http.StatusBadRequest)
		return
	}
	target, err := url.Parse(raw)
	if err != nil || target.Scheme != "https" {
		apiError(w, r, "Only https urls", http.StatusBadRequest)
		return
	}
	// https://u:p@allowed.host/x otherwise reaches Go's http.Client unchanged,
	// which turns it into an Authorization header the caller chose.
	if target.User != nil {
		apiError(w, r, "url must not contain userinfo", http.StatusBadRequest)
		return
	}
	if !allowed[strings.ToLower(target.Hostname())] {
		apiError(w, r, "Host not allowlisted on this instance", http.StatusForbidden)
		return
	}

	if !pluginStreamAcquire(ip) {
		apiError(w, r, "Busy", http.StatusServiceUnavailable)
		return
	}
	defer pluginStreamRelease(ip)

	ctx, cancel := context.WithTimeout(r.Context(), pluginStreamTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
	if err != nil {
		apiError(w, r, "Bad url", http.StatusBadRequest)
		return
	}
	// Range is the ONE client header forwarded. Dropping it turns every seek
	// into a full-object fetch; forwarding anything else would let a caller
	// smuggle its own cookies or credentials to an allowlisted host.
	if rng := r.Header.Get("Range"); rng != "" {
		req.Header.Set("Range", rng)
	}
	resp, err := pluginStreamClient(allowed).Do(req)
	if err != nil {
		apiError(w, r, "Upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	// 206 is the normal answer to a forwarded Range, so both are success here.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		// 404 and 416 are answers about the object, not about the relay, and
		// hls.js reacts to them differently than to a broken hop: a missing
		// segment or an unsatisfiable range is not a reason to fall back off
		// the proxy. Pass those two through with an empty body, still under
		// the relay's own CORS. Everything else is a 502.
		if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			for k, vals := range corsHeaders(r) {
				for _, v := range vals {
					w.Header().Add(k, v)
				}
			}
			// 416 carries the object's size in Content-Range, which is how a
			// player learns what range it should have asked for.
			if v := resp.Header.Get("Content-Range"); v != "" {
				w.Header().Set("Content-Range", v)
			}
			w.Header().Set("Content-Disposition", "attachment")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.WriteHeader(resp.StatusCode)
			return
		}
		apiError(w, r, fmt.Sprintf("Upstream answered %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	// The API server sets a 15s WriteTimeout, right for the short JSON
	// handlers around this one and fatal here: it would cut every transfer
	// that outlives it mid-segment. Give this response the request's own
	// budget instead. The error is ignored on purpose, a ResponseWriter that
	// does not support deadlines (httptest's recorder) simply keeps the
	// server default.
	//
	// This only reaches the real connection because main.go hands the bare mux
	// to http.Server as its Handler: a wrapper without an Unwrap() method
	// hides the underlying writer and silently reverts every transfer to the
	// 15s WriteTimeout.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(pluginStreamTimeout))

	for k, vals := range corsHeaders(r) {
		for _, v := range vals {
			w.Header().Add(k, v)
		}
	}
	for _, h := range pluginStreamPassthrough {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	// A top-level navigation carries no Origin and the empty Origin is allowed
	// by design here, so this endpoint can be opened straight in a tab. An
	// allowlisted host's HTML must never render as a document on the relay's
	// own origin, and this is what stops it. XHR and hls.js ignore the header
	// entirely, so nothing on the real path notices.
	w.Header().Set("Content-Disposition", "attachment")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(resp.StatusCode)
	// A body over the cap is cut here rather than buffered and rejected: the
	// point of this path is that nothing is held in memory. The upstream's
	// Content-Length then disagrees with what was written, which is what
	// tells the client it got a truncated object rather than a short one.
	io.Copy(w, io.LimitReader(resp.Body, pluginStreamMaxBody))
}
