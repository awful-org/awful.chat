package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetInvites(t *testing.T) {
	t.Helper()
	inviteMu.Lock()
	inviteStore = map[string]inviteEntry{}
	inviteMu.Unlock()
}

func postInvite(t *testing.T, ip, roomCode string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/invite", strings.NewReader(`{"roomCode":"`+roomCode+`"}`))
	req.RemoteAddr = ip + ":1234"
	rec := httptest.NewRecorder()
	postOnly(handleInviteCreate)(rec, req)
	return rec
}

func getInvite(t *testing.T, ip, code string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/invite/"+code, nil)
	req.RemoteAddr = ip + ":1234"
	rec := httptest.NewRecorder()
	getOnly(handleInviteResolve)(rec, req)
	return rec
}

func TestInviteCreateThenResolve(t *testing.T) {
	resetInvites(t)
	rec := postInvite(t, "10.0.0.1", "3f9a1c2b4d5e6f70")
	if rec.Code != http.StatusOK {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	var made struct {
		Code string `json:"code"`
		TTL  int    `json:"ttl"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &made)
	if !validInviteCode(made.Code) || made.TTL != 300 {
		t.Fatalf("bad create body: %s", rec.Body)
	}

	// Canonical, lowercase with a dash, and with look-alikes typed in.
	typed := strings.ToLower(made.Code[:4]) + "-" + made.Code[4:]
	lookalike := strings.NewReplacer("0", "O", "1", "l").Replace(made.Code)
	for _, form := range []string{made.Code, typed, lookalike} {
		rec := getInvite(t, "10.0.0.2", form)
		if rec.Code != http.StatusOK {
			t.Fatalf("resolve %q: %d %s", form, rec.Code, rec.Body)
		}
		var got struct {
			RoomCode string `json:"roomCode"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &got)
		if got.RoomCode != "3f9a1c2b4d5e6f70" {
			t.Fatalf("resolve %q: got %q", form, got.RoomCode)
		}
	}
}

func TestInviteUnknownAndJunk(t *testing.T) {
	resetInvites(t)
	if rec := getInvite(t, "10.0.0.3", "7QK3M9"); rec.Code != http.StatusNotFound {
		t.Fatalf("unknown: want 404, got %d", rec.Code)
	}
	if rec := getInvite(t, "10.0.0.3", "7QK3MU"); rec.Code != http.StatusBadRequest {
		t.Fatalf("U is not in the alphabet: want 400, got %d", rec.Code)
	}
	if rec := getInvite(t, "10.0.0.3", "7QK3M"); rec.Code != http.StatusBadRequest {
		t.Fatalf("5 chars: want 400, got %d", rec.Code)
	}
	if rec := postInvite(t, "10.0.0.3", ""); rec.Code != http.StatusBadRequest {
		t.Fatalf("empty roomCode: want 400, got %d", rec.Code)
	}
}

func TestInviteExpires(t *testing.T) {
	resetInvites(t)
	orig := inviteTTL
	inviteTTL = 20 * time.Millisecond
	defer func() { inviteTTL = orig }()

	code, err := createInvite("room", time.Now())
	if err != nil || code == "" {
		t.Fatal("create failed")
	}
	if _, ok := resolveInvite(code, time.Now()); !ok {
		t.Fatal("fresh code should resolve")
	}
	if _, ok := resolveInvite(code, time.Now().Add(inviteTTL)); ok {
		t.Fatal("expired code resolved")
	}
	// The next insert sweeps it out of the map.
	if _, err := createInvite("other", time.Now().Add(inviteTTL)); err != nil {
		t.Fatal(err)
	}
	inviteMu.Lock()
	n := len(inviteStore)
	inviteMu.Unlock()
	if n != 1 {
		t.Fatalf("expired entry not swept: %d live", n)
	}
}

func TestInviteCap(t *testing.T) {
	resetInvites(t)
	orig := inviteMaxLive
	inviteMaxLive = 3
	defer func() { inviteMaxLive = orig }()
	now := time.Now()
	for i := 0; i < 3; i++ {
		if code, _ := createInvite("room", now); code == "" {
			t.Fatalf("create %d refused under the cap", i)
		}
	}
	if code, _ := createInvite("room", now); code != "" {
		t.Fatal("4th create should be refused")
	}
}

func TestInviteRateLimitCountsHitsAndMisses(t *testing.T) {
	resetInvites(t)
	code, _ := createInvite("room", time.Now())
	ip := "10.9.9.9"
	for i := 0; i < inviteRateLimit; i++ {
		form := code
		if i%2 == 1 {
			form = "ZZZZZZ" // a miss
		}
		if rec := getInvite(t, ip, form); rec.Code == http.StatusTooManyRequests {
			t.Fatalf("lookup %d limited early", i)
		}
	}
	if rec := getInvite(t, ip, code); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("lookup %d: want 429, got %d", inviteRateLimit+1, rec.Code)
	}
}

func TestInviteGlobalMissBudget(t *testing.T) {
	resetInvites(t)
	orig := inviteMissLimit
	inviteMissLimit = 5
	defer func() { inviteMissLimit = orig }()
	rateMu.Lock()
	delete(rateBy, "invite-miss")
	rateMu.Unlock()
	code, _ := createInvite("room", time.Now())
	// Five misses from five different addresses use the relay-wide budget up.
	for i := 0; i < 5; i++ {
		ip := "10.7.0." + string(rune('1'+i))
		if rec := getInvite(t, ip, "ZZZZZZ"); rec.Code != http.StatusNotFound {
			t.Fatalf("miss %d: want 404, got %d", i, rec.Code)
		}
	}
	if rec := getInvite(t, "10.7.0.9", "ZZZZZZ"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("6th miss: want 429, got %d", rec.Code)
	}
	// Hits never draw on it.
	if rec := getInvite(t, "10.7.0.10", code); rec.Code != http.StatusOK {
		t.Fatalf("hit after budget spent: want 200, got %d", rec.Code)
	}
}

func TestRateKeyIPCollapsesIPv6To64(t *testing.T) {
	a := rateKeyIP("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
	b := rateKeyIP("2001:db8:1:2:1111:2222:3333:4444")
	c := rateKeyIP("2001:db8:1:3::1")
	if a != b {
		t.Fatalf("same /64 keyed differently: %s vs %s", a, b)
	}
	if a == c {
		t.Fatalf("different /64 keyed the same: %s", a)
	}
	if rateKeyIP("203.0.113.9") != "203.0.113.9" {
		t.Fatal("IPv4 must pass through unchanged")
	}
}

func TestInviteMethodGating(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/invite", nil)
	rec := httptest.NewRecorder()
	postOnly(handleInviteCreate)(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /invite: want 405, got %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodOptions, "/invite", nil)
	rec = httptest.NewRecorder()
	postOnly(handleInviteCreate)(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS /invite: want 204, got %d", rec.Code)
	}
}
