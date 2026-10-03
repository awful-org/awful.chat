package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// When TRUSTED_PROXY_CIDRS names nothing that resolves - or a swarm VIP
// rather than the address connections come from - every request is keyed
// on the proxy's own private address. A per-source share applied to that
// address would be a ceiling on the whole instance, so none is: those
// requests keep only the global limits.
func TestProxyClassSourcesHoldNoShares(t *testing.T) {
	withTrustedProxies(t, "") // the proxy's name did not resolve
	const proxy = "172.18.0.9:4000"

	// Pairing: far past the per-client cap of live pairings.
	resetPairing(t)
	locators := "0123456789abcdefghjkmnpqrstvwxyz"
	for i := 0; i < pairingMaxLivePerAggregate+1; i++ {
		if i%pairingCreatesPerClient == 0 {
			resetRateLimiter(t)
		}
		loc := string(locators[i/32]) + string(locators[i%32])
		if rec := pairingRequest(t, "172.18.0.9", map[string]any{"action": "create", "locator": loc}); rec.Code != 200 {
			t.Fatalf("create %d behind the proxy: %d %s", i, rec.Code, rec.Body)
		}
	}

	// Mailbox: deposits are charged to no source, so no share can fill.
	freshMailbox(t)
	did, _ := testDid(t)
	body, _ := json.Marshal(map[string]string{"box": mailboxIDForDid(did), "blob": base64.StdEncoding.EncodeToString([]byte("x"))})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.RemoteAddr = proxy
	req.Header.Set("X-Forwarded-For", "203.0.113.4") // ignored: not trusted
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != http.StatusNoContent {
		t.Fatalf("deposit behind the proxy: %d", w.Code)
	}
	mailboxMu.Lock()
	held, origins := len(mailboxHeld), len(mailboxBlobOrigin)
	mailboxMu.Unlock()
	if held != 0 || origins != 0 {
		t.Fatalf("a proxy-class deposit was charged to a share: %d sources, %d blobs", held, origins)
	}

	// Telemetry: the handler passes no share key for a proxy's address.
	if k := shareKey("172.18.0.9"); k != "" {
		t.Fatalf("proxy address has share key %q", k)
	}

	// Plugin stream: past the per-client concurrency cap, global only.
	var all [][]string
	for i := 0; i < pluginStreamPerAggregate+1; i++ {
		slots, ok := pluginStreamAcquire("172.18.0.9")
		if !ok {
			t.Fatalf("stream %d behind the proxy refused", i)
		}
		all = append(all, slots)
	}
	for _, s := range all {
		pluginStreamRelease(s)
	}
	pluginStreamMu.Lock()
	open, entries := pluginStreamOpen, len(pluginStreamPerIP)
	pluginStreamMu.Unlock()
	if open != 0 || entries != 0 {
		t.Fatalf("slots leaked: open=%d entries=%d", open, entries)
	}
}
