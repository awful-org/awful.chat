package main

// Offline DM mailbox: store-and-forward for end-to-end encrypted blobs.
//
// The relay NEVER sees plaintext or sender identity. A sender seals the DM
// envelope to the recipient's key client-side (ephemeral-static ECDH, so no
// prior handshake and nothing in the blob names the sender) and deposits it
// under the recipient's mailbox id = SHA-256(recipient did). The recipient
// collects by proving control of the did with an ed25519 signature over a
// fresh timestamp, then acks; acked blobs are deleted immediately and
// unclaimed ones expire after MailboxTTL.
//
// What the relay learns: recipient mailbox, deposit times, padded sizes,
// depositor IP. What it cannot learn: content, sender identity.
//
// Kept deliberately small: DMs only, text-scale blobs (files ride WebTorrent
// peer-to-peer and are never deposited), hard caps everywhere.

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"filippo.io/edwards25519"
	"github.com/mr-tron/base58"
)

const (
	// One sealed text DM is a few hundred bytes; 16 KiB leaves room for
	// padding buckets and replies-with-context while keeping the server
	// footprint minimal. Anything bigger retries peer-to-peer instead.
	mailboxMaxBlob = 16 * 1024
	// Per-mailbox caps: count and total bytes.
	mailboxMaxMsgs  = 100
	mailboxMaxBytes = 512 * 1024
	// Unclaimed blobs expire; the P2P offline queue still retries forever,
	// so expiry only delays delivery until both sides co-online.
	mailboxTTL = 48 * time.Hour
	// Signed-timestamp freshness window for collect/ack.
	mailboxAuthSkew = 2 * time.Minute
	// Hard ceiling on everything under mailboxDir combined. Per-IP limits
	// mean nothing to a distributed depositor; without a global cap the
	// shared data volume could be filled without bound.
	mailboxGlobalMaxBytes = 256 << 20
	// Blobs are charged their real cost, not their logical length. A 1-byte
	// deposit still consumes a filesystem block and an inode, so counting
	// len(blob) alone let a flood of tiny blobs occupy ~4096x the space the
	// global counter thought it had handed out - the ceiling above measured
	// the one resource the attack does not spend.
	mailboxBlockSize = 4096
	// Inodes are exhaustible independently of bytes. With the block charge
	// these are close to what the byte ceiling already implies; they are
	// counted explicitly so that raising mailboxGlobalMaxBytes, or ever
	// dropping the charge, cannot quietly unbound file and directory creation.
	mailboxGlobalMaxFiles = mailboxGlobalMaxBytes / mailboxBlockSize
	mailboxGlobalMaxBoxes = mailboxGlobalMaxFiles / 8
	// Deposit/collect/ack per-IP budgets. Deposits get their own bucket so a
	// chatty plugin proxying data does not starve offline DMs (and vice
	// versa); collect+ack were previously unlimited, a free CPU/verify sink.
	mailboxDepositLimit = 10
	mailboxAuthedLimit  = 30
	// Maximum IDs one ack request may carry. A real client acks what it just
	// collected, which is a small number bounded by mailboxMaxMsgs. This limit
	// leaves clear headroom and prevents the ack loop from doing unbounded
	// filesystem syscalls under the global lock.
	mailboxMaxAckIDs = 256
)

var mailboxDir = func() string {
	if d := os.Getenv("MAILBOX_DIR"); d != "" {
		return d
	}
	return "/app/data/mailbox"
}()

var mailboxBoxRe = regexp.MustCompile(`^[0-9a-f]{64}$`)
var mailboxIDRe = regexp.MustCompile(`^[0-9a-f]{1,32}$`)

// mailboxMu serializes writes per process - deposit volume is tiny and a
// single lock keeps the quota check race-free.
var mailboxMu sync.Mutex

// didToPubKey decodes a did:key to the raw ed25519 public key. The app's
// identity layer encodes WITHOUT the multibase 'z' (did:key:<base58> of
// 0xed01||pub) - requiring the spec's z-form made every real client's
// collect/ack fail 401. Accept both, disambiguating by decode: 'z' is a
// valid base58 character, so only a successful 34-byte 0xed01 decode says
// which form this is.
// mailboxWriteFile is os.WriteFile behind a seam. The failure this exists to
// cover is ENOSPC, where the file IS created and the write then fails, leaving
// a zero-byte blob that the quota counters know nothing about. That shape
// cannot be produced with permissions - a read-only directory fails at
// open(O_CREAT) and leaves nothing behind - so a test that wants the cleanup
// path has to substitute the failure here.
var mailboxWriteFile = os.WriteFile

