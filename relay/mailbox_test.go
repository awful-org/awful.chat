package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mr-tron/base58"
)

// testDid uses the APP's did form: no multibase 'z'. The spec z-form is
// covered separately in TestDidBothForms.
func testDid(t *testing.T) (string, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	raw := append([]byte{0xed, 0x01}, pub...)
	return "did:key:" + base58.Encode(raw), priv
}

func TestDidBothForms(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	raw := append([]byte{0xed, 0x01}, pub...)
	for _, did := range []string{
		"did:key:" + base58.Encode(raw),
		"did:key:z" + base58.Encode(raw),
	} {
		got, err := didToPubKey(did)
		if err != nil || !bytes.Equal(got, pub) {
			t.Fatalf("%s: %v", did, err)
		}
	}
	if _, err := didToPubKey("did:key:zzzz"); err == nil {
		t.Fatal("garbage did accepted")
	}
}

func authFields(priv ed25519.PrivateKey) (int64, string) {
	ts := time.Now().Unix()
	sig := ed25519.Sign(priv, []byte("awful-mailbox:"+strconv.FormatInt(ts, 10)))
	return ts, base64.StdEncoding.EncodeToString(sig)
}

func TestMailboxRoundTrip(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	blob := []byte("sealed bytes here")

	// Deposit (anonymous).
	depositBody, _ := json.Marshal(map[string]string{
		"box":  box,
		"blob": base64.StdEncoding.EncodeToString(blob),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(depositBody))
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 204 {
		t.Fatalf("deposit: got %d %s", w.Code, w.Body.String())
	}

	// Collect with a valid signature.
	ts, sig := authFields(priv)
	collectBody, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 200 {
		t.Fatalf("collect: got %d %s", w.Code, w.Body.String())
	}
	var got []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(got))
	}
	back, _ := base64.StdEncoding.DecodeString(got[0].Blob)
	if !bytes.Equal(back, blob) {
		t.Fatal("blob mismatch")
	}

	// Ack deletes it.
	ts, sig = authFields(priv)
	ackBody, _ := json.Marshal(map[string]any{
		"did": did, "ts": ts, "sig": sig, "ids": []string{got[0].ID},
	})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(ackBody))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack: got %d", w.Code)
	}

	ts, sig = authFields(priv)
	collectBody, _ = json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var after []mailboxEntry
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if len(after) != 0 {
		t.Fatalf("expected empty after ack, got %d", len(after))
	}
}

