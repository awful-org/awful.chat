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

// mailboxGlobalMaxBoxes used to be mailboxGlobalMaxFiles/8: 8192 one-byte
// deposits, about 32 MiB and an eighth of the byte budget, shut the door on
// every NEW recipient for a full TTL while existing boxes kept working. The
// ceiling now tracks the budget it is supposed to measure, and a deposit that
// does meet it reclaims a stale box before refusing.
func TestMailboxBoxCeilingTracksBytesAndEvictsStaleBoxes(t *testing.T) {
	// Reaching the box ceiling has to cost most of the byte budget, not an
	// eighth of it. A box holds at least one blob, and each costs a block.
	if spend := int64(mailboxGlobalMaxBoxes) * mailboxBlockSize; spend*2 < mailboxGlobalMaxBytes {
		t.Errorf("filling every box costs %d bytes, under half the %d-byte budget",
			spend, int64(mailboxGlobalMaxBytes))
	}

	mailboxDir = t.TempDir()
	bytesBefore, filesBefore, boxesBefore := mailboxUsedBytes, mailboxFiles, mailboxBoxes
	t.Cleanup(func() {
		mailboxMu.Lock()
		mailboxUsedBytes, mailboxFiles, mailboxBoxes = bytesBefore, filesBefore, boxesBefore
		mailboxMu.Unlock()
	})

	// One box left sitting past the TTL, which the ceiling may reclaim, and
	// one busy box it must not touch.
	stale, fresh := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, b := range []struct {
		name string
		age  time.Duration
	}{{stale, mailboxTTL + time.Hour}, {fresh, 0}} {
		dir := boxPath(b.name)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		blob := filepath.Join(dir, "1")
		if err := os.WriteFile(blob, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-b.age)
		os.Chtimes(blob, when, when)
		os.Chtimes(dir, when, when)
	}

	mailboxMu.Lock()
	mailboxBoxes = mailboxGlobalMaxBoxes
	mailboxFiles, mailboxUsedBytes = 2, 2*mailboxBlockSize
	mailboxMu.Unlock()

	n := 0
	deposit := func(box string) int {
		n++
		body, _ := json.Marshal(map[string]string{
			"box":  box,
			"blob": base64.StdEncoding.EncodeToString([]byte("hello")),
		})
		req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
		req.RemoteAddr = "10.0.0.1:4000"
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.%d.%d", n/250, n%250))
		w := httptest.NewRecorder()
		handleMailboxDeposit(w, req)
		return w.Code
	}

	did, _ := testDid(t)
	if code := deposit(mailboxIDForDid(did)); code != 204 {
		t.Fatalf("a new recipient was refused at the box ceiling with a stale box to reclaim: %d", code)
	}
	if _, err := os.Stat(boxPath(stale)); !os.IsNotExist(err) {
		t.Error("the stale box was not reclaimed")
	}
	if _, err := os.Stat(boxPath(fresh)); err != nil {
		t.Error("a box still inside its TTL was reclaimed")
	}

	// Nothing left to reclaim, so the ceiling refuses honestly again.
	other, _ := testDid(t)
	if code := deposit(mailboxIDForDid(other)); code != http.StatusInsufficientStorage {
		t.Fatalf("with no stale box left the ceiling returned %d, want 507", code)
	}
}

// The freshness window was symmetric, so a captured did/ts/sig triple stayed
// usable from two minutes before it was signed until two minutes after -
// twice the life the window was meant to grant.
func TestMailboxAuthRejectsFarFutureTimestamps(t *testing.T) {
	did, priv := testDid(t)
	at := func(d time.Duration) (int64, string) {
		ts := time.Now().Add(d).Unix()
		sig := ed25519.Sign(priv, []byte("awful-mailbox:"+strconv.FormatInt(ts, 10)))
		return ts, base64.StdEncoding.EncodeToString(sig)
	}
	verify := func(d time.Duration) error {
		ts, sig := at(d)
		_, err := verifyMailboxAuth(did, ts, sig)
		return err
	}

	// Small clock skew ahead is still fine.
	if err := verify(10 * time.Second); err != nil {
		t.Errorf("a 10s clock skew was rejected: %v", err)
	}
	// A timestamp minted well ahead of now is not.
	if err := verify(mailboxAuthSkew); err == nil {
		t.Error("a timestamp a full skew in the future was accepted")
	}
	// The past window is untouched.
	if err := verify(-mailboxAuthSkew + 10*time.Second); err != nil {
		t.Errorf("a timestamp inside the past window was rejected: %v", err)
	}
}