func didToPubKey(did string) (ed25519.PublicKey, error) {
	const prefix = "did:key:"
	if !strings.HasPrefix(did, prefix) {
		return nil, fmt.Errorf("not a did:key")
	}
	body := did[len(prefix):]
	// base58 decoding is quadratic in the input length, and this runs BEFORE
	// any signature check on a caller-supplied string - a 16 KiB did burned
	// 80 ms of CPU per request, and twice over, since both candidate encodings
	// are tried. A real did:key body is 48-49 characters; 64 leaves room for
	// other multicodecs without leaving a CPU amplifier in front of the gate.
	if len(body) > 64 {
		return nil, fmt.Errorf("did too long")
	}
	for _, s := range []string{body, strings.TrimPrefix(body, "z")} {
		raw, err := base58.Decode(s)
		if err == nil && len(raw) == 34 && raw[0] == 0xed && raw[1] == 0x01 {
			return ed25519.PublicKey(raw[2:]), nil
		}
	}
	return nil, fmt.Errorf("not an ed25519 did:key")
}

func mailboxIDForDid(did string) string {
	sum := sha256.Sum256([]byte(did))
	return hex.EncodeToString(sum[:])
}

// verifyMailboxAuth checks the collect/ack proof: an ed25519 signature by
// the did's key over "awful-mailbox:{unix-seconds}", fresh within the skew.
// The canonical and non-canonical encodings of the eight ed25519 points with
// order dividing 8. Rejecting them is what libsodium does and what
// RFC8032-strict verifiers do; Go's stdlib does neither.

// isSmallOrderPubKey reports whether pub is one of the ed25519 points of order
// dividing 8, for which a signature proves nothing.
func isSmallOrderPubKey(pub []byte) bool {
	// A real subgroup check rather than a list of known-bad encodings. The
	// list this replaces was written from the CURVE25519 (Montgomery
	// u-coordinate) blocklist used by Signal and WireGuard, but a did:key
	// carries an ed25519 y-coordinate - a different curve with a different
	// encoding - so those bytes could never match a real key and the two
	// canonical ed25519 order-8 points went straight through. Verified: both
	// 0xc7176a70... and 0x26e8958f... forged a valid mailbox auth against
	// Go's ed25519 for roughly one timestamp in eight.
	//
	// A point has order dividing 8 exactly when [8]A is the identity, which
	// MultByCofactor computes directly. That catches all eight torsion points
	// at once, including non-canonical encodings of them, and cannot drift out
	// of date the way a hand-kept list did.
	p, err := new(edwards25519.Point).SetBytes(pub)
	if err != nil {
		// Not a valid point encoding at all, so not a usable identity either.
		return true
	}
	return new(edwards25519.Point).MultByCofactor(p).Equal(edwards25519.NewIdentityPoint()) == 1
}

func verifyMailboxAuth(did string, ts int64, sigB64 string) (string, error) {
	if d := time.Since(time.Unix(ts, 0)); d > mailboxAuthSkew || d < -mailboxAuthSkew {
		return "", fmt.Errorf("stale timestamp")
	}
	pub, err := didToPubKey(did)
	if err != nil {
		return "", err
	}
	sig, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return "", err
	}
	// Go's crypto/ed25519 accepts small-order public keys (verified: the
	// identity point verifies a zero-ish signature over any message), so a
	// did:key naming a torsion point would authenticate without anybody
	// holding a private key - and every attacker could claim that same did.
	// A did has to prove key possession or it is not an identity.
	if isSmallOrderPubKey(pub) {
		return "", fmt.Errorf("small-order public key")
	}
	msg := []byte("awful-mailbox:" + strconv.FormatInt(ts, 10))
	if !ed25519.Verify(pub, msg, sig) {
		return "", fmt.Errorf("bad signature")
	}
	return mailboxIDForDid(did), nil
}

func mailboxCORS(w http.ResponseWriter, r *http.Request) bool {
	h := corsHeaders(r)
	h.Set("Access-Control-Allow-Methods", "POST,OPTIONS")
	for k, v := range h {
		w.Header()[k] = v
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return false
	}
	return true
}

type mailboxEntry struct {
	ID   string `json:"id"`
	Blob string `json:"blob"` // base64
	Ts   int64  `json:"ts"`   // deposit unix seconds
}

func boxPath(box string) string { return filepath.Join(mailboxDir, box) }

// mailboxUsedBytes tracks the global quota incrementally: a full-tree walk
// per deposit was tens of thousands of syscalls under mailboxMu at scale,
// serializing every deposit and ack behind disk I/O. One walk at startup
// (mailboxInitUsedBytes, before the sweeper loop), then deposits add and
// removals subtract. mailboxFiles and mailboxBoxes track the inode side of
// the same budget. All three are guarded by mailboxMu like everything else
// here, and every one of them must be adjusted at every removal site.
var (
	mailboxUsedBytes int64
	mailboxFiles     int
	mailboxBoxes     int
)

