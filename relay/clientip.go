package main

// Who is the client, and which budget does it spend from.
//
// Every per-client limit in this binary - the rate limits, the concurrency
// ceilings, the storage shares - is only as good as two answers: which
// address the request really came from, and how many addresses one party
// can cheaply hold. This file owns both.

import (
	"context"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"slices"
	"strings"
	"sync"
	"time"
)

// ── Trusted proxies ──────────────────────────────────────────────────────

// trustedProxySet is whose X-Forwarded-For the relay believes, from
// TRUSTED_PROXY_CIDRS: a comma list of CIDRs, bare addresses and hostnames.
//
// It trusts NOTHING by default. It used to trust every private range plus
// loopback, which is right behind Traefik alone and wrong everywhere else
// that matters: on a shared docker network every neighbouring container
// holds a private address too, and any of them could put whatever it liked
// in X-Forwarded-For and pick its own bucket for every per-IP limit here.
// A default that has to be tightened by hand is a default nobody tightens.
//
// A hostname entry exists for exactly the production shape: Traefik's
// address on the docker network is assigned at container start and changes
// whenever Traefik is recreated, so a CIDR written down once goes stale and
// silently turns Traefik itself into "the client" - every user in one
// bucket. A name docker's DNS answers for (dokploy-traefik, the container
// Dokploy runs) is re-resolved on a timer instead, so it follows Traefik
// around. The compose file defaults to that name.
//
// "private" is accepted as an entry and expands to the old default, for a
// deployment that really is a single proxy on a private network with no
// neighbours and wants it back knowingly.
type trustedProxySet struct {
	mu     sync.RWMutex
	static []netip.Prefix
	hosts  []string
	// hostname -> the addresses it last resolved to. A failed lookup keeps
	// the previous answer: dropping trust on one DNS hiccup would put every
	// user behind Traefik into one bucket until the next refresh.
	resolved map[string][]netip.Addr
	// Said once per hostname per state change, so a resolver that is down
	// for an hour does not write a line a minute.
	failing map[string]bool
}

// privateProxyRanges is what "private" expands to, and what the relay used
// to trust with no configuration at all.
var privateProxyRanges = []string{
	"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12",
	"192.168.0.0/16", "fc00::/7", "fe80::/10",
}

// trustedProxyRefresh is how often hostname entries are looked up again.
// Traefik being recreated moves its address; half a minute of the old
// address is half a minute of one shared bucket, which is survivable.
const trustedProxyRefresh = 30 * time.Second

func parseTrustedProxies(raw string) *trustedProxySet {
	set := &trustedProxySet{resolved: map[string][]netip.Addr{}, failing: map[string]bool{}}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		switch {
		case entry == "":
			continue
		case strings.EqualFold(entry, "private"):
			for _, c := range privateProxyRanges {
				set.static = append(set.static, netip.MustParsePrefix(c))
			}
		case strings.Contains(entry, "/"):
			p, err := netip.ParsePrefix(entry)
			if err != nil {
				log.Printf("[relay] ignoring unparseable TRUSTED_PROXY_CIDRS entry %q", entry)
				continue
			}
			set.static = append(set.static, p.Masked())
		default:
			if a, err := netip.ParseAddr(entry); err == nil {
				a = a.Unmap()
				set.static = append(set.static, netip.PrefixFrom(a, a.BitLen()))
				continue
			}
			if !validProxyHostname(entry) {
				log.Printf("[relay] ignoring unparseable TRUSTED_PROXY_CIDRS entry %q", entry)
				continue
			}
			set.hosts = append(set.hosts, strings.ToLower(entry))
		}
	}
	return set
}

// validProxyHostname accepts a DNS name and nothing else, so a typo in a
// CIDR is reported as one instead of being looked up as a host.
func validProxyHostname(h string) bool {
	if len(h) == 0 || len(h) > 253 {
		return false
	}
	for _, c := range h {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '.', c == '_':
		default:
			return false
		}
	}
	return true
}

var trustedProxies = parseTrustedProxies(os.Getenv("TRUSTED_PROXY_CIDRS"))

// refresh looks every hostname entry up once.
func (s *trustedProxySet) refresh(ctx context.Context) {
	for _, h := range s.hosts {
		lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		addrs, err := net.DefaultResolver.LookupNetIP(lctx, "ip", h)
		cancel()
		s.mu.Lock()
		if err != nil || len(addrs) == 0 {
			if !s.failing[h] {
				s.failing[h] = true
				if prev := s.resolved[h]; len(prev) > 0 {
					log.Printf("[relay] TRUSTED_PROXY_CIDRS: %s did not resolve (%v), still trusting its last address", h, err)
				} else {
					log.Printf("[relay] TRUSTED_PROXY_CIDRS: %s did not resolve (%v); until it does, clients behind it share ONE rate-limit bucket", h, err)
				}
			}
			s.mu.Unlock()
			continue
		}
		for i := range addrs {
			addrs[i] = addrs[i].Unmap()
		}
		slices.SortFunc(addrs, func(a, b netip.Addr) int { return a.Compare(b) })
		if s.failing[h] || !slices.Equal(s.resolved[h], addrs) {
			log.Printf("[relay] TRUSTED_PROXY_CIDRS: trusting %s at %v", h, addrs)
		}
		s.failing[h] = false
		s.resolved[h] = addrs
		s.mu.Unlock()
	}
}