// deviceID is a stand-in for a libp2p peerId: base58, inside the length band
// the relay accepts.
func deviceID(seed byte) string {
	raw := make([]byte, 34)
	for i := range raw {
		raw[i] = seed + byte(i)
	}
	return base58.Encode(raw)
}

// mailboxClient drives the three endpoints from a fresh client IP each call,
// so a test measures the behaviour under test and not the per-IP limiter.
type mailboxClient struct {
	t    *testing.T
	did  string
	priv ed25519.PrivateKey
	n    int
}

func (m *mailboxClient) request(path string, body any, h http.HandlerFunc) *httptest.ResponseRecorder {
	m.t.Helper()
	m.n++
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
	req.RemoteAddr = "10.0.0.1:4000"
	req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.%d.%d", m.n/250, m.n%250))
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func (m *mailboxClient) deposit(box string, blob []byte) {
	m.t.Helper()
	w := m.request("/mailbox/deposit", map[string]string{
		"box": box, "blob": base64.StdEncoding.EncodeToString(blob),
	}, handleMailboxDeposit)
	if w.Code != 204 {
		m.t.Fatalf("deposit: got %d %s", w.Code, w.Body.String())
	}
}

func (m *mailboxClient) collect(device string) []mailboxEntry {
	m.t.Helper()
	ts, sig := authFields(m.priv)
	w := m.request("/mailbox/collect", map[string]any{
		"did": m.did, "ts": ts, "sig": sig, "device": device,
	}, handleMailboxCollect)
	if w.Code != 200 {
		m.t.Fatalf("collect: got %d %s", w.Code, w.Body.String())
	}
	var out []mailboxEntry
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		m.t.Fatal(err)
	}
	return out
}

func (m *mailboxClient) ack(device string, ids []string) {
	m.t.Helper()
	ts, sig := authFields(m.priv)
	w := m.request("/mailbox/ack", map[string]any{
		"did": m.did, "ts": ts, "sig": sig, "device": device, "ids": ids,
	}, handleMailboxAck)
	if w.Code != 204 {
		m.t.Fatalf("ack: got %d %s", w.Code, w.Body.String())
	}
}

// Two devices on one identity share one box, because the box id is derived
// from the did alone. The first device to ack used to delete the blob, so a
// phone sitting next to an always-on desktop never received its offline DMs.
// A named device acks only for itself, and only TTL frees the blob.
func TestPerDeviceAckKeepsBlobForTheOtherDevices(t *testing.T) {
	mailboxDir = t.TempDir()
	savedBytes, savedFiles, savedBoxes := mailboxUsedBytes, mailboxFiles, mailboxBoxes
	t.Cleanup(func() {
		mailboxUsedBytes, mailboxFiles, mailboxBoxes = savedBytes, savedFiles, savedBoxes
	})
	mailboxUsedBytes, mailboxFiles, mailboxBoxes = 0, 0, 0

	did, priv := testDid(t)
	m := &mailboxClient{t: t, did: did, priv: priv}
	box := mailboxIDForDid(did)
	phone, desktop := deviceID(1), deviceID(90)

	m.deposit(box, []byte("sealed bytes here"))

	pending := m.collect(phone)
	if len(pending) != 1 {
		t.Fatalf("phone collected %d entries, want 1", len(pending))
	}
	id := pending[0].ID
	if len(m.collect(desktop)) != 1 {
		t.Fatal("the desktop should see the same deposit")
	}

	// The desktop acks. The phone's copy has to survive it.
	m.ack(desktop, []string{id})
	if got := m.collect(desktop); len(got) != 0 {
		t.Fatalf("the desktop still sees %d entries it acked", len(got))
	}
	if got := m.collect(phone); len(got) != 1 {
		t.Fatalf("the desktop's ack took the phone's copy: phone sees %d", len(got))
	}

	blobPath := filepath.Join(boxPath(box), id)
	if _, err := os.Stat(blobPath); err != nil {
		t.Fatalf("a per-device ack must not delete the blob: %v", err)
	}

	// Now the phone acks too. Nobody sees it, and it is still on disk waiting
	// for TTL - a device ack is never a delete.
	m.ack(phone, []string{id})
	if got := m.collect(phone); len(got) != 0 {
		t.Fatalf("the phone still sees %d entries it acked", len(got))
	}
	if _, err := os.Stat(blobPath); err != nil {
		t.Fatalf("blob gone after both acks: %v", err)
	}

	// TTL is the only thing left that frees it, and the ack index goes with
	// the last blob it described.
	old := time.Now().Add(-mailboxTTL - time.Hour)
	if err := os.Chtimes(blobPath, old, old); err != nil {
		t.Fatal(err)
	}
	if removed := sweepMailboxOnce(time.Now()); removed != 1 {
		t.Fatalf("sweeper removed %d blob(s), want 1", removed)
	}
	if _, err := os.Stat(blobPath); !os.IsNotExist(err) {
		t.Fatal("an expired blob should be gone from disk")
	}
	if _, err := os.Stat(filepath.Join(boxPath(box), ackIndexName)); !os.IsNotExist(err) {
		t.Fatal("the ack index outlived the last blob it described")
	}
	// Every counter has to be back where it started: the index is charged to
	// the global budget exactly like a blob, so a missed decrement here
	// silently shrinks the ceiling for the life of the process.
	if mailboxUsedBytes != 0 || mailboxFiles != 0 || mailboxBoxes != 0 {
		t.Fatalf("counters left at bytes=%d files=%d boxes=%d, want all zero",
			mailboxUsedBytes, mailboxFiles, mailboxBoxes)
	}
}

