package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"golang.org/x/net/html"
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

// instagramPostPath matches the paths a mirror can answer for: one post or
// reel, optionally under its author's name.
// /share/reel/<id> has that shape too and is left out below: its id is made
// for one person's share.
var (
	instagramPostPath   = regexp.MustCompile(`^(?:/[A-Za-z0-9._]+)?/(?:p|reel|reels|tv)/[A-Za-z0-9_-]+/?$`)
	instagramImageIndex = regexp.MustCompile(`^[0-9]{1,2}$`)
)

// getCandidateUrls lists the urls to build a preview from, best first: the
// link itself, and for an Instagram post a mirror of it. Instagram refuses
// many servers' addresses outright, so on those the mirror is the only answer
// there is; where it does answer, its own page has the caption too. The
// mirror redirects to the post's picture or video.
//
// It is another party's service, so it is asked about posts and nothing
// else, and only which picture of a post is passed on: the rest of a shared
// link's query says who shared it.
func getCandidateUrls(targetURL *url.URL) []string {
	candidates := []string{targetURL.String()}
	switch targetURL.Host {
	case "instagram.com", "www.instagram.com":
		if instagramPostPath.MatchString(targetURL.Path) && !strings.HasPrefix(strings.ToLower(targetURL.Path), "/share/") {
			mirror := url.URL{Scheme: "https", Host: "kkinstagram.com", Path: targetURL.Path}
			if i := targetURL.Query().Get("img_index"); instagramImageIndex.MatchString(i) {
				mirror.RawQuery = url.Values{"img_index": {i}}.Encode()
			}
			candidates = append(candidates, mirror.String())
		}
	}
	return candidates
}

// What one preview may cost. The endpoint answers anyone, and both the link
// and the page behind it are the caller's choice: thirty pages at a time, each
// one five-megabyte tag of made-up attributes, took the relay to 3 GB.
const (
	// The most of a page that is read. YouTube's is 2 MB, with some of its
	// tags 1.3 MB in.
	ogMaxPageBytes = 2 << 20
	// The longest single tag or script; the tags found before a longer one
	// are kept. The tokenizer holds a tag's attributes many times over.
	ogMaxTokenBytes = 1 << 20
	// The longest values kept. A longer text is cut, a longer url is no url.
	ogMaxTitle       = 300
	ogMaxDescription = 1000
	ogMaxName        = 100
	ogMaxURL         = 4096
	// What is kept of any value: past ogMaxURL however the cut falls, so that
	// a url that was cut is seen to be.
	ogMaxValue = ogMaxURL + utf8.UTFMax
	// What a server may say before its page: Go allows 10 MiB of it.
	ogMaxHeaderBytes = 64 << 10
	// Links being fetched, and pages being parsed, at any one time. Few are
	// parsed at once since each takes milliseconds and the memory; a fetch
	// mostly waits. No client has more than a third of them, or a few with
	// links to slow servers would hold up everybody's.
	ogMaxFetches       = 24
	ogMaxClientFetches = 8
	ogMaxParses        = 2
	// How long a link waits for its turn, and how long it then has. Apart,
	// or a turn that came late would leave a site too little time to answer
	// and have it remembered as dead. Together inside the API server's
	// WriteTimeout, past which the answer would go nowhere.
	ogMaxWait  = 4 * time.Second
	ogDeadline = 10 * time.Second // shared between the candidates
)

var (
	ogFetchSlots = make(chan struct{}, ogMaxFetches)
	ogParseSlots = make(chan struct{}, ogMaxParses)

	// Each client's own share, for as long as it has links under way.
	ogClientsMu sync.Mutex
	ogClients   = map[string]*ogClient{}
)

type ogClient struct {
	slots chan struct{}
	links int // holding a slot or waiting for one
}

// ogTake waits for a slot; false when the context ended first.
func ogTake(ctx context.Context, slots chan struct{}) bool {
	select {
	case slots <- struct{}{}:
		return true
	case <-ctx.Done():
		return false
	}
}

