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
	"strconv"
	"strings"
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

func extractMetaContent(html string, keys []string) *string {
	for _, key := range keys {
		escaped := escapeRegex(key)
		patterns := []*regexp.Regexp{
			regexp.MustCompile(`<meta[^>]+(?:property|name)=["']` + escaped + `["'][^>]*content=["']([^"']+)["'][^>]*>`),
			regexp.MustCompile(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']` + escaped + `["'][^>]*>`),
		}
		for _, pattern := range patterns {
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
	s := result.String()
	return &s
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
	return false
}

// ogSafeDial resolves the target host itself and refuses every address that is
// not on the public internet, so neither an attacker-chosen hostname nor a
// redirect can turn the preview fetcher into a probe of the relay's own
// network.
func ogSafeDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("invalid address: %w", err)
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

func handleOgPreview(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	// The one outbound-fetch handler that had NO throttle: each request is
	// a DNS lookup plus up to 10s of held goroutine and a 5MB read - the
	// cheapest-for-attacker, dearest-for-server call here. Same budget as
	// its plugin-proxy sibling.
	if !rateAllow("og:"+clientIP(r), pluginProxyRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
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
	if targetURL.Scheme != "http" && targetURL.Scheme != "https" {
		apiError(w, r, "Only http/https URLs are supported", http.StatusBadRequest)
		return
	}

	candidates := getCandidateUrls(targetURL)
	var html string
	finalUrl := targetURL.String()

	const maxBodyBytes = 5 * 1024 * 1024 // 5 MB limit

	for _, candidate := range candidates {
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

	if html == "" {
		apiError(w, r, "All OG sources failed", http.StatusBadGateway)
		return
	}

	preview := OgPreview{
		URL: finalUrl,
	}

	// Extract title
	title := extractMetaContent(html, []string{"og:title", "twitter:title"})
	if title == nil {
		titlePattern := regexp.MustCompile(`<title[^>]*>([^<]+)</title>`)
		matches := titlePattern.FindStringSubmatch(html)
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
		posterPattern := regexp.MustCompile(`poster=["']([^"']+)["']`)
		matches := posterPattern.FindStringSubmatch(html)
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

	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(preview)
	})
}
