package main

// Generic outbound proxy for plugins. This is what keeps "plugin = a folder
// plus env, redeploy" true for plugins that need an external API: without it,
// every such plugin needed bespoke relay code (the /steam endpoint was the
// proof), which kills the model. Operator-controlled on both axes:
//
//   PLUGIN_PROXY_HOSTS    comma list of exact hostnames plugins may reach
//   PLUGIN_PROXY_SECRETS  comma list of NAME=value; a request url may carry
//                         {{secret:NAME}} placeholders, substituted
//                         server-side so keys never reach clients
//
// GET /plugin-proxy?url=<https url> - the host must be allowlisted, the
// scheme https, redirects stay inside the allowlist, private/loopback IPs
// are refused at dial time (same SSRF stance as /og), responses are capped
// and briefly cached.

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

const pluginProxyMaxBody = 2 << 20 // 2 MB
const pluginProxyCacheTTL = 5 * time.Minute

// Small response cache: upstream APIs rate limit, and a room of people
// loading the same card should cost one upstream call. Bounded on BOTH axes
// and evicted oldest-first, because neither the key space nor the TTL bounds
// anything on its own: keys are caller-chosen (any query string on an
// allowlisted host), and expiry is only ever evaluated on a lookup of that
// exact key, so an entry nobody asks for a second time used to stay resident
// for the life of the process. A plain map under a mutex, not sync.Map, for
// the same reason the rate limiter below uses one: the size bookkeeping has
// to be atomic with the insert.
const pluginProxyCacheMaxEntries = 512
const pluginProxyCacheMaxBytes = 64 << 20

var (
	pluginProxyCacheMu    sync.Mutex
	pluginProxyCache      = map[string]pluginProxyCacheEntry{}
	pluginProxyCacheOrder []string // keys in insertion order, oldest first
	pluginProxyCacheBytes int
)

type pluginProxyCacheEntry struct {
	body        []byte
	contentType string
	expires     time.Time
}

// pluginProxyCacheDropLocked removes one key and its accounting. Callers hold
// pluginProxyCacheMu.
func pluginProxyCacheDropLocked(key string) {
	e, ok := pluginProxyCache[key]
	if !ok {
		return
	}
	pluginProxyCacheBytes -= len(e.body)
	delete(pluginProxyCache, key)
	for i, k := range pluginProxyCacheOrder {
		if k == key {
			pluginProxyCacheOrder = append(pluginProxyCacheOrder[:i], pluginProxyCacheOrder[i+1:]...)
			break
		}
	}
}

func pluginProxyCached(key string) (pluginProxyCacheEntry, bool) {
	pluginProxyCacheMu.Lock()
	defer pluginProxyCacheMu.Unlock()
	e, ok := pluginProxyCache[key]
	if !ok {
		return pluginProxyCacheEntry{}, false
	}
	if time.Now().Before(e.expires) {
		return e, true
	}
	pluginProxyCacheDropLocked(key)
	return pluginProxyCacheEntry{}, false
}

func pluginProxyStore(key string, body []byte, contentType string) {
	pluginProxyCacheMu.Lock()
	defer pluginProxyCacheMu.Unlock()
	pluginProxyCacheDropLocked(key) // a refresh must not be counted twice
	pluginProxyCache[key] = pluginProxyCacheEntry{body: body, contentType: contentType, expires: time.Now().Add(pluginProxyCacheTTL)}
	pluginProxyCacheOrder = append(pluginProxyCacheOrder, key)
	pluginProxyCacheBytes += len(body)
	for len(pluginProxyCacheOrder) > 0 &&
		(len(pluginProxyCacheOrder) > pluginProxyCacheMaxEntries || pluginProxyCacheBytes > pluginProxyCacheMaxBytes) {
		pluginProxyCacheDropLocked(pluginProxyCacheOrder[0])
	}
}

// Per-client fixed-window rate limit. The Origin check only holds honest
// browsers; without this the proxy is a free spender of the operator's API
// quotas for anyone with curl. A plain map under a mutex, NOT sync.Map:
// load-check-store on sync.Map was a TOCTOU where N concurrent requests all
// read the same stale count and all passed.
var (
	rateMu    sync.Mutex
	rateBy    = map[string]rateEntry{}
	lastSweep time.Time
)

type rateEntry struct {
	count   int
	resetAt time.Time
}

const pluginProxyRateLimit = 10
const pluginProxyRateWindow = time.Minute

// rateAllow enforces a fixed window per key. Callers namespace the key
// ("pp:"+ip, "mb:"+ip, ...) so hammering one feature cannot starve another.
func rateAllow(key string, limit int) bool {
	now := time.Now()
	rateMu.Lock()
	defer rateMu.Unlock()
	// Expired windows would otherwise accumulate one entry per client IP
	// forever; sweep opportunistically, at most once per window.
	if now.Sub(lastSweep) > pluginProxyRateWindow {
		lastSweep = now
		for k, e := range rateBy {
			if now.After(e.resetAt) {
				delete(rateBy, k)
			}
		}
	}
	e, ok := rateBy[key]
	if !ok || now.After(e.resetAt) {
		rateBy[key] = rateEntry{count: 1, resetAt: now.Add(pluginProxyRateWindow)}
		return true
	}
	if e.count >= limit {
		return false
	}
	e.count++
	rateBy[key] = e
	return true
}