// ogTurn waits for a link's turn to be fetched: a slot of its client's share,
// then one of everybody's. release gives both back; nil when the turn did not
// come.
func ogTurn(client string) (release func()) {
	ctx, cancel := context.WithTimeout(context.Background(), ogMaxWait)
	defer cancel()

	ogClientsMu.Lock()
	c := ogClients[client]
	if c == nil {
		c = &ogClient{slots: make(chan struct{}, ogMaxClientFetches)}
		ogClients[client] = c
	}
	c.links++
	ogClientsMu.Unlock()
	leave := func() {
		ogClientsMu.Lock()
		defer ogClientsMu.Unlock()
		if c.links--; c.links == 0 {
			delete(ogClients, client)
		}
	}

	if !ogTake(ctx, c.slots) {
		leave()
		return nil
	}
	if !ogTake(ctx, ogFetchSlots) {
		<-c.slots
		leave()
		return nil
	}
	return func() {
		<-ogFetchSlots
		<-c.slots
		leave()
	}
}

// ogTags is what a preview needs out of a page.
type ogTags struct {
	meta   map[string]string // og:*, twitter:* and description, by lower-case name
	title  string            // the text of <title>
	poster string            // the first <video poster>
}

// readOgTags reads a page's tags with an HTML tokenizer. The first value that
// says anything wins.
//
// It replaced patterns matched against the raw text, which ended every value
// at its first apostrophe ("no matter if it" for "no matter if it's"), left
// every entity but &amp; as it stood ("Schr\u00f6dinger&#039;s cat"), and
// missed tags written in capitals.
func readOgTags(page string) ogTags {
	tags := ogTags{meta: map[string]string{}}
	z := html.NewTokenizer(strings.NewReader(page))
	z.SetMaxBuf(ogMaxTokenBytes)
	inTitle := false
	for {
		switch z.Next() {
		case html.ErrorToken:
			return tags
		case html.TextToken:
			if inTitle && tags.title == "" {
				tags.title = ogClip(string(z.Text()), ogMaxValue)
			}
		case html.EndTagToken:
			inTitle = false
		case html.StartTagToken, html.SelfClosingTagToken:
			name, hasAttr := z.TagName()
			tag := string(name)
			inTitle = tag == "title"
			if tag == "noscript" {
				// Its tags are for readers that run no scripts, as this is.
				z.NextIsNotRawText()
			}
			if !hasAttr || (tag != "meta" && tag != "video") {
				continue
			}
			var keys []string
			content := ""
			for more := true; more; {
				var k, v []byte
				k, v, more = z.TagAttr()
				switch {
				case tag == "video" && string(k) == "poster" && tags.poster == "":
					tags.poster = ogClip(string(v), ogMaxValue)
				case tag == "meta" && (string(k) == "property" || string(k) == "name"):
					keys = append(keys, strings.ToLower(ogClip(string(v), ogMaxName)))
				case tag == "meta" && string(k) == "content":
					content = ogClip(string(v), ogMaxValue)
				}
			}
			if content == "" {
				continue
			}
			for _, key := range keys {
				if key != "description" && !strings.HasPrefix(key, "og:") && !strings.HasPrefix(key, "twitter:") {
					continue
				}
				if _, seen := tags.meta[key]; !seen {
					tags.meta[key] = content
				}
			}
		}
	}
}

// ogClip trims a value and cuts it to at most limit bytes, between characters.
// It copies what it keeps, so a kept value does not hold its whole page.
func ogClip(s string, limit int) string {
	s = strings.TrimSpace(s)
	if len(s) > limit {
		// No further back than one character: it may not be UTF-8 at all.
		for i := 0; i < utf8.UTFMax-1 && !utf8.RuneStart(s[limit]); i++ {
			limit--
		}
		s = s[:limit]
	}
	return strings.Clone(s)
}

// text is the first of keys the page has, cut to limit, or nil.
func (t ogTags) text(limit int, keys ...string) *string {
	for _, key := range keys {
		if v, ok := t.meta[key]; ok {
			v = strings.TrimSpace(ogClip(v, limit))
			return &v
		}
	}
	return nil
}

// link is the same for a url, as an absolute one, or nil. A url that was cut
// is none.
func (t ogTags) link(base string, keys ...string) *string {
	for _, key := range keys {
		if v, ok := t.meta[key]; ok {
			return absolutizeUrl(v, base)
		}
	}
	return nil
}

