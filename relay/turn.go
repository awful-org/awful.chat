package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Default TURN URLs served when TURN_URLS is unset.
var defaultTurnURLs = []string{
	"turn:awful.frav.in:3478?transport=udp",
	"turn:awful.frav.in:3478?transport=tcp",
	"turn:awful.frav.in:5349?transport=tcp",
	// TLS: the only thing some mobile carriers and corporate networks let
	// through. Harmless when coturn has no cert - gathering just skips it.
	"turns:awful.frav.in:5349?transport=tcp",
}

// handleTurnCredentials issues short-lived TURN credentials using coturn's
// REST / use-auth-secret convention (coturn `static-auth-secret`):
//
//	username   = <unix-expiry>
//	credential = base64(HMAC-SHA1(secret, username))
//
// coturn must be configured with `use-auth-secret` and the same
// `static-auth-secret` as TURN_SECRET. When TURN_SECRET is unset the endpoint
// returns 204 so the client keeps using its bundled fallback ICE servers -
// nothing breaks until an operator opts in.
func handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}

	secret := os.Getenv("TURN_SECRET")
	if secret == "" {
		withCors(w, r, func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusNoContent)
		})
		return
	}

	const ttl = 12 * 60 * 60 // 12h - comfortably longer than any call/transfer
	expiry := time.Now().Unix() + ttl
	username := strconv.FormatInt(expiry, 10)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	urls := defaultTurnURLs
	if env := strings.TrimSpace(os.Getenv("TURN_URLS")); env != "" {
		var custom []string
		for _, p := range strings.Split(env, ",") {
			if p = strings.TrimSpace(p); p != "" {
				custom = append(custom, p)
			}
		}
		if len(custom) > 0 {
			urls = custom
		}
	}

	resp := map[string]any{
		"username":   username,
		"credential": credential,
		"ttl":        ttl,
		"urls":       urls,
	}
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
}
