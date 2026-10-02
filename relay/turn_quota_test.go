package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"maps"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
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

// However often one client asks, it gets at most one more than its cap of
// new credentials within any credential lifetime.
func TestTurnOneClientGetsAFewCredentialsPerLifetime(t *testing.T) {
	for _, tc := range []struct {
		name string
		addr func(ask int) string
		max  int
	}{
		{"an IPv4 address", func(int) string { return "198.51.100.88" }, turnMaxLivePerClient + 1},
		{"an IPv6 /48, from a new /64 each time", func(ask int) string {
			return "2001:db8:1:" + strconv.FormatInt(int64(ask%65536), 16) + "::1"
		}, turnMaxLivePerClient*ipv6AggregateFactor + 1},
	} {
		resetTurnCredentials(t)
		start := time.Unix(1_900_000_000, 0)
		seen := map[string]bool{}
		var minted []time.Time
		// As often as the rate limit allows, for a day.
		for ask, now := 0, start; now.Sub(start) < 24*time.Hour; ask, now = ask+1, now.Add(2*time.Second) {
			req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
			req.RemoteAddr = net.JoinHostPort(tc.addr(ask), "5000")
			cred, err := turnCredentialFor(req, now, "s")
			if err != nil {
				t.Fatal(err)
			}
			if !seen[cred.username] {
				seen[cred.username] = true
				minted = append(minted, now)
			}
		}
		for i := range minted {
			n := 0
			for j := i; j < len(minted) && minted[j].Sub(minted[i]) < turnCredTTL; j++ {
				n++
			}
			if n > tc.max {
				t.Fatalf("%s got %d new credentials within %v of %v, want at most %d", tc.name, n, turnCredTTL, minted[i].Sub(start), tc.max)
			}
		}
		t.Logf("%s, asking every 2s, got %d credentials in a day", tc.name, len(minted))
	}
}

// coturnQuota counts allocations as the pinned coturn (4.17.2) does under
// --use-auth-secret: --total-quota for the server, and one --user-quota
// counter per user, where the user is the part of a username after
// "<digits>:" (check_new_allocation_quota, through get_real_username in its
// userdb.c). Nothing is ever released here: the client keeps refreshing
// every allocation, which coturn allows past the credential's expiry.
type coturnQuota struct {
	perUser, total, held int
	byUser               map[string]int
}

func (q *coturnQuota) allocate(username string) bool {
	user := username
	if before, after, ok := strings.Cut(username, ":"); ok {
		user = before
		if strings.Trim(before, "0123456789") == "" {
			user = after
		}
	}
	if q.held >= q.total || q.byUser[user] >= q.perUser {
		return false
	}
	q.byUser[user]++
	q.held++
	return true
}

// The attack: ask as often as the rate limit allows, for three days, fill
// every new credential's quota, and keep every allocation alive. While each
// credential carried a fresh id, one address added 84 allocations every two
// hours this way and held the whole default pool after about a day. Its
// credentials carry a fixed few ids now, and coturn counts one quota per id,
// so it holds those ids' worth and no more, however long it keeps going.
func TestTurnOneClientHoldsAFewIDsForGood(t *testing.T) {
	for _, tc := range []struct {
		name string
		addr func(ask int) string
		ids  int
	}{
		{"an IPv4 address", func(int) string { return "198.51.100.99" }, turnMaxLivePerClient + 1},
		{"an IPv6 /48, from a new /64 each time", func(ask int) string {
			return "2001:db8:2:" + strconv.FormatInt(int64(ask%65536), 16) + "::1"
		}, turnMaxLivePerClient*ipv6AggregateFactor + 1},
	} {
		resetTurnCredentials(t)
		coturn := &coturnQuota{perUser: 12, total: 900, byUser: map[string]int{}}
		ids := map[string]bool{}
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		start := time.Unix(1_900_000_000, 0)
		for ask, now := 0, start; now.Sub(start) < 72*time.Hour; ask, now = ask+1, now.Add(2*time.Second) {
			req.RemoteAddr = net.JoinHostPort(tc.addr(ask), "5000")
			cred, err := turnCredentialFor(req, now, "s")
			if err != nil {
				t.Fatal(err)
			}
			_, id, _ := strings.Cut(cred.username, ":")
			ids[id] = true
			for coturn.allocate(cred.username) {
			}
		}
		if len(ids) != tc.ids {
			t.Errorf("%s used %d credential ids in three days, want %d", tc.name, len(ids), tc.ids)
		}
		if want := tc.ids * coturn.perUser; coturn.held != want {
			t.Errorf("%s holds %d of %d allocations after three days, want %d", tc.name, coturn.held, coturn.total, want)
		}
	}
}