func (t ogTags) number(keys ...string) *int {
	val := t.text(ogMaxName, keys...)
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
	if raw == "" || len(raw) > ogMaxURL {
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
	if len(s) > ogMaxURL {
		return nil
	}
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

		MaxResponseHeaderBytes: ogMaxHeaderBytes,
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
	// Fetches a minute for one client. Ten, the plugin proxy's, is fewer
	// links than one busy room shows when it opens.
	ogRateLimit  = 30
	ogRatePrefix = "og:"

	ogCacheTTL        = time.Hour
	ogCacheFailTTL    = 5 * time.Minute
	ogCacheMaxEntries = 1024
	ogCacheMaxBytes   = 8 << 20
	// The longest url that is kept, or that later asks wait on: an even share
	// of the bytes. A link is a few hundred bytes, while the relay reads
	// request lines of up to a megabyte, and a handful of urls that long
	// would otherwise take the whole budget and every real preview with it.
	ogCacheMaxKeyBytes = ogCacheMaxBytes / ogCacheMaxEntries
	// The longest answer that is kept. One past the whole budget used to
	// push every other preview out on its way to being dropped itself.
	ogCacheMaxBodyBytes = 64 << 10
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
	busy bool
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
	if len(key) > ogCacheMaxKeyBytes || len(body) > ogCacheMaxBodyBytes {
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
// not be fetched, 503 for one that was not tried, or 429.
func ogPreviewFor(r *http.Request, target *url.URL) (body []byte, status int) {
	key := target.String()
	if len(key) > ogCacheMaxKeyBytes {
		// Neither kept nor shared: each ask for a url this long fetches it
		// and is charged for it, as every preview was before the cache. An
		// ask that joins a running fetch spends no budget, so sharing would
		// let any number of them wait out the fetch, each holding its
		// megabyte of url, for the price of one.
		if !rateAllowClient(r, ogRatePrefix, ogRateLimit) {
			return nil, http.StatusTooManyRequests
		}
		body, busy := ogBuild(clientIP(r), target)
		if busy {
			return nil, http.StatusServiceUnavailable
		}
		return ogAnswer(body)
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
		// the cheapest-for-attacker, dearest-for-server call here. A cache
		// hit, or an ask that joins a fetch already running, costs none of
		// that and spends none of the budget.
		if !rateAllowClient(r, ogRatePrefix, ogRateLimit) {
			return nil, http.StatusTooManyRequests
		}
		ogCacheMu.Lock()
		if call, joined = ogInflight[key]; !joined {
			call = &ogCall{done: make(chan struct{})}
			ogInflight[key] = call
		}
		ogCacheMu.Unlock()
		if !joined {
			ogRunFetch(clientIP(r), key, target, call)
		}
	}
	select {
	case <-call.done:
		if call.busy {
			return nil, http.StatusServiceUnavailable
		}
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
func ogRunFetch(client, key string, target *url.URL, call *ogCall) {
	defer func() {
		ogCacheMu.Lock()
		delete(ogInflight, key)
		// A link that was not tried has not failed.
		if !call.busy {
			ogCacheStoreLocked(key, call.body, time.Now())
		}
		ogCacheMu.Unlock()
		close(call.done)
	}()
	call.body, call.busy = ogBuild(client, target)
}

// ogBuild fetches a link and returns its preview as the JSON answer, or nil
// when it could not be fetched. The first candidate with a picture or a video
// wins; failing that, the first that answered at all. busy means it was not
// tried: too much else was under way.
func ogBuild(client string, target *url.URL) (body []byte, busy bool) {
	release := ogTurn(client)
	if release == nil {
		return nil, true
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), ogDeadline)
	defer cancel()

	var best *OgPreview
	candidates := getCandidateUrls(target)
	for i, candidate := range candidates {
		// An even share of what time is left, so that a first candidate that
		// hangs leaves the next one some.
		deadline, _ := ctx.Deadline()
		share := time.Until(deadline) / time.Duration(len(candidates)-i)
		attempt, done := context.WithTimeout(ctx, share)
		page, ok := ogFetchPage(attempt, candidate)
		done()
		if !ok {
			continue
		}
		preview, ok := ogParseInTurn(ctx, page)
		if !ok {
			busy = true
			break
		}
		if best == nil || preview.MediaType != "none" {
			best = &preview
		}
		if best.MediaType != "none" {
			break
		}
	}
	if best == nil {
		return nil, busy
	}
	body, err := json.Marshal(best)
	if err != nil {
		return nil, false
	}
	return append(body, '\n'), false
}

// ogParseInTurn parses a page when there is a slot for it; false when there
// was none in time.
func ogParseInTurn(ctx context.Context, page ogPage) (OgPreview, bool) {
	if !ogTake(ctx, ogParseSlots) {
		return OgPreview{}, false
	}
	defer func() { <-ogParseSlots }()
	return ogParse(page), true
}

// ogPage is what one url answered with.
type ogPage struct {
	url   string // after redirects
	media string // the content type, for a url that is itself a picture or a video
	html  string // the page otherwise
}

// ogFetchPage fetches one candidate url; false unless it answered 200 with
// something in it. A package var so a test can stand in for the upstream.
var ogFetchPage = func(ctx context.Context, candidate string) (ogPage, bool) {
	req, err := http.NewRequestWithContext(ctx, "GET", candidate, nil)
	if err != nil {
		return ogPage{}, false
	}
	req.Header.Set("User-Agent", "TelegramBot (like TwitterBot)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")

	resp, err := ogHTTPClient.Do(req)
	if err != nil {
		return ogPage{}, false
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return ogPage{}, false
	}
	page := ogPage{url: resp.Request.URL.String()}
	if len(page.url) > ogMaxURL {
		// Where a redirect led, so not the caller's own choice of link. It is
		// the base of the page's urls and goes back in the answer.
		return ogPage{}, false
	}
	media, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	// The type is read even where its parameters are not well formed: an
	// unquoted codecs list is common.
	if (err == nil || errors.Is(err, mime.ErrInvalidMediaParameter)) &&
		(strings.HasPrefix(media, "image/") || strings.HasPrefix(media, "video/")) {
		// The url is the preview. Its bytes are the viewer's to fetch, not
		// the relay's to read as if they were a page.
		page.media = ogClip(media, ogMaxName)
		return page, true
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, ogMaxPageBytes))
	if err != nil || len(body) == 0 {
		return ogPage{}, false
	}
	page.html = string(body)
	return page, true
}

// ogParse builds a preview from what a url answered with.
func ogParse(page ogPage) OgPreview {
	preview := OgPreview{URL: page.url, MediaType: "none"}

	if page.media != "" {
		media := absolutizeUrl(page.url, page.url)
		switch {
		case media == nil:
		case strings.HasPrefix(page.media, "video/"):
			preview.Video, preview.VideoContentType = media, &page.media
			preview.MediaType = "video"
		default:
			preview.Image = media
			preview.MediaType = "image"
		}
		return preview
	}

	tags := readOgTags(page.html)
	preview.Title = tags.text(ogMaxTitle, "og:title", "twitter:title")
	if preview.Title == nil && tags.title != "" {
		title := strings.TrimSpace(ogClip(tags.title, ogMaxTitle))
		preview.Title = &title
	}
	preview.Description = tags.text(ogMaxDescription, "og:description", "twitter:description", "description")
	preview.SiteName = tags.text(ogMaxName, "og:site_name")

	preview.Video = tags.link(page.url, "og:video", "og:video:url", "og:video:secure_url", "twitter:player:stream")
	preview.VideoWidth = tags.number("og:video:width", "twitter:player:width")
	preview.VideoHeight = tags.number("og:video:height", "twitter:player:height")
	preview.VideoContentType = tags.text(ogMaxName, "og:video:type", "twitter:player:stream:content_type")

	preview.Image = tags.link(page.url, "og:image", "twitter:image", "twitter:image:src")
	preview.ImageWidth = tags.number("og:image:width", "twitter:image:width")
	preview.ImageHeight = tags.number("og:image:height", "twitter:image:height")

	// If no image but has video, try poster attribute
	if preview.Image == nil && preview.Video != nil && tags.poster != "" {
		preview.Image = absolutizeUrl(tags.poster, page.url)
	}

	// Determine media type
	if preview.Video != nil {
		preview.MediaType = "video"
	} else if preview.Image != nil {
		preview.MediaType = "image"
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
		// When the window really ends, so the app can ask again then. Whole
		// seconds, and past the end rather than on it: the window is still
		// closed at the instant it ends.
		wait := rateWaitClient(r, ogRatePrefix, ogRateLimit)
		w.Header().Set("Retry-After", strconv.Itoa(int(wait/time.Second)+1))
		apiError(w, r, "rate limited", status)
	case http.StatusServiceUnavailable:
		w.Header().Set("Cache-Control", "no-store")
		apiError(w, r, "busy", status)
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
