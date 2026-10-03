package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// OgPreview represents the Open Graph preview response
type OgPreview struct {
	URL              string  `json:"url"`
	Title            *string `json:"title,omitempty"`
	Description      *string `json:"description,omitempty"`
	SiteName         *string `json:"siteName,omitempty"`
	Image            *string `json:"image,omitempty"`
	ImageWidth       *int    `json:"imageWidth,omitempty"`
	ImageHeight      *int    `json:"imageHeight,omitempty"`
	Video            *string `json:"video,omitempty"`
	VideoWidth       *int    `json:"videoWidth,omitempty"`
	VideoHeight      *int    `json:"videoHeight,omitempty"`
	VideoContentType *string `json:"videoContentType,omitempty"`
	MediaType        string  `json:"mediaType"`
}

var ogRewriteRules = []struct {
	Hosts    []string
	Rewrites []func(*url.URL) string
}{
	{
		Hosts: []string{"instagram.com", "www.instagram.com"},
		Rewrites: []func(*url.URL) string{
			func(u *url.URL) string {
				if u.RawQuery == "" {
					return fmt.Sprintf("https://d.vxinstagram.com%s", u.Path)
				}
				return fmt.Sprintf("https://d.vxinstagram.com%s?%s", u.Path, u.RawQuery)
			},
			func(u *url.URL) string {
				if u.RawQuery == "" {
					return fmt.Sprintf("https://www.ddinstagram.com%s", u.Path)
				}
				return fmt.Sprintf("https://www.ddinstagram.com%s?%s", u.Path, u.RawQuery)
			},
		},
	},
}

func getCandidateUrls(targetURL *url.URL) []string {
	for _, rule := range ogRewriteRules {
		for _, host := range rule.Hosts {
			if targetURL.Host == host {
				results := make([]string, len(rule.Rewrites))
				for i, rewrite := range rule.Rewrites {
					results[i] = rewrite(targetURL)
				}
				return results
			}
		}
	}
	return []string{targetURL.String()}
}

