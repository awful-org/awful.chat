package main

// Tests for relay/telemetry.go. Mirrors the idioms in mailbox_test.go and
// invite_test.go: telemetryDir = t.TempDir() as the first statement of
// every storage test, counters saved and restored via t.Cleanup,
// resetRateLimiter(t) first in every rate-limited test, and the handler
// always called through its postOnly/getOnly-shaped wrapper.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	ic "github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/peer"
)

// testPeer generates a fresh Ed25519 libp2p identity, the shape every real
// awful.chat peerId has (sync.svelte.ts pins the "12D3KooW" identity-hash
// prefix for exactly this key type).
func testPeer(t *testing.T) (peer.ID, ic.PrivKey) {
	t.Helper()
	priv, pub, err := ic.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	id, err := peer.IDFromPublicKey(pub)
	if err != nil {
		t.Fatalf("peer id: %v", err)
	}
	return id, priv
}

// telemetrySign signs tsStr+body exactly the way
// frontend/src/lib/telemetry/upload.ts does.
func telemetrySign(t *testing.T, priv ic.PrivKey, tsStr string, body []byte) string {
	t.Helper()
	sum := sha256.Sum256(body)
	msg := []byte("awful-telemetry:" + tsStr + ":" + hex.EncodeToString(sum[:]))
	sig, err := priv.Sign(msg)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

func telemetryRequest(peerId, tsStr, sig string, body []byte) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/telemetry", bytes.NewReader(body))
	req.Header.Set("X-Awful-Peer", peerId)
	req.Header.Set("X-Awful-Ts", tsStr)
	req.Header.Set("X-Awful-Sig", sig)
	req.RemoteAddr = "203.0.113.50:9000"
	return req
}

// enableTelemetry flips TELEMETRY_ENABLED on for one test. telemetryDir is
// deliberately NOT touched here - every caller sets it as ITS OWN first
// statement, the mailboxDir convention.
func enableTelemetry(t *testing.T) {
	t.Helper()
	orig := telemetryEnabled
	telemetryEnabled = true
	t.Cleanup(func() { telemetryEnabled = orig })
}

// assertLastCloseReason fails the test unless the most recent event
// recorded for peerId is an rv.close carrying d.reason == want.
func assertLastCloseReason(t *testing.T, peerId, want string) {
	t.Helper()
	events, _ := diagSnapshot(peerId)
	if len(events) == 0 {
		t.Fatalf("no diag events recorded for %s", peerId)
	}
	last := events[len(events)-1]
	if last.Kind != "rv.close" {
		t.Fatalf("last event kind = %q, want rv.close", last.Kind)
	}
	got, _ := last.D["reason"].(string)
	if got != want {
		t.Fatalf("rv.close reason = %q, want %q", got, want)
	}
	if last.Peer == nil || *last.Peer != peerId {
		t.Fatalf("rv.close peer = %v, want %q", last.Peer, peerId)
	}
}

// ── POST /telemetry ─────────────────────────────────────────────────────

func TestTelemetryDisabledAnswersNoContentAndWritesNothing(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	orig := telemetryEnabled
	telemetryEnabled = false
	t.Cleanup(func() { telemetryEnabled = orig })

	reg := newRegistry()
	peerId, priv := testPeer(t)
	body := []byte(`{"hello":"world"}`)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, priv, tsStr, body)

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(peerId.String(), tsStr, sig, body))

	if rec.Code != http.StatusNoContent {
		t.Fatalf("disabled telemetry: got %d, want 204", rec.Code)
	}
	entries, _ := os.ReadDir(telemetryDir)
	if len(entries) != 0 {
		t.Fatalf("disabled telemetry wrote %d entries under telemetryDir", len(entries))
	}
}