func pluginProxyAllow(ip string) bool {
	return rateAllow("pp:"+ip, pluginProxyRateLimit)
}

// Peers whose X-Forwarded-For we believe. Behind traefik the socket peer is
// traefik on the docker network, so private plus loopback is the whole trusted
// set; TRUSTED_PROXY_CIDRS (comma-separated) replaces it for any other
// topology, e.g. adding a CDN's ranges so its hop is skipped too.
var trustedProxyNets = func() []*net.IPNet {
	raw := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if raw == "" {
		raw = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10"
	}
	var out []*net.IPNet
	for _, c := range strings.Split(raw, ",") {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		} else {
			log.Printf("[relay] ignoring unparseable TRUSTED_PROXY_CIDRS entry %q", c)
		}
	}
	return out
}()

func isTrustedProxy(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, n := range trustedProxyNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func clientIP(r *http.Request) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	// X-Forwarded-For is an ordinary request header, so it is only worth
	// anything when the socket peer is a proxy we deployed. Reached directly -
	// the dev compose publishes 8081, and nothing stops a container on the
	// same network from doing it in production - the peer IS the client and
	// its own header would let it pick its rate-limit bucket.
	if !isTrustedProxy(net.ParseIP(remote)) {
		return remote
	}
	var hops []string
	for _, v := range r.Header.Values("X-Forwarded-For") {
		for _, p := range strings.Split(v, ",") {
			if p = strings.TrimSpace(p); p != "" {
				hops = append(hops, p)
			}
		}
	}
	if len(hops) == 0 {
		return remote
	}
	// Right to left, skipping hops that are themselves trusted proxies: every
	// entry to the left of one our own proxy appended is client-supplied, so
	// the rightmost entry that is not a known proxy is the closest thing to
	// the real client that no client could have forged. If every hop looks
	// like a proxy (a deployment whose users are on the same private network),
	// the last one is still the one our proxy wrote.
	for i := len(hops) - 1; i >= 0; i-- {
		ip := net.ParseIP(hops[i])
		if ip == nil || isTrustedProxy(ip) {
			continue
		}
		return ip.String()
	}
	return hops[len(hops)-1]
}

var secretPlaceholderRe = regexp.MustCompile(`\{\{secret:([A-Za-z0-9_-]+)\}\}`)

func pluginProxyHosts() map[string]bool {
	out := map[string]bool{}
	for _, h := range strings.Split(os.Getenv("PLUGIN_PROXY_HOSTS"), ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" {
			out[h] = true
		}
	}
	return out
}

type pluginSecret struct {
	value string
	// Host this secret may be sent to. Empty = any allowlisted host, which
	// is safe with ONE host and a leak with two: any allowlisted upstream
	// could be handed every unbound secret. Bind with NAME@host=value.
	host string
}

var unboundSecretWarn sync.Once

func pluginProxySecrets() map[string]pluginSecret {
	out := map[string]pluginSecret{}
	var unbound []string
	for _, pair := range strings.Split(os.Getenv("PLUGIN_PROXY_SECRETS"), ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		k, v, ok := strings.Cut(pair, "=")
		if !ok || k == "" {
			continue
		}
		name, host, bound := strings.Cut(strings.TrimSpace(k), "@")
		name = strings.ToUpper(strings.TrimSpace(name))
		sec := pluginSecret{value: v}
		if bound {
			sec.host = strings.ToLower(strings.TrimSpace(host))
		} else {
			unbound = append(unbound, name)
		}
		out[name] = sec
	}
	if len(unbound) > 0 {
		unboundSecretWarn.Do(func() {
			log.Printf("[plugin-proxy] secrets without a host binding (%s) can be sent to ANY allowlisted host; prefer NAME@host=value", strings.Join(unbound, ", "))
		})
	}
	return out
}

// substituteSecrets replaces {{secret:NAME}} placeholders for a request
// bound for targetHost. A secret bound to a different host counts as
// missing: the caller answers 204 and no upstream ever sees a key that was
// not meant for it. Placeholders belong in query strings (values are
// query-escaped).
func substituteSecrets(raw string, secrets map[string]pluginSecret, targetHost string) (string, error) {
	targetHost = strings.ToLower(targetHost)
	var missing string
	replaced := secretPlaceholderRe.ReplaceAllStringFunc(raw, func(m string) string {
		name := strings.ToUpper(secretPlaceholderRe.FindStringSubmatch(m)[1])
		if sec, ok := secrets[name]; ok && (sec.host == "" || sec.host == targetHost) {
			return url.QueryEscape(sec.value)
		}
		if missing == "" {
			missing = name
		}
		return m
	})
	if missing != "" {
		return "", fmt.Errorf("secret %s not configured for %s", missing, targetHost)
	}
	return replaced, nil
}

