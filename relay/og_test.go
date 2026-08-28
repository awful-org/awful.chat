package main

import (
	"net"
	"testing"
)

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