// An old client sends no device and must keep the behaviour it was built
// against: ack deletes, for everyone.
func TestAckWithoutDeviceStillDeletes(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	m := &mailboxClient{t: t, did: did, priv: priv}
	box := mailboxIDForDid(did)
	phone := deviceID(7)

	m.deposit(box, []byte("one"))
	pending := m.collect(phone)
	if len(pending) != 1 {
		t.Fatalf("collected %d, want 1", len(pending))
	}
	// The phone acks for itself first, so an index exists to be cleaned up.
	m.ack(phone, []string{pending[0].ID})
	m.ack("", []string{pending[0].ID})

	if _, err := os.Stat(filepath.Join(boxPath(box), pending[0].ID)); !os.IsNotExist(err) {
		t.Fatal("an ack with no device must still delete the blob")
	}
	// The whole box goes, index included - otherwise the directory could
	// never be rmdir'd again.
	if _, err := os.Stat(boxPath(box)); !os.IsNotExist(err) {
		t.Fatal("an emptied box should be removed, ack index and all")
	}
}

// The device string is a map key written to disk, so it is validated before
// anything touches the filesystem.
func TestMailboxRejectsBadDevice(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	m := &mailboxClient{t: t, did: did, priv: priv}

	for _, bad := range []string{"short", strings.Repeat("Q", 65), "has-a-dash-in-it-and-is-long-enough-here", "0OIl" + strings.Repeat("A", 40)} {
		ts, sig := authFields(priv)
		w := m.request("/mailbox/collect", map[string]any{
			"did": did, "ts": ts, "sig": sig, "device": bad,
		}, handleMailboxCollect)
		if w.Code != 400 {
			t.Fatalf("collect with device %q: got %d, want 400", bad, w.Code)
		}
		ts, sig = authFields(priv)
		w = m.request("/mailbox/ack", map[string]any{
			"did": did, "ts": ts, "sig": sig, "device": bad, "ids": []string{},
		}, handleMailboxAck)
		if w.Code != 400 {
			t.Fatalf("ack with device %q: got %d, want 400", bad, w.Code)
		}
	}
}

// The ack index shares the box directory with the blobs. It is not a message,
// so it must not count against the per-box message cap and must never be the
// thing eviction unlinks when the box fills up.
func TestAckIndexIsNotEvictedAsABlob(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	m := &mailboxClient{t: t, did: did, priv: priv}
	box := mailboxIDForDid(did)
	phone := deviceID(30)

	m.deposit(box, []byte("first"))
	first := m.collect(phone)
	m.ack(phone, []string{first[0].ID})

	for i := 0; i < mailboxMaxMsgs+5; i++ {
		m.deposit(box, []byte("filler"))
	}
	blobs := 0
	entries, _ := os.ReadDir(boxPath(box))
	for _, e := range entries {
		if mailboxIDRe.MatchString(e.Name()) {
			blobs++
		}
	}
	if blobs > mailboxMaxMsgs {
		t.Fatalf("box holds %d blobs, over the %d cap", blobs, mailboxMaxMsgs)
	}
	// The evicted blob's device list went with it rather than accumulating.
	idx := readAckIndex(box)
	if _, still := idx[first[0].ID]; still {
		t.Fatal("an evicted blob left its device list behind in the ack index")
	}
}