// The ids are keyed on TURN_SECRET, not on anything a restart forgets: if
// the relay came back with a new set for every address, each address could
// gather another set's worth of allocations at every deploy. And they are
// the client's own: another address shares none of them, nor their quota.
func TestTurnClientIDsSurviveARestart(t *testing.T) {
	idForm := regexp.MustCompile(`^[0-9a-f]{16}$`)
	idsOf := func(addr string, start time.Time) map[string]bool {
		t.Helper()
		ids := map[string]bool{}
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		req.RemoteAddr = net.JoinHostPort(addr, "5000")
		for now := start; now.Sub(start) < 12*time.Hour; now = now.Add(time.Minute) {
			cred, err := turnCredentialFor(req, now, "s")
			if err != nil {
				t.Fatal(err)
			}
			_, id, _ := strings.Cut(cred.username, ":")
			if !idForm.MatchString(id) {
				t.Fatalf("username %q: the id is not sixteen hex digits", cred.username)
			}
			ids[id] = true
		}
		return ids
	}
	start := time.Unix(1_900_000_000, 0)
	resetTurnCredentials(t)
	before := idsOf("198.51.100.120", start)
	if len(before) != turnMaxLivePerClient+1 {
		t.Fatalf("one address used %d ids in twelve hours, want %d", len(before), turnMaxLivePerClient+1)
	}
	resetTurnCredentials(t) // the relay restarts
	if after := idsOf("198.51.100.120", start.Add(13*time.Hour)); !maps.Equal(before, after) {
		t.Fatalf("after a restart one address was handed ids %v, before it %v", after, before)
	}
	for id := range idsOf("198.51.100.121", start) {
		if before[id] {
			t.Fatalf("two addresses were handed the id %s, so they share its quota", id)
		}
	}
}

// Browsers behind one address, each doing what ice-server-list.ts does: ask
// for a credential, then ask again at half the ttl it was given. They are
// one client to the relay, so they draw on its few live credentials: three
// steady browsers each keep their own, and past that they are all handed
// the newest and share it. However they share, each is always handed a
// credential with time left on it, and the address never holds more than
// one past its cap.
func TestTurnBrowsersBehindOneAddressShareItsCredentials(t *testing.T) {
	const addr = "198.51.100.77"
	for _, browsers := range []int{1, 2, 3, 4, 6, 10} {
		resetTurnCredentials(t)
		req := httptest.NewRequest(http.MethodGet, "/turn-credentials", nil)
		req.RemoteAddr = net.JoinHostPort(addr, "5000")

		start := time.Unix(1_900_000_000, 0)
		holding := make([]string, browsers)
		next := make([]time.Time, browsers)
		for i := range next {
			next[i] = start.Add(time.Duration(i) * 7 * time.Second)
		}
		worst := 0
		for {
			i := 0
			for j := range next {
				if next[j].Before(next[i]) {
					i = j
				}
			}
			now := next[i]
			if now.Sub(start) > 8*time.Hour {
				break
			}
			cred, err := turnCredentialFor(req, now, "s")
			if err != nil {
				t.Fatal(err)
			}
			left := time.Duration(cred.expiry-now.Unix()) * time.Second
			if left < turnReissueMinLife {
				t.Fatalf("%d browsers: one was handed a credential with %v left", browsers, left)
			}
			turnMu.Lock()
			held := len(turnLive[addr])
			turnMu.Unlock()
			if held > turnMaxLivePerClient+1 {
				t.Fatalf("%d browsers: the address holds %d live credentials, cap %d", browsers, held, turnMaxLivePerClient+1)
			}
			holding[i] = cred.username
			next[i] = now.Add(left / 2)

			share := map[string]int{}
			for _, u := range holding {
				if u != "" {
					share[u]++
					worst = max(worst, share[u])
				}
			}
		}
		t.Logf("%2d browsers behind one address: up to %d of them share one credential", browsers, worst)
		if browsers <= 3 && worst > 1 {
			t.Errorf("%d steady browsers behind one address: %d share one credential, want each its own", browsers, worst)
		}
	}
}

// The relay bounds one client to a few credential ids; coturn turns each
// into --user-quota allocations. The shipped quota defaults have to keep
// what one address can hold to a small part of the pool - so filling it
// takes eleven addresses at once - and the pool inside the relay port
// range, or the numbers above protect nothing.
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