// startTrustedProxyResolver resolves the hostname entries once before the
// API starts answering, then keeps them current. Nothing to do when every
// entry is a literal.
func startTrustedProxyResolver() {
	if len(trustedProxies.hosts) == 0 {
		if len(trustedProxies.static) == 0 {
			log.Printf("[relay] TRUSTED_PROXY_CIDRS is empty: X-Forwarded-For is ignored and every request is keyed on its socket peer")
		}
		return
	}
	trustedProxies.refresh(context.Background())
	go func() {
		t := time.NewTicker(trustedProxyRefresh)
		defer t.Stop()
		for range t.C {
			trustedProxies.refresh(context.Background())
		}
	}()
}

func (s *trustedProxySet) contains(a netip.Addr) bool {
	if !a.IsValid() {
		return false
	}
	a = a.Unmap()
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.static {
		if p.Contains(a) {
			return true
		}
	}
	for _, addrs := range s.resolved {
		for _, r := range addrs {
			if r == a {
				return true
			}
		}
	}
	return false
}

func isTrustedProxy(ip net.IP) bool {
	a, ok := netip.AddrFromSlice(ip)
	return ok && trustedProxies.contains(a)
}

// untrustedForwardHint is said once per process: a request from a private
// address carrying X-Forwarded-For, when that address is not trusted, is
// almost always the operator's own proxy with TRUSTED_PROXY_CIDRS unset -
// and every client behind it then shares one bucket, which looks like the
// relay rate-limiting everybody for no reason.
var untrustedForwardHint sync.Once

// clientAddr is the client's own address, trusting X-Forwarded-For only
// from a proxy the operator named.
func clientAddr(r *http.Request) string {
	remote := r.RemoteAddr
	if host, _, err := net.SplitHostPort(remote); err == nil {
		remote = host
	}
	// X-Forwarded-For is an ordinary request header, so it is only worth
	// anything when the socket peer is a proxy we deployed. Reached directly -
	// the dev compose publishes 8081, and nothing stops a container on the
	// same network from doing it in production - the peer IS the client and
	// its own header would let it pick its rate-limit bucket.
	remoteIP := net.ParseIP(remote)
	if !isTrustedProxy(remoteIP) {
		if remoteIP != nil && (remoteIP.IsPrivate() || remoteIP.IsLoopback()) && r.Header.Get("X-Forwarded-For") != "" {
			untrustedForwardHint.Do(func() {
				log.Printf("[relay] a request from %s carries X-Forwarded-For but TRUSTED_PROXY_CIDRS does not trust it: if that is your reverse proxy, name it there, or every client behind it shares one rate-limit bucket", remote)
			})
		}
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

// ── Buckets ──────────────────────────────────────────────────────────────

// An IPv6 client is keyed on its /64: a single host routinely holds a whole
// /64, so per-address buckets would let it rotate through 2^64 fresh
// identities. But a /64 is not the unit anybody is actually allocated
// either. A residential line gets a /56 - 256 /64s - and a server a /48, so
// a /64 bucket on its own still handed one household 256 budgets and one
// rented box 65,536: every "per client" ceiling in this binary was that
// many times looser than it read. Each IPv6 client therefore also spends
// from an aggregate bucket for its /48, sized at ipv6AggregateFactor times
// the per-client budget - enough for several real people on one site, far
// short of what a single allocation used to mint.
const ipv6AggregateFactor = 4

// clientBuckets returns the keys one address is budgeted under: its own
// bucket (an IPv4 address, or an IPv6 /64) and, for IPv6 only, the /48 it
// sits in. IPv4 has no aggregate: the scarce unit there is the address.
func clientBuckets(addr string) (own, agg string) {
	a, err := netip.ParseAddr(addr)
	if err != nil {
		return addr, ""
	}
	a = a.Unmap()
	if a.Is4() {
		return a.String(), ""
	}
	p64, _ := a.Prefix(64)
	p48, _ := a.Prefix(48)
	return p64.String(), p48.String()
}

// sourceKey is the single coarsest bucket for an address - the IPv4
// address, or the IPv6 /48 - for the budgets that are a SHARE of something
// global (stored bytes, open streams) rather than a rate.
func sourceKey(addr string) string {
	own, agg := clientBuckets(addr)
	if agg != "" {
		return agg
	}
	return own
}

// rateKeyIP is the per-client bucket alone. Kept for the callers that only
// need a stable key for one client.
func rateKeyIP(s string) string {
	own, _ := clientBuckets(s)
	return own
}

func clientIP(r *http.Request) string {
	return rateKeyIP(clientAddr(r))
}

// rateAllowClient spends one request from the client's own bucket and, for
// IPv6, from its /48's aggregate too. Both are checked before either is
// charged, so a request the aggregate refuses does not also eat into the
// client's own window.
func rateAllowClient(r *http.Request, prefix string, limit int) bool {
	own, agg := clientBuckets(clientAddr(r))
	if agg == "" {
		return rateAllow(prefix+own, limit)
	}
	return rateAllowAll([]string{prefix + own, prefix + agg}, []int{limit, limit * ipv6AggregateFactor})
}