func TestTelemetryIngestHappyPath(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	peerId, priv := testPeer(t)
	body := []byte(`{"hello":"world"}`)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, priv, tsStr, body)

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(peerId.String(), tsStr, sig, body))

	if rec.Code != http.StatusOK {
		t.Fatalf("happy path: got %d, want 200, body=%s", rec.Code, rec.Body.String())
	}
	var resp struct {
		BundleId string `json:"bundleId"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if resp.BundleId == "" {
		t.Fatal("empty bundleId")
	}
	stored, err := os.ReadFile(filepath.Join(telemetryDir, resp.BundleId))
	if err != nil {
		t.Fatalf("stored bundle not found at %s: %v", resp.BundleId, err)
	}
	var staple map[string]any
	if err := json.Unmarshal(stored, &staple); err != nil {
		t.Fatalf("stored bundle is not JSON: %v", err)
	}
	if _, ok := staple["relayView"]; !ok {
		t.Fatal("stored bundle is missing its stapled relayView")
	}
	if staple["hello"] != "world" {
		t.Fatalf("stored bundle lost the client's own field: %+v", staple)
	}
}

func TestTelemetryRejectsSignatureFromWrongKey(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	peerId, _ := testPeer(t)
	_, otherPriv := testPeer(t)
	body := []byte(`{"a":1}`)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, otherPriv, tsStr, body) // signed by a key OTHER than peerId's own

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(peerId.String(), tsStr, sig, body))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("wrong-key signature: got %d, want 401", rec.Code)
	}
	entries, _ := os.ReadDir(telemetryDir)
	if len(entries) != 0 {
		t.Fatal("a rejected upload must not be stored")
	}
}

func TestTelemetryRejectsStaleTimestamp(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	peerId, priv := testPeer(t)
	body := []byte(`{"a":1}`)
	staleMs := time.Now().Add(-telemetryAuthSkew - time.Minute).UnixMilli()
	tsStr := strconv.FormatInt(staleMs, 10)
	sig := telemetrySign(t, priv, tsStr, body)

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(peerId.String(), tsStr, sig, body))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("stale timestamp: got %d, want 401", rec.Code)
	}
}

// An RSA public key is too large to embed in its own peerId (go-libp2p
// hashes it instead), so ExtractPublicKey fails - a peerId/key mismatch
// distinct from "the signature does not verify".
func TestTelemetryRejectsPeerIdWithoutEmbeddedKey(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	priv, pub, err := ic.GenerateRSAKeyPair(2048, rand.Reader)
	if err != nil {
		t.Fatalf("rsa keygen: %v", err)
	}
	rsaId, err := peer.IDFromPublicKey(pub)
	if err != nil {
		t.Fatalf("peer id: %v", err)
	}
	body := []byte(`{"a":1}`)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, priv, tsStr, body)

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(rsaId.String(), tsStr, sig, body))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("peerId with no embedded key: got %d, want 401", rec.Code)
	}
}

func TestTelemetryRejectsOversizeBody(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	peerId, priv := testPeer(t)
	body := make([]byte, telemetryMaxBody+1)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, priv, tsStr, body)

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, telemetryRequest(peerId.String(), tsStr, sig, body))

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize body: got %d, want 413", rec.Code)
	}
}

// Disallowed Origin is refused before any of the work above.
func TestTelemetryRejectsDisallowedOrigin(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)
	origDomain, origStrict := domain, strictOrigin
	domain, strictOrigin = "example.com", true
	t.Cleanup(func() { domain, strictOrigin = origDomain, origStrict })

	reg := newRegistry()
	peerId, priv := testPeer(t)
	body := []byte(`{"a":1}`)
	tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
	sig := telemetrySign(t, priv, tsStr, body)
	req := telemetryRequest(peerId.String(), tsStr, sig, body)
	req.Header.Set("Origin", "https://evil.example")

	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("disallowed Origin: got %d, want 403", rec.Code)
	}
}

// Minting was unmetered for turn-credentials before RELAY-audit fixed it;
// /telemetry gets the same shape of test.
func TestTelemetryIngestRateLimited(t *testing.T) {
	telemetryDir = t.TempDir()
	resetRateLimiter(t)
	enableTelemetry(t)

	reg := newRegistry()
	call := func() int {
		peerId, priv := testPeer(t)
		body := []byte(`{"a":1}`)
		tsStr := strconv.FormatInt(time.Now().UnixMilli(), 10)
		sig := telemetrySign(t, priv, tsStr, body)
		req := telemetryRequest(peerId.String(), tsStr, sig, body)
		req.RemoteAddr = "198.51.100.88:5000"
		rec := httptest.NewRecorder()
		postOnly(handleTelemetryIngest(reg))(rec, req)
		return rec.Code
	}
	for i := 0; i < telemetryRateLimit; i++ {
		if code := call(); code == http.StatusTooManyRequests {
			t.Fatalf("request %d throttled inside the budget", i)
		}
	}
	if code := call(); code != http.StatusTooManyRequests {
		t.Fatalf("request over the budget got %d, want 429", code)
	}
}

func TestTelemetryMethodGating(t *testing.T) {
	reg := newRegistry()

	req := httptest.NewRequest(http.MethodGet, "/telemetry", nil)
	rec := httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET /telemetry: want 405, got %d", rec.Code)
	}

	req = httptest.NewRequest(http.MethodOptions, "/telemetry", nil)
	rec = httptest.NewRecorder()
	postOnly(handleTelemetryIngest(reg))(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("OPTIONS /telemetry: want 204, got %d", rec.Code)
	}
}

// ── Storage: eviction, global refusal, TTL sweep ────────────────────────

func TestTelemetryPerPeerEvictionAtNineUploads(t *testing.T) {
	telemetryDir = t.TempDir()
	savedBytes, savedFiles := telemetryUsedBytes, telemetryFiles
	t.Cleanup(func() { telemetryUsedBytes, telemetryFiles = savedBytes, savedFiles })
	telemetryUsedBytes, telemetryFiles = 0, 0

	const peerId = "peer-evict-test-0000000000000000000000000"
	var ids []string
	for i := 0; i < telemetryMaxPerPeer+1; i++ {
		id, status, err := storeTelemetryBundle(peerId, []byte(fmt.Sprintf(`{"n":%d}`, i)))
		if err != nil {
			t.Fatalf("upload %d: %v (status %d)", i, err, status)
		}
		ids = append(ids, id)
		time.Sleep(time.Millisecond) // hex-nanosecond filenames must not collide
	}

	entries, err := os.ReadDir(filepath.Join(telemetryDir, peerId))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != telemetryMaxPerPeer {
		t.Fatalf("peer has %d stored bundles, want the cap of %d", len(entries), telemetryMaxPerPeer)
	}
	if _, err := os.Stat(filepath.Join(telemetryDir, ids[0])); !os.IsNotExist(err) {
		t.Fatalf("oldest upload %s should have been evicted", ids[0])
	}
	if _, err := os.Stat(filepath.Join(telemetryDir, ids[len(ids)-1])); err != nil {
		t.Fatalf("newest upload %s should survive: %v", ids[len(ids)-1], err)
	}
}

func TestTelemetryGlobalRefusalAt507(t *testing.T) {
	telemetryDir = t.TempDir()
	savedBytes, savedFiles := telemetryUsedBytes, telemetryFiles
	t.Cleanup(func() { telemetryUsedBytes, telemetryFiles = savedBytes, savedFiles })
	telemetryUsedBytes, telemetryFiles = telemetryGlobalMaxBytes, 0

	_, status, err := storeTelemetryBundle("peer-global-refusal-0000000000000000000000", []byte(`{"a":1}`))
	if err == nil || status != http.StatusInsufficientStorage {
		t.Fatalf("over the global byte ceiling: got status %d err %v, want 507", status, err)
	}
}

func TestTelemetrySweeperExpiresAgedBundlesAndDecrementsCounters(t *testing.T) {
	telemetryDir = t.TempDir()
	savedBytes, savedFiles := telemetryUsedBytes, telemetryFiles
	t.Cleanup(func() { telemetryUsedBytes, telemetryFiles = savedBytes, savedFiles })
	telemetryUsedBytes, telemetryFiles = 0, 0

	const peerId = "peer-sweep-test-00000000000000000000000000"
	id, status, err := storeTelemetryBundle(peerId, []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("setup upload: %v (status %d)", err, status)
	}
	path := filepath.Join(telemetryDir, id)
	old := time.Now().Add(-telemetryTTL - time.Hour)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}

	if removed := sweepTelemetryOnce(time.Now()); removed != 1 {
		t.Fatalf("swept %d bundle(s), want 1", removed)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("expired bundle should have been removed from disk")
	}
	if telemetryUsedBytes != 0 {
		t.Fatalf("telemetryUsedBytes = %d after sweeping the only bundle, want 0", telemetryUsedBytes)
	}
	if telemetryFiles != 0 {
		t.Fatalf("telemetryFiles = %d after sweeping the only bundle, want 0", telemetryFiles)
	}
}

// ── Operator read routes ─────────────────────────────────────────────────

func TestTelemetryAdminRoutesAbsentWithoutToken(t *testing.T) {
	orig := telemetryAdminToken
	telemetryAdminToken = ""
	t.Cleanup(func() { telemetryAdminToken = orig })
	resetRateLimiter(t)

	req := httptest.NewRequest(http.MethodGet, "/telemetry/list", nil)
	rec := httptest.NewRecorder()
	handleTelemetryList(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/telemetry/list with no admin token: got %d, want 404", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/telemetry/get?id=x/y.json", nil)
	rec = httptest.NewRecorder()
	handleTelemetryGet(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("/telemetry/get with no admin token: got %d, want 404", rec.Code)
	}
}

func TestTelemetryAdminRoutesRejectWrongToken(t *testing.T) {
	orig := telemetryAdminToken
	telemetryAdminToken = "s3cr3t"
	t.Cleanup(func() { telemetryAdminToken = orig })
	resetRateLimiter(t)

	req := httptest.NewRequest(http.MethodGet, "/telemetry/list", nil)
	req.Header.Set("Authorization", "Bearer wrong")
	rec := httptest.NewRecorder()
	handleTelemetryList(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("/telemetry/list with a wrong token: got %d, want 401", rec.Code)
	}
}

func TestTelemetryAdminListAndGetWithRightToken(t *testing.T) {
	telemetryDir = t.TempDir()
	savedBytes, savedFiles := telemetryUsedBytes, telemetryFiles
	t.Cleanup(func() { telemetryUsedBytes, telemetryFiles = savedBytes, savedFiles })
	telemetryUsedBytes, telemetryFiles = 0, 0
	origToken := telemetryAdminToken
	telemetryAdminToken = "s3cr3t"
	t.Cleanup(func() { telemetryAdminToken = origToken })
	resetRateLimiter(t)

	peerId, _ := testPeer(t)
	id, status, err := storeTelemetryBundle(peerId.String(), []byte(`{"a":1}`))
	if err != nil {
		t.Fatalf("setup upload: %v (status %d)", err, status)
	}

	req := httptest.NewRequest(http.MethodGet, "/telemetry/list", nil)
	req.Header.Set("Authorization", "Bearer s3cr3t")
	rec := httptest.NewRecorder()
	handleTelemetryList(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("admin list with the right token: got %d, want 200", rec.Code)
	}
	var body struct {
		Bundles []telemetryBundleInfo `json:"bundles"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	found := false
	for _, b := range body.Bundles {
		if b.ID == id {
			found = true
		}
	}
	if !found {
		t.Fatalf("uploaded bundle %s not in admin list: %+v", id, body.Bundles)
	}

	getReq := httptest.NewRequest(http.MethodGet, "/telemetry/get?id="+id, nil)
	getReq.Header.Set("Authorization", "Bearer s3cr3t")
	getRec := httptest.NewRecorder()
	handleTelemetryGet(getRec, getReq)
	if getRec.Code != http.StatusOK {
		t.Fatalf("admin get with the right token: got %d, want 200", getRec.Code)
	}
	stored, _ := os.ReadFile(filepath.Join(telemetryDir, id))
	if getRec.Body.String() != string(stored) {
		t.Fatal("admin get did not return the stored bundle verbatim")
	}
}

