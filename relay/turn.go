package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// defaultTurnURLs is what clients get when TURN_URLS is unset: this
// instance's own coturn, derived from DOMAIN.
//
// It used to be a hardcoded awful.frav.in, so every self-hosted instance
// silently handed its users somebody else's TURN server - and after a domain
// move, so did the original.
//
// IMPORTANT for anyone overriding it: the hostname must resolve straight to
// the machine running coturn. TURN is UDP (and raw TCP), which CDN proxies
// like Cloudflare do not forward, so a proxied hostname yields a TURN server
// that can never be reached.
//
// No 5349 entries. Nothing answers there without a certificate, and a dropped
// port is worse than a closed one: ICE waits out a full connect timeout per
// URL instead of failing fast. Add a turns: URL once coturn has a cert - TLS
// TURN is the only transport some mobile carriers allow.
func defaultTurnURLs() []string {
	host := strings.TrimSpace(os.Getenv("TURN_HOST"))
	if host == "" {
		host = strings.TrimSpace(os.Getenv("DOMAIN"))
	}
	if host == "" {
		return nil
	}
	return []string{
		"turn:" + host + ":3478?transport=udp",
		"turn:" + host + ":3478?transport=tcp",
	}
}

// handleTurnCredentials issues short-lived TURN credentials using coturn's
// REST / use-auth-secret convention (coturn `static-auth-secret`):
//
//	username   = <unix-expiry>:<random-id>
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
	// Minting was free and unmetered: the Origin check holds only honest
	// browsers, so anyone with curl could spin HMACs and TURN identities
	// without bound. Before the TURN_SECRET read, so the 204 path is metered
	// too. 30/min rather than the 10 the other handlers use because
	// refreshTurnCredentials fires on every connect() and the reconnect
	// backoff starts at 3s - a flapping tab behind a shared NAT would trip a
	// tighter budget and silently fall back to the static credentials.
	const turnCredsRateLimit = 30
	if !rateAllow("turn:"+clientIP(r), turnCredsRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
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
	// coturn's REST form is "<expiry>[:<id>]". The id half matters: coturn
	// keys --user-quota on the whole username, so minting a bare timestamp put
	// every client that asked in the same wall-clock second into ONE
	// 12-allocation bucket. A voice call is a mesh (one peer connection per
	// peer, two allocations each) and file transfer uses the same ICE list, so
	// a handful of simultaneous joiners exhausted a shared quota and relay
	// candidates simply stopped appearing. It also makes an abusive session
	// distinguishable in coturn's logs.
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	username := strconv.FormatInt(expiry, 10) + ":" + hex.EncodeToString(idBytes)

	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	urls := defaultTurnURLs()
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
	if len(urls) == 0 {
		// Nothing to hand out: no TURN_URLS and no DOMAIN to derive one from.
		// A 204 is the documented "this instance has no TURN" answer and the
		// client keeps its STUN-only list, which is honest - an empty urls
		// array would have the client build a TURN entry pointing nowhere.
		withCors(w, r, func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusNoContent)
		})
		return
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
