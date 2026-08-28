package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
)

var (
	nodeEnv = strings.TrimSpace(os.Getenv("NODE_ENV"))
	domain  = strings.ToLower(strings.TrimSpace(os.Getenv("DOMAIN")))
	// Strictness follows DOMAIN, not NODE_ENV. NODE_ENV defaulted to
	// "development" when it was unset, so an instance that set DOMAIN but
	// forgot the second variable ran with the Origin gate wide open - a
	// security switch that failed open on a missing value. DOMAIN is already
	// mandatory in every real deploy (traefik routes on Host(relay.${DOMAIN}))
	// and is unset only in local dev, where the dev compose publishes the
	// ports directly and no origin is known. NODE_ENV=production still forces
	// strict for a deployment that routes some other way.
	strictOrigin = domain != "" || strings.EqualFold(nodeEnv, "production")
)

// isAllowedOrigin checks if the origin is allowed to make requests
func isAllowedOrigin(origin string) bool {
	// A missing Origin is allowed on purpose and this is load-bearing: the
	// frontend defaults its API base to "" (same-origin) and browsers send no
	// Origin header on a same-origin GET, so rejecting the empty case would
	// 403 every same-origin deployment. It is not the hole it looks like
	// either - Origin is an ordinary request header, so any non-browser client
	// can send whatever value it likes. What bounds non-browser abuse is the
	// per-IP rateAllow budget on each handler, not this check.
	if origin == "" {
		return true
	}
	if !strictOrigin {
		return true
	}
	if domain == "" {
		return false
	}
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return parsed.Scheme == "https" && strings.ToLower(parsed.Hostname()) == domain
}

// corsHeaders returns CORS headers for a request
func corsHeaders(r *http.Request) http.Header {
	origin := r.Header.Get("Origin")
	var allowOrigin string
	if strictOrigin {
		allowOrigin = "https://" + domain
	} else if origin != "" {
		allowOrigin = origin
	} else {
		allowOrigin = "*"
	}

	headers := http.Header{}
	headers.Set("Access-Control-Allow-Origin", allowOrigin)
	headers.Set("Access-Control-Allow-Methods", "GET,OPTIONS")
	headers.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
	headers.Set("Access-Control-Max-Age", "86400")
	headers.Set("Vary", "Origin")
	return headers
}

// withCors wraps a handler function with CORS headers
func withCors(w http.ResponseWriter, r *http.Request, handler func(http.ResponseWriter)) {
	for k, v := range corsHeaders(r) {
		for _, val := range v {
			w.Header().Add(k, val)
		}
	}
	handler(w)
}

// preflight handles OPTIONS requests for CORS
func preflight(w http.ResponseWriter, r *http.Request) {
	for k, v := range corsHeaders(r) {
		for _, val := range v {
			w.Header().Add(k, val)
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// apiError returns a JSON error response with CORS headers
func apiError(w http.ResponseWriter, r *http.Request, msg string, status int) {
	response := map[string]string{"error": msg}
	w.Header().Set("Content-Type", "application/json")
	// Add CORS headers
	for k, v := range corsHeaders(r) {
		for _, val := range v {
			w.Header().Add(k, val)
		}
	}
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(response)
}
