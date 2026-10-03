package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInviteRetiredAndMethods(t *testing.T) {
	mux := http.NewServeMux()
	registerInviteEndpoints(mux)
	for _, tc := range []struct {
		method, path, body string
		status             int
	}{
		{"GET", "/invite", "", 405},
		{"OPTIONS", "/invite", "", 204},
		{"GET", "/invite/7QK3M9", "", 410},
		{"POST", "/invite", `{"roomCode":"r2_secret"}`, 400},
	} {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)))
		if rec.Code != tc.status {
			t.Fatalf("%s %s: %d %s", tc.method, tc.path, rec.Code, rec.Body)
		}
		if strings.Contains(rec.Body.String(), "r2_secret") {
			t.Fatal("echoed capability")
		}
	}
}

func TestRateKeyIPCollapsesIPv6To64(t *testing.T) {
	a := rateKeyIP("2001:db8:1:2:aaaa:bbbb:cccc:dddd")
	b := rateKeyIP("2001:db8:1:2:1111:2222:3333:4444")
	c := rateKeyIP("2001:db8:1:3::1")
	if a != b || a == c {
		t.Fatal("IPv6 rate keys must group by /64")
	}
	if rateKeyIP("203.0.113.9") != "203.0.113.9" {
		t.Fatal("IPv4 changed")
	}
}