func TestTelemetryAdminGetRejectsTraversal(t *testing.T) {
	telemetryDir = t.TempDir()
	origToken := telemetryAdminToken
	telemetryAdminToken = "s3cr3t"
	t.Cleanup(func() { telemetryAdminToken = origToken })
	resetRateLimiter(t)

	for _, id := range []string{
		"../../../etc/passwd",
		"peer/../../../etc/passwd",
		"peer/sub/dir.json",
		"peer/..%2f..%2fsecret.json",
	} {
		req := httptest.NewRequest(http.MethodGet, "/telemetry/get?id="+url.QueryEscape(id), nil)
		req.Header.Set("Authorization", "Bearer s3cr3t")
		rec := httptest.NewRecorder()
		handleTelemetryGet(rec, req)
		if rec.Code == http.StatusOK {
			t.Fatalf("traversal id %q was served, want a rejection", id)
		}
	}
}

// ── diagRoomRef ───────────────────────────────────────────────────────────

func TestDiagRoomRefStableWithinProcessDiffersAcrossSecrets(t *testing.T) {
	saved := telemetryBootSecret
	t.Cleanup(func() { telemetryBootSecret = saved })

	telemetryBootSecret = []byte("boot-secret-number-one-32-bytes")
	refA1 := diagRoomRef("room-code-abc123")
	refA2 := diagRoomRef("room-code-abc123")
	if refA1 != refA2 {
		t.Fatalf("diagRoomRef is not stable within one process: %q != %q", refA1, refA2)
	}
	if !strings.HasPrefix(refA1, "h:") {
		t.Fatalf("diagRoomRef %q does not carry the h: prefix", refA1)
	}

	telemetryBootSecret = []byte("boot-secret-number-two-32-bytes")
	refB := diagRoomRef("room-code-abc123")
	if refB == refA1 {
		t.Fatal("diagRoomRef did not change across a different boot secret")
	}
}

