package main

import (
	"context"
	"net/http/httptest"
	"net/netip"
	"os"
	"testing"
)

// The tests in this package model a deployment whose operator named its
// proxy, the way production does through TRUSTED_PROXY_CIDRS: a request
// from 10.x or loopback with X-Forwarded-For is the proxy speaking for a
// client. The relay itself trusts nothing until told to.
func TestMain(m *testing.M) {
	trustedProxies = parseTrustedProxies("10.0.0.0/8,127.0.0.0/8")
	os.Exit(m.Run())
}

// withTrustedProxies swaps the trusted set for one test.
func withTrustedProxies(t *testing.T, raw string) *trustedProxySet {
	t.Helper()
	old := trustedProxies
	trustedProxies = parseTrustedProxies(raw)
	t.Cleanup(func() { trustedProxies = old })
	return trustedProxies
}

// Unset means nobody is believed, however private the socket peer looks: a
// neighbouring container on the docker network is private too, and it must
// not be able to choose its own rate-limit bucket.
func TestClientIPTrustsNothingByDefault(t *testing.T) {
	withTrustedProxies(t, "")
	for _, remote := range []string{"10.0.0.1:9000", "127.0.0.1:9000", "172.18.0.4:9000", "198.51.100.4:9000"} {
		req := httptest.NewRequest("GET", "/og", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", "203.0.113.1")
		want, _, _ := splitHostPortForTest(remote)
		if got := clientIP(req); got != want {
			t.Errorf("%s: got %q, want the socket peer %q", remote, got, want)
		}
	}
}

func splitHostPortForTest(hp string) (string, string, error) {
	ap, err := netip.ParseAddrPort(hp)
	if err != nil {
		return "", "", err
	}
	return ap.Addr().String(), "", nil
}

// Literal entries: a bare address, a CIDR, and the "private" keyword that
// restores the old default for an operator who knowingly wants it.
func TestTrustedProxyEntries(t *testing.T) {
	set := withTrustedProxies(t, "10.0.1.5, 2001:db8::/32 ,private, not a cidr/99, bad host!")
	cases := map[string]bool{
		"10.0.1.5":        true,
		"10.0.1.6":        true, // via "private"
		"192.168.3.3":     true, // via "private"
		"2001:db8::7":     true,
		"198.51.100.1":    false,
		"::ffff:10.0.1.5": true,
	}
	for addr, want := range cases {
		if got := set.contains(netip.MustParseAddr(addr)); got != want {
			t.Errorf("%s: trusted=%v, want %v", addr, got, want)
		}
	}
	if len(set.hosts) != 0 {
		t.Errorf("garbage was taken for a hostname: %v", set.hosts)
	}

	only := withTrustedProxies(t, "10.0.1.5")
	if only.contains(netip.MustParseAddr("10.0.1.6")) {
		t.Error("a bare address trusted its neighbour")
	}
}

// A hostname entry follows the proxy across a restart: it is resolved on a
// timer, and a failed lookup keeps the last good answer rather than
// dropping every client behind the proxy into one bucket.
func TestTrustedProxyHostname(t *testing.T) {
	set := withTrustedProxies(t, "localhost")
	if len(set.hosts) != 1 || set.hosts[0] != "localhost" {
		t.Fatalf("hostname entry not recorded: %v", set.hosts)
	}
	if set.contains(netip.MustParseAddr("127.0.0.1")) {
		t.Fatal("trusted before it was ever resolved")
	}
	set.refresh(context.Background())
	if !set.contains(netip.MustParseAddr("127.0.0.1")) && !set.contains(netip.MustParseAddr("::1")) {
		t.Fatal("localhost did not resolve to a trusted address")
	}

	// A lookup that fails keeps what the name resolved to before.
	set.mu.Lock()
	set.resolved["gone.invalid"] = []netip.Addr{netip.MustParseAddr("10.9.9.9")}
	set.hosts = append(set.hosts, "gone.invalid")
	set.mu.Unlock()
	set.refresh(context.Background())
	if !set.contains(netip.MustParseAddr("10.9.9.9")) {
		t.Fatal("a failed lookup dropped the last known proxy address")
	}
}

// Behind a trusted proxy the header names the client, and only the part of
// it our own proxy wrote counts.
func TestClientIPTrustsOnlyProxies(t *testing.T) {
	withTrustedProxies(t, "10.0.0.0/8")
	cases := []struct {
		name   string
		remote string
		xff    string
		want   string
	}{
		{"direct caller cannot forge a bucket", "198.51.100.4:9000", "203.0.113.1", "198.51.100.4"},
		{"an untrusted private neighbour cannot either", "172.18.0.9:9000", "203.0.113.1", "172.18.0.9"},
		{"behind the proxy the header is the client", "10.0.0.1:9000", "203.0.113.1", "203.0.113.1"},
		{"a client-prepended hop is ignored", "10.0.0.1:9000", "203.0.113.1, 198.51.100.9", "198.51.100.9"},
		{"a trusted extra hop is skipped", "10.0.0.1:9000", "203.0.113.1, 10.0.0.7", "203.0.113.1"},
		{"no header falls back to the socket peer", "10.0.0.1:9000", "", "10.0.0.1"},
		{"all-trusted hops keep the last one", "10.0.0.1:9000", "10.4.4.4", "10.4.4.4"},
		{"garbage in the header is skipped", "10.0.0.1:9000", "203.0.113.1, not-an-ip", "203.0.113.1"},
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "/plugin-proxy", nil)
		req.RemoteAddr = c.remote
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		if got := clientIP(req); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
