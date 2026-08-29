package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// preflight() existed but was never wired to any route, so an OPTIONS
// request to a GET-only endpoint fell through to the handler like any other
// method - and so did every other verb, running full handler logic
// (including spending the caller's rate-limit budget) for e.g. a POST.
// getOnly is what main.go now wraps /og, /klipy/*, /plugin-proxy and
// /turn-credentials with.
func TestGetOnlyGatesMethods(t *testing.T) {
	var ran bool
	h := getOnly(func(w http.ResponseWriter, r *http.Request) {
		ran = true
		w.WriteHeader(http.StatusOK)
	})

	// GET reaches the handler.
	ran = false
	req := httptest.NewRequest(http.MethodGet, "/x", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if !ran || rec.Code != http.StatusOK {
		t.Fatalf("GET: ran=%v code=%d, want ran=true code=200", ran, rec.Code)
	}

	// OPTIONS gets a proper preflight response and never reaches the handler.
	ran = false
	req = httptest.NewRequest(http.MethodOptions, "/x", nil)
	rec = httptest.NewRecorder()
	h(rec, req)
	if ran {
		t.Fatal("OPTIONS ran the wrapped handler")
	}
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS: code=%d, want %d (preflight)", rec.Code, http.StatusNoContent)
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("OPTIONS response is missing CORS headers")
	}

	// Anything else is refused before the handler runs, and before it can
	// spend the caller's rate-limit budget.
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodHead} {
		ran = false
		req = httptest.NewRequest(method, "/x", nil)
		rec = httptest.NewRecorder()
		h(rec, req)
		if ran {
			t.Fatalf("%s ran the wrapped handler", method)
		}
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: code=%d, want %d", method, rec.Code, http.StatusMethodNotAllowed)
		}
		if rec.Header().Get("Allow") == "" {
			t.Fatalf("%s response is missing an Allow header", method)
		}
	}
}