// ── readLoop exit reasons ─────────────────────────────────────────────────

// eofStream returns io.EOF immediately, the same as a peer that closed its
// write side cleanly.
type eofStream struct{ fakeStream }

func (s *eofStream) Read([]byte) (int, error) { return 0, io.EOF }

// resetErrStream returns a plain, non-timeout, non-EOF error immediately -
// a genuine transport failure.
type resetErrStream struct{ fakeStream }

func (s *resetErrStream) Read([]byte) (int, error) { return 0, errors.New("stream reset by peer") }

// oversizeFrameStream delivers one 4-byte length header over maxMsgLen on
// its first Read, so readLoop's own guard fires without a real oversized
// frame on the wire.
type oversizeFrameStream struct {
	fakeStream
	sent bool
}

func (s *oversizeFrameStream) Read(p []byte) (int, error) {
	s.mu.Lock()
	if !s.sent {
		s.sent = true
		size := maxMsgLen + 1
		header := []byte{byte(size >> 24), byte(size >> 16), byte(size >> 8), byte(size)}
		n := copy(p, header)
		s.mu.Unlock()
		return n, nil
	}
	s.mu.Unlock()
	return s.fakeStream.Read(p)
}

func TestReadLoopRecordsGracefulClose(t *testing.T) {
	enableTelemetry(t)
	r := newRegistry()
	s := &eofStream{}
	c := addClient(r, "peer-diag-graceful", s)

	reason := r.readLoop(s, "peer-diag-graceful", c)
	if reason != relayCloseGraceful {
		t.Fatalf("readLoop reason = %q, want %q", reason, relayCloseGraceful)
	}
	assertLastCloseReason(t, "peer-diag-graceful", relayCloseGraceful)
}