func TestMailboxRejectsBadAuthAndOversize(t *testing.T) {
	mailboxDir = t.TempDir()
	did, _ := testDid(t)
	_, otherPriv := func() (string, ed25519.PrivateKey) { return testDid(t) }()

	// Signature from a DIFFERENT key must not open the box.
	ts, sig := authFields(otherPriv)
	body, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req := httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 401 {
		t.Fatalf("wrong-key collect: got %d", w.Code)
	}

	// A stale timestamp is replayable evidence, not auth.
	stale := time.Now().Add(-10 * time.Minute).Unix()
	body, _ = json.Marshal(map[string]any{"did": did, "ts": stale, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	if w.Code != 401 {
		t.Fatalf("stale collect: got %d", w.Code)
	}

	// Oversized blobs are refused outright.
	big := make([]byte, mailboxMaxBlob+1)
	body, _ = json.Marshal(map[string]string{
		"box":  mailboxIDForDid(did),
		"blob": base64.StdEncoding.EncodeToString(big),
	})
	req = httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code == 204 {
		t.Fatal("oversize deposit accepted")
	}
}

func TestMailboxCaps(t *testing.T) {
	mailboxDir = t.TempDir()
	did, _ := testDid(t)
	box := mailboxIDForDid(did)

	// The deposit limiter is per client IP; hand every request its own so
	// this test exercises the CAPS, not the limiter. RemoteAddr has to look
	// like our own proxy or clientIP ignores X-Forwarded-For outright.
	n := 0
	deposit := func(blob []byte) int {
		n++
		body, _ := json.Marshal(map[string]string{
			"box":  box,
			"blob": base64.StdEncoding.EncodeToString(blob),
		})
		req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
		req.RemoteAddr = "10.0.0.1:4000"
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.%d.%d", n/250, n%250))
		w := httptest.NewRecorder()
		handleMailboxDeposit(w, req)
		return w.Code
	}
	onDisk := func() (int, int64) {
		entries, _ := os.ReadDir(boxPath(box))
		var total int64
		for _, e := range entries {
			if info, err := e.Info(); err == nil {
				total += info.Size()
			}
		}
		return len(entries), total
	}

	// A full box must NOT reject: the box id is public and deposits are
	// anonymous, so a 507 here is a stranger closing this user's mailbox.
	// Deposits keep succeeding and the caps hold by eviction instead.
	blob := bytes.Repeat([]byte("x"), 15*1024)
	for i := 0; i < mailboxMaxMsgs+5; i++ {
		if code := deposit(blob); code != 204 {
			t.Fatalf("deposit %d: got %d, want 204", i, code)
		}
		count, total := onDisk()
		if count > mailboxMaxMsgs || total > mailboxMaxBytes {
			t.Fatalf("after deposit %d the box holds %d entries / %d bytes", i, count, total)
		}
	}
	if count, _ := onDisk(); count == 0 {
		t.Fatal("eviction emptied the box instead of making room")
	}

	// Count cap: tiny blobs must stop at mailboxMaxMsgs entries, and the
	// newest deposit has to be the one that survives.
	mailboxDir = t.TempDir()
	for i := 0; i < mailboxMaxMsgs+20; i++ {
		if code := deposit([]byte("s")); code != 204 {
			t.Fatalf("small deposit %d: got %d", i, code)
		}
	}
	count, _ := onDisk()
	if count > mailboxMaxMsgs {
		t.Fatalf("count cap not enforced: %d entries", count)
	}
	newest := []byte("newest")
	if code := deposit(newest); code != 204 {
		t.Fatalf("deposit into a full box: got %d", code)
	}
	found := false
	entries, _ := os.ReadDir(boxPath(box))
	for _, e := range entries {
		b, err := os.ReadFile(filepath.Join(boxPath(box), e.Name()))
		if err == nil && bytes.Equal(b, newest) {
			found = true
		}
	}
	if !found {
		t.Fatal("the newest deposit was the one evicted")
	}

	// Malformed box ids never touch the filesystem.
	body, _ := json.Marshal(map[string]string{
		"box":  "../../etc",
		"blob": base64.StdEncoding.EncodeToString([]byte("x")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 400 {
		t.Fatalf("traversal box id: got %d, want 400", w.Code)
	}
}

// A 1-byte blob still costs a filesystem block and an inode. Charging
// len(blob) let the global ceiling hand out ~4096x the space it was
// measuring, so the charge - and its exact reversal on ack - is the invariant
// that keeps mailboxUsedBytes meaningful over a long-lived process.
func TestMailboxChargesWholeBlocks(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	box := mailboxIDForDid(did)

	bytesBefore, filesBefore, boxesBefore := mailboxUsedBytes, mailboxFiles, mailboxBoxes

	body, _ := json.Marshal(map[string]string{
		"box":  box,
		"blob": base64.StdEncoding.EncodeToString([]byte("t")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.2:4000"
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 204 {
		t.Fatalf("deposit: got %d", w.Code)
	}
	if got := mailboxUsedBytes - bytesBefore; got != mailboxBlockSize {
		t.Fatalf("charged %d bytes for a 1-byte blob, want %d", got, mailboxBlockSize)
	}
	if mailboxFiles-filesBefore != 1 || mailboxBoxes-boxesBefore != 1 {
		t.Fatalf("inode counters wrong: files +%d, boxes +%d", mailboxFiles-filesBefore, mailboxBoxes-boxesBefore)
	}

	ts, sig := authFields(priv)
	collectBody, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var got []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got) != 1 {
		t.Fatalf("collect: %v %d", err, len(got))
	}
	ts, sig = authFields(priv)
	ackBody, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig, "ids": []string{got[0].ID}})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(ackBody))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack: got %d", w.Code)
	}
	if mailboxUsedBytes != bytesBefore || mailboxFiles != filesBefore || mailboxBoxes != boxesBefore {
		t.Fatalf("ack did not reverse the charge: bytes %d->%d, files %d->%d, boxes %d->%d",
			bytesBefore, mailboxUsedBytes, filesBefore, mailboxFiles, boxesBefore, mailboxBoxes)
	}
}

func TestMailboxAckScopedToOwnBox(t *testing.T) {
	mailboxDir = t.TempDir()
	didA, privA := testDid(t)
	didB, privB := testDid(t)

	// One blob in B's box.
	body, _ := json.Marshal(map[string]string{
		"box":  mailboxIDForDid(didB),
		"blob": base64.StdEncoding.EncodeToString([]byte("for B")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.1:4000"
	req.Header.Set("X-Forwarded-For", "203.0.113.8")
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	if w.Code != 204 {
		t.Fatalf("deposit: got %d", w.Code)
	}

	// B learns the entry id.
	ts, sig := authFields(privB)
	body, _ = json.Marshal(map[string]any{"did": didB, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var got []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || len(got) != 1 {
		t.Fatalf("collect for B: %v %d", err, len(got))
	}

	// A acks that id (plus traversal attempts): B's blob must survive.
	ts, sig = authFields(privA)
	body, _ = json.Marshal(map[string]any{
		"did": didA, "ts": ts, "sig": sig,
		"ids": []string{got[0].ID, "../" + mailboxIDForDid(didB) + "/" + got[0].ID, "..", "."},
	})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack as A: got %d", w.Code)
	}

	ts, sig = authFields(privB)
	body, _ = json.Marshal(map[string]any{"did": didB, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxCollect(w, req)
	var after []mailboxEntry
	_ = json.Unmarshal(w.Body.Bytes(), &after)
	if len(after) != 1 {
		t.Fatalf("A's ack removed B's blob: %d entries left", len(after))
	}
}

// Go's crypto/ed25519 accepts small-order public keys: the identity point
// verifies a zero-ish signature over any message. A did:key naming a torsion
// point would therefore authenticate with no private key, and every attacker
// could claim the same did, so verifyMailboxAuth rejects them outright.
// didForRawKey builds the app's did form (no multibase z) for an arbitrary
// public key, including ones no keygen would produce.
func didForRawKey(pub []byte) string {
	raw := append([]byte{0xed, 0x01}, pub...)
	return "did:key:" + base58.Encode(raw)
}

func TestSmallOrderPubKeysRejected(t *testing.T) {
	identityPoint := make([]byte, 32)
	identityPoint[0] = 1
	if !isSmallOrderPubKey(identityPoint) {
		t.Error("identity point not recognised as small order")
	}
	// The forgery the check exists to stop: signature = pubkey || zeros.
	sig := make([]byte, 64)
	copy(sig[:32], identityPoint)
	if !ed25519.Verify(identityPoint, []byte("anything"), sig) {
		t.Skip("stdlib no longer accepts small-order keys; check is now belt and braces")
	}
	did := didForRawKey(identityPoint)
	if _, err := verifyMailboxAuth(did, time.Now().Unix(), base64.StdEncoding.EncodeToString(sig)); err == nil {
		t.Error("small-order did authenticated with a keyless forgery")
	}

	// The two CANONICAL order-8 points. The blocklist this replaced was built
	// from the Curve25519 (Montgomery u-coordinate) small-order list, which is
	// a different curve with a different encoding, so these two - the ones a
	// real attacker reaches for - were not covered at all. Each forged a valid
	// auth for roughly one timestamp in eight, and the identity-point case
	// above passed the whole time, which is why this test now drives every
	// torsion point end to end instead of checking one.
	for _, h := range []string{
		"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
		"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
		"0000000000000000000000000000000000000000000000000000000000000000",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	} {
		raw, err := hex.DecodeString(h)
		if err != nil {
			t.Fatalf("bad test vector %s: %v", h, err)
		}
		if !isSmallOrderPubKey(raw) {
			t.Errorf("%s... not recognised as small order", h[:12])
		}
		// End to end: grind the skew window the way an attacker would, since
		// the cofactored equation only holds for some timestamps.
		forgery := make([]byte, 64)
		copy(forgery[:32], raw)
		encoded := base64.StdEncoding.EncodeToString(forgery)
		torsionDid := didForRawKey(raw)
		now := time.Now().Unix()
		for i := int64(0); i < 64; i++ {
			if _, err := verifyMailboxAuth(torsionDid, now-i, encoded); err == nil {
				t.Fatalf("%s... authenticated a keyless forgery at offset -%d", h[:12], i)
			}
		}
	}

	// A real key must still pass.
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("keygen: %v", err)
	}
	if isSmallOrderPubKey(pub) {
		t.Error("a real public key was flagged small order")
	}
	ts := time.Now().Unix()
	realSig := ed25519.Sign(priv, []byte("awful-mailbox:"+strconv.FormatInt(ts, 10)))
	if _, err := verifyMailboxAuth(didForRawKey(pub), ts, base64.StdEncoding.EncodeToString(realSig)); err != nil {
		t.Errorf("a real keypair was rejected: %v", err)
	}
}

// A deposit that the GLOBAL ceilings refuse must not have destroyed anything
// on the way. Eviction used to run first, so on a saturated instance every
// 507 unlinked one of the recipient's pending offline DMs - a stranger who
// knows a public box id could delete real messages by depositing into a full
// instance, and get a 507 for their trouble.
func TestRefusedDepositDestroysNothing(t *testing.T) {
	mailboxDir = t.TempDir()
	did, _ := testDid(t)
	box := mailboxIDForDid(did)

	n := 0
	deposit := func(blob []byte) int {
		n++
		body, _ := json.Marshal(map[string]string{
			"box":  box,
			"blob": base64.StdEncoding.EncodeToString(blob),
		})
		req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
		req.RemoteAddr = "10.0.0.1:4000"
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.%d.%d", n/250, n%250))
		w := httptest.NewRecorder()
		handleMailboxDeposit(w, req)
		return w.Code
	}

	// Fill the box to its per-recipient message cap so the next deposit is
	// the one that would evict.
	blob := bytes.Repeat([]byte("x"), 1024)
	for i := 0; i < mailboxMaxMsgs; i++ {
		if code := deposit(blob); code != 204 {
			t.Fatalf("setup deposit %d: got %d, want 204", i, code)
		}
	}
	before, _ := os.ReadDir(boxPath(box))
	if len(before) != mailboxMaxMsgs {
		t.Fatalf("setup left %d blobs, want %d", len(before), mailboxMaxMsgs)
	}

	// Saturate the GLOBAL file ceiling, so the next deposit is refused.
	savedFiles := mailboxFiles
	defer func() { mailboxFiles = savedFiles }()
	mailboxFiles = mailboxGlobalMaxFiles

	if code := deposit(blob); code != 507 {
		t.Fatalf("deposit over the global ceiling got %d, want 507", code)
	}
	after, _ := os.ReadDir(boxPath(box))
	if len(after) != len(before) {
		t.Errorf("a refused deposit changed the box: %d blobs before, %d after", len(before), len(after))
	}
}

// base58 decoding is quadratic in its input, and didToPubKey runs on a
// caller-supplied string BEFORE any signature check - so an oversized did was a
// pre-authentication CPU amplifier: ~80 ms burned per request on a 16 KiB did,
// against the few hundred bytes it costs to send one.
func TestOversizedDidIsRejectedCheaply(t *testing.T) {
	long := "did:key:" + strings.Repeat("z", 16300)
	start := time.Now()
	if _, err := didToPubKey(long); err == nil {
		t.Fatal("a 16 KiB did decoded successfully, which it must not")
	}
	if elapsed := time.Since(start); elapsed > 5*time.Millisecond {
		t.Fatalf("rejecting an oversized did took %s; it is being base58-decoded before the length check", elapsed)
	}

	// The real forms must still work, both with and without the multibase 'z'.
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	body := base58.Encode(append([]byte{0xed, 0x01}, pub...))
	for _, did := range []string{"did:key:" + body, "did:key:z" + body} {
		if _, err := didToPubKey(did); err != nil {
			t.Fatalf("didToPubKey(%d-char real did) failed: %v", len(did), err)
		}
	}
}

// An ack request with too many IDs must be rejected. The ack loop does a
// regex match and filesystem stat/remove per ID under the global lock, so an
// unbounded list of duplicate IDs was a lock-hold attack.
func TestAckRejectsOverLongIDList(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)

	// Create valid IDs for acking. Even though the files don't exist, we need
	// valid format for them to pass the regex check inside the loop.
	var ids []string
	for i := 0; i < mailboxMaxAckIDs+10; i++ {
		ids = append(ids, fmt.Sprintf("%032x", i))
	}

	ts, sig := authFields(priv)
	body, _ := json.Marshal(map[string]any{
		"did": did, "ts": ts, "sig": sig, "ids": ids,
	})
	req := httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(body))
	w := httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 400 {
		t.Fatalf("ack with %d IDs: got %d, want 400 (too many ids)", len(ids), w.Code)
	}

	// An ID list exactly at the limit must be accepted.
	ids = ids[:mailboxMaxAckIDs]
	ts, sig = authFields(priv)
	body, _ = json.Marshal(map[string]any{
		"did": did, "ts": ts, "sig": sig, "ids": ids,
	})
	req = httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(body))
	w = httptest.NewRecorder()
	handleMailboxAck(w, req)
	if w.Code != 204 {
		t.Fatalf("ack with %d IDs at limit: got %d, want 204", len(ids), w.Code)
	}
}

// The failure that actually matters is ENOSPC: MkdirAll succeeds, the file IS
// created, and the write then fails, leaving a zero-byte blob the quota
// counters know nothing about. A later collect+ack decrements for that phantom
// blob and drives the counters NEGATIVE, at which point the global ceiling
// stops bounding anything.
//
// The permissions-based version of this test cannot reach that path: a
// read-only directory fails at open(O_CREAT), so nothing is left behind and
// the cleanup never runs - it passed with the fix removed.
func TestFailedWriteLeavesNoPhantomBlob(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	box := mailboxIDForDid(did)

	savedBytes, savedFiles, savedBoxes := mailboxUsedBytes, mailboxFiles, mailboxBoxes
	savedWrite := mailboxWriteFile
	t.Cleanup(func() {
		mailboxUsedBytes, mailboxFiles, mailboxBoxes = savedBytes, savedFiles, savedBoxes
		mailboxWriteFile = savedWrite
	})
	mailboxUsedBytes, mailboxFiles, mailboxBoxes = 0, 0, 0

	// Exactly ENOSPC's shape: the file exists, the write fails.
	mailboxWriteFile = func(name string, _ []byte, perm os.FileMode) error {
		f, err := os.OpenFile(name, os.O_CREATE|os.O_WRONLY, perm)
		if err != nil {
			return err
		}
		f.Close()
		return fmt.Errorf("no space left on device")
	}

	body, _ := json.Marshal(map[string]string{
		"box":  box,
		"blob": base64.StdEncoding.EncodeToString([]byte("doomed")),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.9:4000"
	rec := httptest.NewRecorder()
	handleMailboxDeposit(rec, req)
	if rec.Code == http.StatusNoContent {
		t.Fatal("deposit reported success despite a failed write")
	}

	// Nothing may survive on disk, or the counters and the filesystem disagree.
	if entries, err := os.ReadDir(boxPath(box)); err == nil && len(entries) > 0 {
		t.Fatalf("failed write left %d file(s) behind", len(entries))
	}

	// And the phantom must not be collectable, which is what drove the
	// counters negative.
	mailboxWriteFile = savedWrite
	ts, sig := authFields(priv)
	collectBody, _ := json.Marshal(map[string]any{"did": did, "ts": ts, "sig": sig})
	req = httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(collectBody))
	rec = httptest.NewRecorder()
	handleMailboxCollect(rec, req)
	var collected []mailboxEntry
	_ = json.Unmarshal(rec.Body.Bytes(), &collected)
	if len(collected) != 0 {
		t.Fatalf("collected %d phantom blob(s) from a failed deposit", len(collected))
	}
	if mailboxUsedBytes < 0 || mailboxFiles < 0 || mailboxBoxes < 0 {
		t.Fatalf("counters went negative: bytes %d files %d boxes %d",
			mailboxUsedBytes, mailboxFiles, mailboxBoxes)
	}
}

// The clamp on the ack path is what keeps a counter from going negative, and a
// negative counter silently disables the ceiling it exists to enforce - the
// global budget stops bounding new deposits at all. Nothing exercised it,
// because in every other test the failed-write path leaves nothing on disk to
// collect. Planting a blob directly is how a counter mismatch actually arises:
// a file the counters were never incremented for.
func TestAckNeverDrivesCountersNegative(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	box := mailboxIDForDid(did)

	savedBytes, savedFiles, savedBoxes := mailboxUsedBytes, mailboxFiles, mailboxBoxes
	t.Cleanup(func() {
		mailboxUsedBytes, mailboxFiles, mailboxBoxes = savedBytes, savedFiles, savedBoxes
	})
	mailboxUsedBytes, mailboxFiles, mailboxBoxes = 0, 0, 0

	// A blob on disk that the counters know nothing about.
	if err := os.MkdirAll(boxPath(box), 0o700); err != nil {
		t.Fatal(err)
	}
	id := strconv.FormatInt(time.Now().UnixNano(), 16)
	if err := os.WriteFile(filepath.Join(boxPath(box), id), []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}

	ts, sig := authFields(priv)
	ackBody, _ := json.Marshal(map[string]any{
		"did": did, "ts": ts, "sig": sig, "ids": []string{id},
	})
	req := httptest.NewRequest("POST", "/mailbox/ack", bytes.NewReader(ackBody))
	rec := httptest.NewRecorder()
	handleMailboxAck(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("ack: got %d", rec.Code)
	}

	if mailboxUsedBytes < 0 || mailboxFiles < 0 || mailboxBoxes < 0 {
		t.Fatalf("counters went negative: bytes %d files %d boxes %d",
			mailboxUsedBytes, mailboxFiles, mailboxBoxes)
	}
}