// pluginProxyClient builds the outbound client. pinHost, when non-empty, is
// the host a substituted secret is bound to: redirects must then stay on it,
// so a key configured for host A cannot be walked to allowlisted host B.
// pluginProxySafeDial resolves the host itself and refuses any address that
// would reach the relay's own network, so an allowlisted upstream cannot be
// pointed at internal services through DNS.
func pluginProxySafeDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid address: %w", err)
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("lookup failed for %s", host)
	}
	for _, ipAddr := range ips {
		if isDisallowedIP(ipAddr.IP) {
			return nil, fmt.Errorf("disallowed IP: %s", ipAddr.IP)
		}
	}
	d := &net.Dialer{Timeout: 5 * time.Second}
	return d.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
}

// ONE Transport for the whole process, exactly as og.go does and for the same
// reason. A Transport built per request does not inherit http.DefaultTransport's
// 90s IdleConnTimeout, and net/http only arms the idle timer when that value is
// above zero - so every request's keep-alive connection, and the readLoop and
// writeLoop goroutines serving it, stayed alive for the life of the process.
// The Transport could not be collected either, because those goroutine stacks
// reference it. Each /plugin-proxy call to a new upstream leaked a Transport,
// two goroutines and a socket, permanently.
//
// Only the Client is per-request now, because CheckRedirect has to close over
// this request's allowlist and pinned host.
var pluginProxyTransport = &http.Transport{
	DialContext:         pluginProxySafeDial,
	IdleConnTimeout:     90 * time.Second,
	MaxIdleConns:        64,
	MaxIdleConnsPerHost: 4,
}

func pluginProxyClient(allowed map[string]bool, pinHost string) *http.Client {
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: pluginProxyTransport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			// Go has already copied the previous url into Referer by the time
			// this runs, and that url carries the substituted {{secret:NAME}}
			// value in its query string. Handing it to the redirect target
			// leaks the key through a header the host binding never sees.
			req.Header.Del("Referer")
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			host := strings.ToLower(req.URL.Hostname())
			if req.URL.Scheme != "https" || !allowed[host] {
				return fmt.Errorf("redirect outside the allowlist: %s", req.URL.Host)
			}
			if pinHost != "" && host != pinHost {
				return fmt.Errorf("secret-bearing request redirected off %s", pinHost)
			}
			return nil
		},
	}
}
func handlePluginProxy(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	allowed := pluginProxyHosts()
	if len(allowed) == 0 {
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	if !pluginProxyAllow(clientIP(r)) {
		apiError(w, r, "Slow down", http.StatusTooManyRequests)
		return
	}
	raw := strings.TrimSpace(r.URL.Query().Get("url"))
	if raw == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}
	// Parse BEFORE substitution: the target host decides which secrets may
	// be filled, so it has to come from the placeholder form of the url.
	pre, err := url.Parse(raw)
	if err != nil || pre.Scheme != "https" {
		apiError(w, r, "Only https urls", http.StatusBadRequest)
		return
	}
	host := strings.ToLower(pre.Hostname())
	if !allowed[host] {
		apiError(w, r, "Host not allowlisted on this instance", http.StatusForbidden)
		return
	}
	substituted, err := substituteSecrets(raw, pluginProxySecrets(), host)
	if err != nil {
		// Unconfigured or host-mismatched secret = "not set up".
		withCors(w, r, func(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) })
		return
	}
	target, err := url.Parse(substituted)
	if err != nil || target.Scheme != "https" ||
		strings.ToLower(target.Hostname()) != host {
		// Substitution must never move the request to another host.
		apiError(w, r, "Bad url", http.StatusBadRequest)
		return
	}

	// Cache key includes secrets, deliberately: it lives only in this
	// process's memory and distinct keys must not share entries.
	cacheKey := "pp:" + substituted
	if entry, ok := pluginProxyCached(cacheKey); ok {
		withCors(w, r, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", entry.contentType)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Write(entry.body)
		})
		return
	}

	// A url that actually had a placeholder filled is pinned to its host for
	// the whole redirect chain; one that carries no secret keeps the plain
	// allowlist-wide behaviour.
	pinHost := ""
	if substituted != raw {
		pinHost = host
	}
	resp, err := pluginProxyClient(allowed, pinHost).Get(substituted)
	if err != nil {
		apiError(w, r, "Upstream unreachable", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiError(w, r, fmt.Sprintf("Upstream answered %d", resp.StatusCode), http.StatusBadGateway)
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, pluginProxyMaxBody+1))
	if err != nil || len(body) > pluginProxyMaxBody {
		apiError(w, r, "Upstream response too large", http.StatusBadGateway)
		return
	}
	contentType := resp.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	pluginProxyStore(cacheKey, body, contentType)
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", contentType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Write(body)
	})
}