func TestReadLoopRecordsReadErrorClose(t *testing.T) {
	enableTelemetry(t)
	r := newRegistry()
	s := &resetErrStream{}
	c := addClient(r, "peer-diag-read-error", s)

	reason := r.readLoop(s, "peer-diag-read-error", c)
	if reason != relayCloseReadError {
		t.Fatalf("readLoop reason = %q, want %q", reason, relayCloseReadError)
	}
	assertLastCloseReason(t, "peer-diag-read-error", relayCloseReadError)
}

func TestReadLoopRecordsFrameOversizeClose(t *testing.T) {
	enableTelemetry(t)
	r := newRegistry()
	s := &oversizeFrameStream{}
	c := addClient(r, "peer-diag-oversize", s)

	reason := r.readLoop(s, "peer-diag-oversize", c)
	if reason != relayCloseFrameOversize {
		t.Fatalf("readLoop reason = %q, want %q", reason, relayCloseFrameOversize)
	}
	if !s.wasReset() {
		t.Fatal("an oversized frame should reset the stream")
	}
	assertLastCloseReason(t, "peer-diag-oversize", relayCloseFrameOversize)
}

func TestReadLoopRecordsIdleTimeoutClose(t *testing.T) {
	enableTelemetry(t)
	orig := rendezvousIdleTimeout
	rendezvousIdleTimeout = 20 * time.Millisecond
	t.Cleanup(func() { rendezvousIdleTimeout = orig })

	r := newRegistry()
	s := &fakeStream{}
	c := addClient(r, "peer-diag-idle", s)

	var reason string
	done := make(chan struct{})
	go func() {
		reason = r.readLoop(s, "peer-diag-idle", c)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not return once the idle window elapsed")
	}
	if reason != relayCloseIdleTimeout {
		t.Fatalf("readLoop reason = %q, want %q", reason, relayCloseIdleTimeout)
	}
	assertLastCloseReason(t, "peer-diag-idle", relayCloseIdleTimeout)
}

func TestReadLoopRecordsLivenessTimeoutClose(t *testing.T) {
	enableTelemetry(t)
	origIdle, origPing := rendezvousIdleTimeout, rendezvousPingInterval
	rendezvousIdleTimeout = time.Hour // must not be what ends this test
	rendezvousPingInterval = 20 * time.Millisecond
	rendezvousLivenessTimeout = 3 * rendezvousPingInterval
	t.Cleanup(func() {
		rendezvousIdleTimeout = origIdle
		rendezvousPingInterval = origPing
		rendezvousLivenessTimeout = 3 * rendezvousPingInterval
	})

	r := newRegistry()
	s := &registerOnceStream{frame: encodeClientFrame(clientMsg{Type: "REGISTER", Room: "diag-room"})}
	c := addClient(r, "peer-diag-liveness", s)

	var reason string
	done := make(chan struct{})
	go func() {
		reason = r.readLoop(s, "peer-diag-liveness", c)
		close(done)
	}()
	s.waitFrames(t, 1) // the REGISTER's own PEERS reply proves readLoop dispatched it
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not return once the liveness window elapsed")
	}
	if reason != relayCloseLivenessTimeout {
		t.Fatalf("readLoop reason = %q, want %q", reason, relayCloseLivenessTimeout)
	}
	assertLastCloseReason(t, "peer-diag-liveness", relayCloseLivenessTimeout)
}
