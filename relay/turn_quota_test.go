package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// resetTurnCredentials forgets every credential handed out, so a test starts
// with every client holding none.
func resetTurnCredentials(t *testing.T) {
	t.Helper()
	turnMu.Lock()
	defer turnMu.Unlock()
	turnLive = map[string][]*turnCredential{}
	turnLastSwept = time.Time{}
}

// turnFrom asks for a credential as the client at addr, reached directly.
func turnFrom(t *testing.T, addr string) turnResponse {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
	req.RemoteAddr = net.JoinHostPort(addr, "5000")
	rec := httptest.NewRecorder()
	handleTurnCredentials(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("%s: expected 200, got %d", addr, rec.Code)
	}
	var body turnResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	return body
}

// Every mint was a new coturn user with its own --user-quota, so one address
// minted the twenty-five credentials it takes to hold the whole default
// --total-quota inside one rate window. It now holds turnMaxLivePerClient
// and is handed those again, each still valid and with time left on it.
func TestTurnCredentialsOneClientHoldsAFewLiveCredentials(t *testing.T) {
	const secret = "test-secret-123"
	t.Setenv("TURN_SECRET", secret)
	t.Setenv("DOMAIN", "example.com")
	resetRateLimiter(t)
	resetTurnCredentials(t)

	seen := map[string]bool{}
	for i := 0; i < 30; i++ { // the whole rate window
		body := turnFrom(t, "198.51.100.30")
		mac := hmac.New(sha1.New, []byte(secret))
		mac.Write([]byte(body.Username))
		if body.Credential != base64.StdEncoding.EncodeToString(mac.Sum(nil)) {
			t.Fatalf("request %d: credential is not HMAC-SHA1 over its username", i)
		}
		if body.TTL <= int(turnReissueMinLife/time.Second) || body.TTL > int(turnCredTTL/time.Second) {
			t.Fatalf("request %d: ttl %d outside (%v, %v]", i, body.TTL, turnReissueMinLife, turnCredTTL)
		}
		seen[body.Username] = true
	}
	if len(seen) != turnMaxLivePerClient {
		t.Fatalf("one address was handed %d distinct credentials in a window, want %d", len(seen), turnMaxLivePerClient)
	}
	// Another address has credentials of its own.
	resetRateLimiter(t)
	if other := turnFrom(t, "198.51.100.31"); seen[other.Username] {
		t.Fatal("a different address was handed somebody else's credential")
	}
}

// Credentials age out on their own, and a client whose newest one is near
// its end gets a fresh one rather than one about to expire.
func TestTurnCredentialsAreMintedAgainAsTheyAge(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("DOMAIN", "example.com")
	resetRateLimiter(t)
	resetTurnCredentials(t)
	const addr = "198.51.100.40"
	for i := 0; i < turnMaxLivePerClient; i++ {
		turnFrom(t, addr)
	}
	age := func(left time.Duration) {
		turnMu.Lock()
		defer turnMu.Unlock()
		for _, c := range turnLive[addr] {
			c.expiry = time.Now().Add(left).Unix()
		}
	}

	age(10 * time.Minute)
	fresh := turnFrom(t, addr)
	if fresh.TTL != int(turnCredTTL/time.Second) {
		t.Fatalf("with every credential near its end the client got ttl %d, want a fresh %d", fresh.TTL, int(turnCredTTL/time.Second))
	}
	if again := turnFrom(t, addr); again.Username != fresh.Username {
		t.Fatal("the fresh credential was not the one handed out next")
	}
	turnMu.Lock()
	held := len(turnLive[addr])
	turnMu.Unlock()
	if held != turnMaxLivePerClient+1 {
		t.Fatalf("the client holds %d live credentials, want at most one past the cap (%d)", held, turnMaxLivePerClient+1)
	}

	age(-time.Second)
	if body := turnFrom(t, addr); body.TTL != int(turnCredTTL/time.Second) {
		t.Fatalf("after everything expired the client got ttl %d, want a fresh credential", body.TTL)
	}
	turnMu.Lock()
	held = len(turnLive[addr])
	turnMu.Unlock()
	if held != 1 {
		t.Fatalf("expired credentials still counted: %d held", held)
	}
}

// One IPv6 /48 is 65,536 /64s; together they hold ipv6AggregateFactor
// clients' worth.
func TestTurnCredentialsAggregateIPv6(t *testing.T) {
	t.Setenv("TURN_SECRET", "s")
	t.Setenv("DOMAIN", "example.com")
	resetRateLimiter(t)
	resetTurnCredentials(t)
	seen := map[string]bool{}
	for i := 0; i < turnMaxLivePerClient*ipv6AggregateFactor+20; i++ {
		resetRateLimiter(t)
		seen[turnFrom(t, "2001:db8:0:"+strconv.FormatInt(int64(i), 16)+"::1").Username] = true
	}
	if want := turnMaxLivePerClient * ipv6AggregateFactor; len(seen) != want {
		t.Fatalf("one /48 was handed %d distinct credentials, want %d", len(seen), want)
	}
}

// The relay bounds what one client holds only in credentials; coturn turns
// that into allocations. The shipped quota defaults have to keep one
// address, at most, to a small part of the pool, and the pool inside the
// relay port range, or the numbers above protect nothing.
func TestTurnQuotaDefaultsKeepOneClientToASmallShare(t *testing.T) {
	quota := func(src []byte, name string) int {
		m := regexp.MustCompile(`--` + name + `=\$\{TURN_[A-Z_]+:-(\d+)\}`).FindSubmatch(src)
		if m == nil {
			t.Fatalf("no --%s default found", name)
		}
		n, _ := strconv.Atoi(string(m[1]))
		return n
	}
	for _, path := range []string{"../docker-compose.dokploy.yml", "../deploy/turn-satellite/docker-compose.yml"} {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Skipf("%s not found: run from the repo checkout", path)
		}
		total, perUser := quota(src, "total-quota"), quota(src, "user-quota")
		minPort, maxPort := quota(src, "min-port"), quota(src, "max-port")
		held := (turnMaxLivePerClient + 1) * perUser
		if held*10 > total {
			t.Errorf("%s: one address can hold %d of %d allocations, over a tenth", path, held, total)
		}
		if total > maxPort-minPort+1 {
			t.Errorf("%s: --total-quota %d is more than the %d relay ports", path, total, maxPort-minPort+1)
		}
	}
}