func escapeRegex(s string) string {
	specialChars := []string{".", "*", "+", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"}
	result := s
	for _, char := range specialChars {
		result = strings.ReplaceAll(result, char, "\\"+char)
	}
	return result
}

// The two patterns for each meta key, compiled once. The keys are the fixed
// literals below, so this holds a couple of dozen entries at most; compiling
// them on every preview was up to 46 compiles a request.
var (
	ogMetaPatternsMu sync.Mutex
	ogMetaPatterns   = map[string][2]*regexp.Regexp{}
)

func ogMetaPatternsFor(key string) [2]*regexp.Regexp {
	ogMetaPatternsMu.Lock()
	defer ogMetaPatternsMu.Unlock()
	if p, ok := ogMetaPatterns[key]; ok {
		return p
	}
	escaped := escapeRegex(key)
	p := [2]*regexp.Regexp{
		regexp.MustCompile(`<meta[^>]+(?:property|name)=["']` + escaped + `["'][^>]*content=["']([^"']+)["'][^>]*>`),
		regexp.MustCompile(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']` + escaped + `["'][^>]*>`),
	}
	ogMetaPatterns[key] = p
	return p
}

var (
	ogTitlePattern  = regexp.MustCompile(`<title[^>]*>([^<]+)</title>`)
	ogPosterPattern = regexp.MustCompile(`poster=["']([^"']+)["']`)
)

func extractMetaContent(html string, keys []string) *string {
	for _, key := range keys {
		for _, pattern := range ogMetaPatternsFor(key) {
			matches := pattern.FindStringSubmatch(html)
			if len(matches) > 1 {
				value := strings.TrimSpace(strings.ReplaceAll(matches[1], "&amp;", "&"))
				return &value
			}
		}
	}
	return nil
}

func extractMetaNumber(html string, keys []string) *int {
	val := extractMetaContent(html, keys)
	if val == nil {
		return nil
	}
	n, err := strconv.Atoi(*val)
	if err != nil {
		return nil
	}
	return &n
}

// absolutizeUrl resolves a page-supplied url against the page and returns it
// only if the result is an absolute http or https url. The page is whatever
// the preview fetched - anyone's - and these urls go straight into an img
// src or a video element in every client that shows the preview, so a
// javascript:, data: or file: url in og:image is the page choosing what
// the app loads. Anything else is dropped as if the tag were absent.
func absolutizeUrl(raw, base string) *string {
	if raw == "" {
		return nil
	}
	baseURL, err := url.Parse(base)
	if err != nil {
		return nil
	}
	result, err := baseURL.Parse(raw)
	if err != nil {
		return nil
	}
	if !isWebURL(result) {
		return nil
	}
	s := result.String()
	return &s
}

// isWebURL reports whether u is an absolute http or https url with a host.
func isWebURL(u *url.URL) bool {
	return u != nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil
}

// Ranges the stdlib predicates in isDisallowedIP do not cover but that are
// still not the public internet. CGNAT is the one that matters in practice:
// Tailscale tailnets and several hosting providers' internal service networks
// live in 100.64.0.0/10, and the coturn config already denies exactly that
// range (docker-compose.dokploy.yml), so the preview fetcher should not be the
// one door left open onto it.
var disallowedNets = func() []*net.IPNet {
	cidrs := []string{
		"0.0.0.0/8",     // "this network"; IsUnspecified matches only 0.0.0.0 itself
		"100.64.0.0/10", // CGNAT and Tailscale; the range coturn already denies
		"198.18.0.0/15", // benchmarking, wired to internal test gear on some networks
		"240.0.0.0/4",   // reserved, and covers the 255.255.255.255 broadcast address
		// IPv6 transition ranges whose embedded IPv4 address cannot be read
		// back reliably, so they are refused outright rather than decoded
		// (the ones that can be decoded are, in embeddedIPv4). Local-use
		// NAT64 puts the IPv4 address wherever the operator's prefix length
		// says; Teredo obfuscates it and routes through a third-party relay.
		// Neither serves a link preview anybody needs.
		"64:ff9b:1::/48", // local-use NAT64 (RFC 8215)
		"2001::/32",      // Teredo
	}
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			// These are literals, so a parse failure is a typo in this file
			// and must not degrade silently into a wider SSRF surface.
			panic("bad disallowed CIDR " + c + ": " + err.Error())
		}
		out = append(out, n)
	}
	return out
}()

// isDisallowedIP checks if an IP is in a disallowed range (loopback, private,
// link-local, multicast, unspecified, plus the extra ranges in
// disallowedNets). Returns true if the IP should be blocked.
func isDisallowedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// Loopback: 127.0.0.0/8 (IPv4), ::1 (IPv6)
	if ip.IsLoopback() {
		return true
	}
	// Private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (IPv4), fc00::/7 (IPv6)
	if ip.IsPrivate() {
		return true
	}
	// Link-local: 169.254.0.0/16 (IPv4), fe80::/10 (IPv6)
	// Includes cloud metadata endpoint 169.254.169.254
	if ip.IsLinkLocalUnicast() {
		return true
	}
	// Unspecified: 0.0.0.0 (IPv4), :: (IPv6)
	if ip.IsUnspecified() {
		return true
	}
	// Multicast: 224.0.0.0/4 (IPv4), ff00::/8 (IPv6)
	if ip.IsMulticast() {
		return true
	}
	// Everything the predicates above miss. Contains normalizes IPv4-mapped
	// IPv6 first, so ::ffff:100.64.0.1 is caught too.
	for _, n := range disallowedNets {
		if n.Contains(ip) {
			return true
		}
	}
	// An IPv6 address that carries an IPv4 one is only as public as that
	// IPv4 address. On a host with NAT64, 64:ff9b::a9fe:a9fe IS
	// 169.254.169.254, the cloud metadata service, and none of the checks
	// above look inside it.
	if v4 := embeddedIPv4(ip); v4 != nil {
		return isDisallowedIP(v4)
	}
	return false
}

var (
	nat64WellKnown = mustCIDR("64:ff9b::/96") // RFC 6052: IPv4 in the low 32 bits
	sixToFour      = mustCIDR("2002::/16")    // RFC 3056: IPv4 in bits 16-47
	ipv4Compatible = mustCIDR("::/96")        // deprecated RFC 4291 form, ::a.b.c.d
)

func mustCIDR(c string) *net.IPNet {
	_, n, err := net.ParseCIDR(c)
	if err != nil {
		panic("bad CIDR " + c + ": " + err.Error())
	}
	return n
}

// embeddedIPv4 returns the IPv4 address an IPv6 transition address stands
// for - NAT64's well-known prefix, 6to4, or the old IPv4-compatible form -
// or nil for any other address.
func embeddedIPv4(ip net.IP) net.IP {
	if ip.To4() != nil {
		return nil
	}
	ip16 := ip.To16()
	if ip16 == nil {
		return nil
	}
	switch {
	case nat64WellKnown.Contains(ip16):
		return net.IPv4(ip16[12], ip16[13], ip16[14], ip16[15])
	case sixToFour.Contains(ip16):
		return net.IPv4(ip16[2], ip16[3], ip16[4], ip16[5])
	case ipv4Compatible.Contains(ip16):
		// :: and ::1 are caught above; anything else here is ::a.b.c.d.
		return net.IPv4(ip16[12], ip16[13], ip16[14], ip16[15])
	}
	return nil
}

// allowedFetchPorts is where an outbound fetch may connect: the web's two
// ports. A url may name any port, and the preview fetcher answering on
// someone's behalf from inside this deployment's network made it a port
// scanner for every public host - and anything that speaks HTTP-ish on
// another port a way to have the relay send it requests.
var allowedFetchPorts = map[string]bool{"80": true, "443": true}

// ogSafeDial resolves the target host itself and refuses every address that is
// not on the public internet, so neither an attacker-chosen hostname nor a
// redirect can turn the preview fetcher into a probe of the relay's own
// network.
func ogSafeDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid address: %w", err)
	}
	if !allowedFetchPorts[port] {
		return nil, fmt.Errorf("disallowed port: %s", port)
	}
	// Resolve and validate all IPs returned by the resolver
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("lookup failed: %w", err)
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no IPs resolved for %s", host)
	}
	for _, ipAddr := range ips {
		if isDisallowedIP(ipAddr.IP) {
			return nil, fmt.Errorf("disallowed IP: %s", ipAddr.IP)
		}
	}
	// Use standard dialer with the validated IP
	dialer := &net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 5 * time.Second,
	}
	return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
}

// One client for every preview fetch instead of one per request. Building a
// Transport per request leaked: a hand-built Transport does not inherit
// http.DefaultTransport's 90s IdleConnTimeout, and net/http only arms the idle
// timer when that value is above zero, so every request's keep-alive
// connection - and the read and write goroutines serving it - stayed alive for
// the life of the process. Sharing one Transport also lets a second preview of
// the same host reuse the connection instead of redialing.
var ogHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	Transport: &http.Transport{
		DialContext:         ogSafeDial,
		IdleConnTimeout:     90 * time.Second,
		MaxIdleConns:        64,
		MaxIdleConnsPerHost: 4,
	},
	// via holds the requests already made, so this errors on the sixth
	// redirect exactly as the per-request counter it replaced did.
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 {
			return fmt.Errorf("too many redirects")
		}
		// Re-validate the redirect target host
		targetHost := req.URL.Hostname()
		ips, err := net.DefaultResolver.LookupIPAddr(req.Context(), targetHost)
		if err != nil {
			return fmt.Errorf("redirect target resolution failed: %w", err)
		}
		for _, ipAddr := range ips {
			if isDisallowedIP(ipAddr.IP) {
				return fmt.Errorf("redirect target has disallowed IP: %s", ipAddr.IP)
			}
		}
		return nil
	},
}

// Previews are kept in memory and answered from there: every message with a
// link fetched its preview again each time it was drawn - opening a room,
// switching back to it, each member's view of a new link at once - and every
// one of those was a full upstream fetch and parse, since the answer carried
// nothing a browser could cache. Concurrent asks for the same url share one
// fetch. A failure is remembered too, briefly, so a dead link is not fetched
// again for every viewer. Bounded on entries and bytes and evicted oldest
// first, like the plugin proxy's cache. The bytes are each url's as well as
// its answer's: the urls are the caller's choice, and a failure is kept with
// nothing but its url, so counting answers alone let a thousand made-up
// urls of a megabyte each sit in an "8 MiB" cache.
const (
	ogCacheTTL        = time.Hour
	ogCacheFailTTL    = 5 * time.Minute
	ogCacheMaxEntries = 1024
	ogCacheMaxBytes   = 8 << 20
	// The longest url that is kept, or that later asks wait on: an even share
	// of the bytes. A link is a few hundred bytes, while the relay reads
	// request lines of up to a megabyte, and a handful of urls that long
	// would otherwise take the whole budget and every real preview with it.
	ogCacheMaxKeyBytes = ogCacheMaxBytes / ogCacheMaxEntries
)

type ogCacheEntry struct {
	body    []byte // the JSON answer, nil for a fetch that failed
	expires time.Time
}

// ogCall is one fetch in flight; the asks that arrive while it runs wait for
// it instead of starting their own.
type ogCall struct {
	done chan struct{}
	body []byte
}

var (
	ogCacheMu    sync.Mutex
	ogCache      = map[string]ogCacheEntry{}
	ogCacheOrder []string // keys in insertion order, oldest first
	ogCacheBytes int
	ogInflight   = map[string]*ogCall{}
)

// ogCacheDropLocked removes one key and its accounting. Caller holds
// ogCacheMu.
func ogCacheDropLocked(key string) {
	e, ok := ogCache[key]
	if !ok {
		return
	}
	ogCacheBytes -= len(key) + len(e.body)
	delete(ogCache, key)
	// slices.Delete clears the slot it vacates, so the order list does not
	// keep a dropped url alive behind its length.
	if i := slices.Index(ogCacheOrder, key); i >= 0 {
		ogCacheOrder = slices.Delete(ogCacheOrder, i, i+1)
	}
}

// ogCacheStoreLocked keeps an answer, nil for a failure, unless its url is
// longer than ogCacheMaxKeyBytes. Caller holds ogCacheMu.
func ogCacheStoreLocked(key string, body []byte, now time.Time) {
	ogCacheDropLocked(key)
	if len(key) > ogCacheMaxKeyBytes {
		return
	}
	ttl := ogCacheTTL
	if body == nil {
		ttl = ogCacheFailTTL
	}
	ogCache[key] = ogCacheEntry{body: body, expires: now.Add(ttl)}
	ogCacheOrder = append(ogCacheOrder, key)
	ogCacheBytes += len(key) + len(body)
	for len(ogCacheOrder) > 0 && (len(ogCacheOrder) > ogCacheMaxEntries || ogCacheBytes > ogCacheMaxBytes) {
		ogCacheDropLocked(ogCacheOrder[0])
	}
}

// ogPreviewFor answers from the cache, waits for a fetch of the same url
// already running, or - and only then charging the caller's rate budget -
// fetches it. status is 200 with the JSON body, 502 for a page that could
// not be fetched, or 429.
func ogPreviewFor(r *http.Request, target *url.URL) (body []byte, status int) {
	key := target.String()
	if len(key) > ogCacheMaxKeyBytes {
		// Neither kept nor shared: each ask for a url this long fetches it
		// and is charged for it, as every preview was before the cache. An
		// ask that joins a running fetch spends no budget, so sharing would
		// let any number of them wait out the fetch, each holding its
		// megabyte of url, for the price of one.
		if !rateAllowClient(r, "og:", pluginProxyRateLimit) {
			return nil, http.StatusTooManyRequests
		}
		return ogAnswer(ogBuild(target))
	}
	ogCacheMu.Lock()
	if e, ok := ogCache[key]; ok {
		if time.Now().Before(e.expires) {
			ogCacheMu.Unlock()
			return ogAnswer(e.body)
		}
		ogCacheDropLocked(key)
	}
	call, joined := ogInflight[key]
	ogCacheMu.Unlock()
	if !joined {
		// The one outbound-fetch handler that had NO throttle: each request
		// is a DNS lookup plus up to 10s of held goroutine and a 5MB read -
		// the cheapest-for-attacker, dearest-for-server call here. Same
		// budget as its plugin-proxy sibling. A cache hit, or an ask that
		// joins a fetch already running, costs none of that and spends none
		// of it.
		if !rateAllowClient(r, "og:", pluginProxyRateLimit) {
			return nil, http.StatusTooManyRequests
		}
		ogCacheMu.Lock()
		if call, joined = ogInflight[key]; !joined {
			call = &ogCall{done: make(chan struct{})}
			ogInflight[key] = call
		}
		ogCacheMu.Unlock()
		if !joined {
			ogRunFetch(key, target, call)
		}
	}
	select {
	case <-call.done:
		return ogAnswer(call.body)
	case <-r.Context().Done():
		return nil, http.StatusBadGateway
	}
}

func ogAnswer(body []byte) ([]byte, int) {
	if body == nil {
		return nil, http.StatusBadGateway
	}
	return body, http.StatusOK
}

// ogRunFetch fetches one preview for everybody waiting on call, and keeps
// the answer.
func ogRunFetch(key string, target *url.URL, call *ogCall) {
	defer func() {
		ogCacheMu.Lock()
		delete(ogInflight, key)
		ogCacheStoreLocked(key, call.body, time.Now())
		ogCacheMu.Unlock()
		close(call.done)
	}()
	call.body = ogBuild(target)
}

// ogBuild fetches a page and returns its preview as the JSON answer, or nil
// when it could not be fetched.
func ogBuild(target *url.URL) []byte {
	html, finalUrl := ogFetchPage(target)
	if html == "" {
		return nil
	}
	body, err := json.Marshal(ogParse(html, finalUrl))
	if err != nil {
		return nil
	}
	return append(body, '\n')
}

// ogFetchPage fetches the page a preview is built from: the first candidate
// url (see ogRewriteRules) that answers 200, and the url it ended up at
// after redirects. Empty html when none did. A package var so a test can
// stand in for the upstream.
var ogFetchPage = func(target *url.URL) (html, finalUrl string) {
	finalUrl = target.String()

	const maxBodyBytes = 5 * 1024 * 1024 // 5 MB limit

	for _, candidate := range getCandidateUrls(target) {
		req, err := http.NewRequest("GET", candidate, nil)
		if err != nil {
			continue
		}
		req.Header.Set("User-Agent", "TelegramBot (like TwitterBot)")
		req.Header.Set("Accept", "text/html,application/xhtml+xml")

		resp, err := ogHTTPClient.Do(req)
		if err != nil {
			continue
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			continue
		}

		// Wrap body in size limiter before reading
		limitedBody := io.LimitReader(resp.Body, maxBodyBytes)
		body, err := io.ReadAll(limitedBody)
		if err != nil {
			continue
		}
		html = string(body)
		finalUrl = resp.Request.URL.String()
		if finalUrl == "" {
			finalUrl = candidate
		}
		break
	}
	return html, finalUrl
}

// ogParse builds a preview from a fetched page.
func ogParse(html, finalUrl string) OgPreview {
	preview := OgPreview{
		URL: finalUrl,
	}

	// Extract title
	title := extractMetaContent(html, []string{"og:title", "twitter:title"})
	if title == nil {
		matches := ogTitlePattern.FindStringSubmatch(html)
		if len(matches) > 1 {
			s := strings.TrimSpace(matches[1])
			title = &s
		}
	}
	preview.Title = title

	// Extract description
	preview.Description = extractMetaContent(html, []string{"og:description", "twitter:description", "description"})

	// Extract site name
	preview.SiteName = extractMetaContent(html, []string{"og:site_name"})

	// Extract video
	if videoURL := extractMetaContent(html, []string{"og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream"}); videoURL != nil {
		preview.Video = absolutizeUrl(*videoURL, finalUrl)
	}
	preview.VideoWidth = extractMetaNumber(html, []string{"og:video:width", "twitter:player:width"})
	preview.VideoHeight = extractMetaNumber(html, []string{"og:video:height", "twitter:player:height"})
	preview.VideoContentType = extractMetaContent(html, []string{"og:video:type", "twitter:player:stream:content_type"})

	// Extract image
	if imageURL := extractMetaContent(html, []string{"og:image", "twitter:image", "twitter:image:src"}); imageURL != nil {
		preview.Image = absolutizeUrl(*imageURL, finalUrl)
	}
	preview.ImageWidth = extractMetaNumber(html, []string{"og:image:width", "twitter:image:width"})
	preview.ImageHeight = extractMetaNumber(html, []string{"og:image:height", "twitter:image:height"})

	// If no image but has video, try poster attribute
	if preview.Image == nil && preview.Video != nil {
		matches := ogPosterPattern.FindStringSubmatch(html)
		if len(matches) > 1 {
			preview.Image = absolutizeUrl(matches[1], finalUrl)
		}
	}

	// Determine media type
	if preview.Video != nil {
		preview.MediaType = "video"
	} else if preview.Image != nil {
		preview.MediaType = "image"
	} else {
		preview.MediaType = "none"
	}
	return preview
}

func handleOgPreview(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}

	target := r.URL.Query().Get("url")
	target = strings.TrimSpace(target)
	if target == "" {
		apiError(w, r, "Missing url parameter", http.StatusBadRequest)
		return
	}

	targetURL, err := url.Parse(target)
	if err != nil {
		apiError(w, r, "Invalid URL", http.StatusBadRequest)
		return
	}
	if !isWebURL(targetURL) {
		apiError(w, r, "Only http/https URLs are supported", http.StatusBadRequest)
		return
	}
	if p := targetURL.Port(); p != "" && !allowedFetchPorts[p] {
		apiError(w, r, "Only ports 80 and 443 are supported", http.StatusBadRequest)
		return
	}

	body, status := ogPreviewFor(r, targetURL)
	switch status {
	case http.StatusTooManyRequests:
		apiError(w, r, "rate limited", status)
	case http.StatusOK:
		withCors(w, r, func(w http.ResponseWriter) {
			w.Header().Set("Content-Type", "application/json")
			// The browser's own cache can answer the next mount of the same
			// link without asking at all.
			w.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", int(ogCacheTTL/time.Second)))
			w.Write(body)
		})
	default:
		w.Header().Set("Cache-Control", fmt.Sprintf("private, max-age=%d", int(ogCacheFailTTL/time.Second)))
		apiError(w, r, "All OG sources failed", http.StatusBadGateway)
	}
}
