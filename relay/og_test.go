package main

import (
	"net"
	"net/url"
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
