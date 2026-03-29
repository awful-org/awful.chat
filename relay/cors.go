package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"strings"
)

var (
	nodeEnv = os.Getenv("NODE_ENV")
	domain  = os.Getenv("DOMAIN")
)

func init() {
	if nodeEnv == "" {
		nodeEnv = "development"
	}
	domain = strings.TrimSpace(strings.ToLower(domain))
}

// isAllowedOrigin checks if the origin is allowed to make requests
func isAllowedOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	if nodeEnv != "production" {
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
	if nodeEnv == "production" {
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