// mailboxCharge is what a blob costs the global budget: at least one
// filesystem block, whatever its logical length.
func mailboxCharge(size int64) int64 {
	if size < mailboxBlockSize {
		return mailboxBlockSize
	}
	return size
}

func mailboxInitUsedBytes() {
	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	mailboxUsedBytes = 0
	mailboxFiles = 0
	mailboxBoxes = 0
	boxes, _ := os.ReadDir(mailboxDir)
	for _, b := range boxes {
		if !b.IsDir() {
			continue
		}
		mailboxBoxes++
		entries, _ := os.ReadDir(filepath.Join(mailboxDir, b.Name()))
		for _, e := range entries {
			if info, err := e.Info(); err == nil {
				mailboxUsedBytes += mailboxCharge(info.Size())
				mailboxFiles++
			}
		}
	}
}

// handleMailboxDeposit stores one sealed blob. Anonymous by design; only
// rate limits and caps stand between it and abuse.
func handleMailboxDeposit(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("mb:"+clientIP(r), mailboxDepositLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Box  string `json:"box"`
		Blob string `json:"blob"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, mailboxMaxBlob*2)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxBoxRe.MatchString(req.Box) {
		http.Error(w, "bad mailbox", http.StatusBadRequest)
		return
	}
	blob, err := base64.StdEncoding.DecodeString(req.Blob)
	if err != nil || len(blob) == 0 || len(blob) > mailboxMaxBlob {
		http.Error(w, "bad blob", http.StatusBadRequest)
		return
	}

	mailboxMu.Lock()
	defer mailboxMu.Unlock()
	dir := boxPath(req.Box)
	// Stat before MkdirAll: a box that does not exist yet costs a directory,
	// and that has to be refused before it is created, not after.
	newBox := false
	if _, err := os.Stat(dir); err != nil {
		newBox = true
		if mailboxBoxes >= mailboxGlobalMaxBoxes {
			http.Error(w, "mailbox full", http.StatusInsufficientStorage)
			return
		}
	}

	type storedBlob struct {
		name string
		size int64
		mod  time.Time
	}
	var stored []storedBlob
	var total int64
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		stored = append(stored, storedBlob{name: e.Name(), size: info.Size(), mod: info.ModTime()})
		total += info.Size()
	}
	// Tie-broken by name because not every filesystem carries sub-second
	// mtimes, and ids are hex nanoseconds of the same width, so the name
	// ordering is the deposit ordering whenever the timestamps collide.
	sort.Slice(stored, func(i, j int) bool {
		if stored[i].mod.Equal(stored[j].mod) {
			return stored[i].name < stored[j].name
		}
		return stored[i].mod.Before(stored[j].mod)
	})

	// STORE FIRST, evict after. The global ceilings below are refusals, and
	// evicting before them meant a deposit that was ultimately refused had
	// already unlinked one of the recipient's pending messages: on a
	// saturated instance every 507 destroyed a real offline DM for a named
	// user whose box id is public. Nothing is removed now until the new blob
	// is safely on disk, so the box can exceed its cap by one blob for the
	// few microseconds in between, which costs nothing.
	charge := mailboxCharge(int64(len(blob)))
	if mailboxUsedBytes+charge > mailboxGlobalMaxBytes || mailboxFiles >= mailboxGlobalMaxFiles {
		http.Error(w, "mailbox full", http.StatusInsufficientStorage)
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	id := strconv.FormatInt(time.Now().UnixNano(), 16)
	if err := mailboxWriteFile(filepath.Join(dir, id), blob, 0o600); err != nil {
		// A failed write leaves a partial file on disk. Remove it and the
		// directory if this deposit created it, so the on-disk state matches
		// the quota counters which were not incremented.
		_ = os.Remove(filepath.Join(dir, id))
		if newBox {
			_ = os.Remove(dir)
		}
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	if newBox {
		mailboxBoxes++
	}
	mailboxFiles++
	mailboxUsedBytes += charge
	total += int64(len(blob))

	// A full box evicts its OLDEST blob rather than refusing the new one. The
	// box id is public - SHA-256 of the recipient did, which the frontend
	// derives the same way - and deposits are anonymous by design, so
	// refusing would let anyone permanently close one NAMED user's offline
	// delivery by parking 100 blobs in it. Eviction costs nothing that is not
	// recoverable: the mailbox is only a latency shortcut, and the sender's
	// P2P offline queue keeps the message and retries regardless.
	evicted := 0
	for len(stored) > 0 &&
		(len(stored)+1 > mailboxMaxMsgs || total > mailboxMaxBytes) {
		oldest := stored[0]
		stored = stored[1:]
		if os.Remove(filepath.Join(dir, oldest.name)) == nil {
			total -= oldest.size
			mailboxUsedBytes -= mailboxCharge(oldest.size)
			mailboxFiles--
			evicted++
		}
	}
	if evicted > 0 {
		log.Printf("[mailbox] evicted %d blob(s) from a full box", evicted)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleMailboxCollect returns every pending blob for the proven did.
func handleMailboxCollect(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	// Unlimited, these endpoints were a free signature-verification and
	// ReadDir sink for anyone with curl. 30/min covers the 5-minute collect
	// loop plus its acks many times over.
	if !rateAllow("mba:"+clientIP(r), mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did string `json:"did"`
		Ts  int64  `json:"ts"`
		Sig string `json:"sig"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	entries, _ := os.ReadDir(boxPath(box))
	out := []mailboxEntry{}
	for _, e := range entries {
		if !mailboxIDRe.MatchString(e.Name()) {
			continue
		}
		blob, err := os.ReadFile(filepath.Join(boxPath(box), e.Name()))
		if err != nil {
			continue
		}
		ts := int64(0)
		if info, err := e.Info(); err == nil {
			ts = info.ModTime().Unix()
		}
		out = append(out, mailboxEntry{
			ID:   e.Name(),
			Blob: base64.StdEncoding.EncodeToString(blob),
			Ts:   ts,
		})
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

// handleMailboxAck deletes collected blobs for the proven did.
func handleMailboxAck(w http.ResponseWriter, r *http.Request) {
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("mba:"+clientIP(r), mailboxAuthedLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did string   `json:"did"`
		Ts  int64    `json:"ts"`
		Sig string   `json:"sig"`
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	// Validate and bound the ID list before taking the lock. This is cheap
	// work (regex) that every other mailbox operation needs, and doing it
	// outside the lock means the lock holds only for real filesystem work.
	if len(req.IDs) > mailboxMaxAckIDs {
		http.Error(w, "too many ids", http.StatusBadRequest)
		return
	}
	var validIDs []string
	for _, id := range req.IDs {
		if mailboxIDRe.MatchString(id) {
			validIDs = append(validIDs, id)
		}
	}
	// Under mailboxMu: the empty-directory Remove racing a concurrent
	// deposit's ReadDir->WriteFile window turned that deposit into a
	// spurious 500 (WriteFile into a just-removed directory).
	mailboxMu.Lock()
	for _, id := range validIDs {
		p := filepath.Join(boxPath(box), id)
		if info, err := os.Stat(p); err == nil && os.Remove(p) == nil {
			charge := mailboxCharge(info.Size())
			// Prevent counters from going negative. A counter that can go
			// negative silently disables the ceiling it exists to enforce -
			// the global budget would no longer bound new deposits.
			if mailboxUsedBytes >= charge {
				mailboxUsedBytes -= charge
			}
			if mailboxFiles > 0 {
				mailboxFiles--
			}
		}
	}
	if os.Remove(boxPath(box)) == nil { // succeeds only when empty
		if mailboxBoxes > 0 {
			mailboxBoxes--
		}
	}
	mailboxMu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

// startMailboxSweeper expires unclaimed blobs. Runs hourly; a restart
// changes nothing because the state is plain files under the data volume.
func startMailboxSweeper() {
	mailboxInitUsedBytes()
	go func() {
		for {
			cutoff := time.Now().Add(-mailboxTTL)
			boxes, _ := os.ReadDir(mailboxDir)
			removed := 0
			for _, b := range boxes {
				dir := filepath.Join(mailboxDir, b.Name())
				// Same deposit-vs-remove race as ack: the empty-dir Remove
				// must not land inside a deposit's quota-check window.
				mailboxMu.Lock()
				entries, _ := os.ReadDir(dir)
				for _, e := range entries {
					if info, err := e.Info(); err == nil && info.ModTime().Before(cutoff) {
						if os.Remove(filepath.Join(dir, e.Name())) == nil {
							mailboxUsedBytes -= mailboxCharge(info.Size())
							mailboxFiles--
						}
						removed++
					}
				}
				if os.Remove(dir) == nil { // only if empty
					mailboxBoxes--
				}
				mailboxMu.Unlock()
			}
			if removed > 0 {
				log.Printf("[mailbox] expired %d blob(s)", removed)
			}
			time.Sleep(time.Hour)
		}
	}()
}
