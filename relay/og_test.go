package main

import (
	"context"
	"net"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// The d.vxinstagram.com candidate concatenated Path and RawQuery with no
// separator, so a real Instagram url with a query string (e.g. ?img_index=2
// on a carousel post) produced an unparseable candidate that ogHTTPClient
// could never actually fetch - silently falling through to the second
// candidate every time. A bare path (no query) must not gain a trailing "?".
func TestInstagramCandidateURLsHaveAQuerySeparator(t *testing.T) {
	withQuery, err := url.Parse("https://www.instagram.com/p/abc123/?img_index=2")
	if err != nil {
		t.Fatal(err)
	}
	got := getCandidateUrls(withQuery)
	if len(got) != 2 {
		t.Fatalf("expected 2 candidates, got %v", got)
	}
	if want := "https://d.vxinstagram.com/p/abc123/?img_index=2"; got[0] != want {
		t.Errorf("candidate 0 = %q, want %q", got[0], want)
	}
	if want := "https://www.ddinstagram.com/p/abc123/?img_index=2"; got[1] != want {
		t.Errorf("candidate 1 = %q, want %q", got[1], want)
	}

	noQuery, err := url.Parse("https://www.instagram.com/p/abc123/")
	if err != nil {
		t.Fatal(err)
	}
	got = getCandidateUrls(noQuery)
	if want := "https://d.vxinstagram.com/p/abc123/"; got[0] != want {
		t.Errorf("candidate with no query gained a stray separator: %q, want %q", got[0], want)
	}
}

func TestIsDisallowedIP(t *testing.T) {
	// The ranges the stdlib predicates already covered, kept here so a future
	// edit to isDisallowedIP cannot quietly drop one of them.
	blocked := []string{
		"127.0.0.1",       // loopback
		"10.1.2.3",        // private
		"172.16.0.1",      // private
		"192.168.1.1",     // private
		"169.254.169.254", // link-local, the cloud metadata endpoint
		"0.0.0.0",         // unspecified
		"224.0.0.1",       // multicast
		"239.255.255.255", // multicast, top of 224.0.0.0/4
		"::1",             // IPv6 loopback
		"fd00::1",         // IPv6 unique-local
		"fe80::1",         // IPv6 link-local
		// The ranges disallowedNets adds. 100.64/10 is the one that matters:
		// it is where Tailscale and several providers' internal networks live,
		// and coturn's denied-peer-ip list already covers it.
		"100.64.0.1",
		"100.127.255.255",
		"0.0.0.1",
		"198.18.0.1",
		"198.19.255.255",
		"240.0.0.1",
		"255.255.255.255",
		// An IPv4-mapped IPv6 literal must not be a way around any of it.
		"::ffff:100.64.0.1",
	}
	for _, s := range blocked {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if !isDisallowedIP(ip) {
			t.Errorf("%s should be disallowed", s)
		}
	}

	// Public addresses must still resolve, including the ones adjacent to the
	// new ranges - an off-by-one in a CIDR would break real previews.
	allowed := []string{
		"1.1.1.1",
		"8.8.8.8",
		"100.63.255.255", // just below CGNAT
		"100.128.0.0",    // just above CGNAT
		"198.17.255.255", // just below the benchmarking range
		"198.20.0.0",     // just above the benchmarking range
		"2606:4700:4700::1111",
	}
	for _, s := range allowed {
		ip := net.ParseIP(s)
		if ip == nil {
			t.Fatalf("test bug: %q is not an IP", s)
		}
		if isDisallowedIP(ip) {
			t.Errorf("%s should be allowed", s)
		}
	}

	if !isDisallowedIP(nil) {
		t.Error("a nil IP must be disallowed")
	}
}

// An IPv6 transition address is only as public as the IPv4 address inside
// it: through the host's NAT64, 64:ff9b::a9fe:a9fe is the metadata service.
func TestIsDisallowedIPLooksInsideTransitionAddresses(t *testing.T) {
	blocked := []string{
		"64:ff9b::a9fe:a9fe",  // NAT64 of 169.254.169.254
		"64:ff9b::7f00:1",     // NAT64 of 127.0.0.1
		"64:ff9b::a00:1",      // NAT64 of 10.0.0.1
		"2002:a9fe:a9fe::1",   // 6to4 of 169.254.169.254
		"2002:c0a8:101::",     // 6to4 of 192.168.1.1
		"::7f00:1",            // IPv4-compatible 127.0.0.1
		"::a00:1",             // IPv4-compatible 10.0.0.1
		"64:ff9b:1::a00:1",    // local-use NAT64: refused outright
		"64:ff9b:1:ffff::808", // however the IPv4 is laid out in it
		"2001:0:4136:e378::1", // Teredo: refused outright
	}
	for _, s := range blocked {
		if !isDisallowedIP(net.ParseIP(s)) {
			t.Errorf("%s should be disallowed", s)
		}
	}
	allowed := []string{
		"64:ff9b::808:808", // NAT64 of 8.8.8.8
		"2002:808:808::1",  // 6to4 of 8.8.8.8
		"2001:db8::1",      // not Teredo: 2001:db8::/32 is next door
		"2001:4860::8888",  // Google, a real 2001:: address outside 2001::/32
	}
	for _, s := range allowed {
		if isDisallowedIP(net.ParseIP(s)) {
			t.Errorf("%s should be allowed", s)
		}
	}
}

// Only the web's ports, on every outbound fetch path.
func TestSafeDialsRefuseOtherPorts(t *testing.T) {
	for _, dial := range []func(context.Context, string, string) (net.Conn, error){ogSafeDial, pluginProxySafeDial} {
		for _, addr := range []string{"example.com:22", "example.com:6379", "example.com:8080"} {
			if c, err := dial(context.Background(), "tcp", addr); err == nil {
				c.Close()
				t.Errorf("dialled %s", addr)
			} else if !strings.Contains(err.Error(), "disallowed port") {
				t.Errorf("%s: refused for the wrong reason: %v", addr, err)
			}
		}
	}
	req := httptest.NewRequest("GET", "/og/preview?url="+url.QueryEscape("http://example.com:6379/"), nil)
	rec := httptest.NewRecorder()
	handleOgPreview(rec, req)
	if rec.Code != 400 {
		t.Errorf("a preview of port 6379 got %d, want 400", rec.Code)
	}
}

// A preview hands its urls to an img src and a video element in every client
// that shows it, so only absolute http(s) urls may come back.
func TestAbsolutizeUrlOnlyReturnsWebURLs(t *testing.T) {
	base := "https://example.com/post/1"
	cases := map[string]string{
		"/img.png":                      "https://example.com/img.png",
		"https://cdn.example.com/a.jpg": "https://cdn.example.com/a.jpg",
		"//cdn.example.com/a.jpg":       "https://cdn.example.com/a.jpg",
		"javascript:alert(1)":           "",
		"JavaScript:alert(1)":           "",
		"data:image/svg+xml,<svg/>":     "",
		"file:///etc/passwd":            "",
		"blob:https://example.com/uuid": "",
		"ftp://example.com/a.png":       "",
		"https://user:pw@example.com/a": "",
	}
	for raw, want := range cases {
		got := absolutizeUrl(raw, base)
		switch {
		case want == "" && got != nil:
			t.Errorf("%q: returned %q, want nothing", raw, *got)
		case want != "" && (got == nil || *got != want):
			t.Errorf("%q: got %v, want %q", raw, got, want)
		}
	}
}
