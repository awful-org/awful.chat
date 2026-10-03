package main

import (
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// subscribeFrom files one device's subscription as the client at addr,
// through our own proxy, with a fresh rate window so the limiter is never
// what a test ends up measuring.
func subscribeFrom(t *testing.T, addr, did string, priv ed25519.PrivateKey, device string) int {
	t.Helper()
	resetRateLimiter(t)
	req := subscribeBody(did, priv, device, "https://fcm.googleapis.com/fcm/send/"+device).request(t, "/push/subscribe")
	req.RemoteAddr = "10.0.0.1:4000"
	req.Header.Set("X-Forwarded-For", addr)
	w := httptest.NewRecorder()
	handlePushSubscribe(w, req)
	return w.Code
}

func pushBoxOnDisk(box string) bool {
	_, err := os.Stat(pushBoxPath(box))
	return err == nil
}

// dids are free, so the box ceiling alone let one address fill the whole
// store, after which every new identity got 507 for good. One source now
// holds its share and no more; everybody else still gets in.
func TestPushOneSourceHoldsOnlyItsShare(t *testing.T) {
	pushTestSetup(t)
	const attacker = "198.51.100.66"
	device := deviceID(40)

	var firstDid string
	var firstPriv ed25519.PrivateKey
	for i := 0; i < pushMaxBoxesPerSource; i++ {
		did, priv := testDid(t)
		if i == 0 {
			firstDid, firstPriv = did, priv
		}
		if code := subscribeFrom(t, attacker, did, priv, device); code != http.StatusNoContent {
			t.Fatalf("subscribe %d inside the share: %d", i, code)
		}
	}

	did, priv := testDid(t)
	if code := subscribeFrom(t, attacker, did, priv, device); code != http.StatusTooManyRequests {
		t.Fatalf("a source past its share got %d, want 429", code)
	}
	if pushBoxOnDisk(mailboxIDForDid(did)) {
		t.Fatal("a refused subscribe left a box on disk")
	}
	// Refreshing a box it already holds costs nothing.
	if code := subscribeFrom(t, attacker, firstDid, firstPriv, device); code != http.StatusNoContent {
		t.Fatalf("re-subscribing a held box: %d", code)
	}
	// Somebody else is not caught by that share.
	if code := subscribeFrom(t, "198.51.100.67", did, priv, device); code != http.StatusNoContent {
		t.Fatalf("an unrelated source was refused: %d", code)
	}

	// Letting go of a box gives the slot back.
	w := pushRequest(t, "/push/unsubscribe", signedBody{pushActionUnsubscribe, firstDid, firstPriv, map[string]any{"device": device}}, handlePushUnsubscribe)
	if w.Code != http.StatusNoContent {
		t.Fatalf("unsubscribe: %d", w.Code)
	}
	again, againPriv := testDid(t)
	if code := subscribeFrom(t, attacker, again, againPriv, device); code != http.StatusNoContent {
		t.Fatalf("a freed slot was not reusable: %d", code)
	}
}

// One IPv6 /48 is 256 /56 shares. Together they hold ipv6AggregateFactor
// shares, not 256.
func TestPushShareAggregatesIPv6(t *testing.T) {
	pushTestSetup(t)
	device := deviceID(41)

	// Fill the /48's aggregate the slow way would take four thousand
	// subscribes; charge it directly, from one of its /56s.
	probe := httptest.NewRequest("POST", "/push/subscribe", nil)
	probe.RemoteAddr = "10.0.0.1:4000"
	probe.Header.Set("X-Forwarded-For", "2001:db8:0:100::1")
	tags := pushSourceTags(probe)
	if len(tags) != 2 {
		t.Fatalf("an IPv6 source should carry its /56 and its /48, got %d tags", len(tags))
	}
	pushMu.Lock()
	pushHeld[tags[1]] = pushMaxBoxesPerSource*ipv6AggregateFactor - 1
	pushMu.Unlock()

	did, priv := testDid(t)
	if code := subscribeFrom(t, "2001:db8:0:200::1", did, priv, device); code != http.StatusNoContent {
		t.Fatalf("the last slot of the /48: %d", code)
	}
	// Another /56 of the same /48 has a share of its own, but the aggregate
	// is spent.
	did, priv = testDid(t)
	if code := subscribeFrom(t, "2001:db8:0:300::1", did, priv, device); code != http.StatusTooManyRequests {
		t.Fatalf("a /56 inside a spent /48 got %d, want 429", code)
	}
	// Another /48 is not caught by it.
	if code := subscribeFrom(t, "2001:db8:1::1", did, priv, device); code != http.StatusNoContent {
		t.Fatalf("another /48 was refused: %d", code)
	}
	// A proxy-class address is everybody behind it and holds no share.
	withTrustedProxies(t, "")
	behind := httptest.NewRequest("POST", "/push/subscribe", nil)
	behind.RemoteAddr = "172.18.0.9:4000"
	if tags := pushSourceTags(behind); tags != nil {
		t.Fatalf("a proxy's address was given shares: %v", tags)
	}
}

// A full store used to answer every new identity 507. It now sheds the box
// whose devices subscribed longest ago - every unlock subscribes again, so
// that is the identity least in use - and lets the new one in.
func TestPushFullStoreShedsTheBoxSubscribedLongestAgo(t *testing.T) {
	pushTestSetup(t)
	device := deviceID(42)
	type identity struct {
		did  string
		priv ed25519.PrivateKey
		box  string
	}
	mint := func() identity {
		did, priv := testDid(t)
		return identity{did, priv, mailboxIDForDid(did)}
	}
	a, b, c := mint(), mint(), mint()
	for i, id := range []identity{a, b, c} {
		if code := subscribeFrom(t, "203.0.113.1", id.did, id.priv, device); code != http.StatusNoContent {
			t.Fatalf("subscribe %d: %d", i, code)
		}
	}
	// a's device unlocks again, so b is now the one subscribed longest ago.
	if code := subscribeFrom(t, "203.0.113.1", a.did, a.priv, device); code != http.StatusNoContent {
		t.Fatalf("refresh: %d", code)
	}

	pushMu.Lock()
	pushBoxes = pushMaxBoxes
	pushMu.Unlock()

	d := mint()
	if code := subscribeFrom(t, "203.0.113.2", d.did, d.priv, device); code != http.StatusNoContent {
		t.Fatalf("a new identity at the ceiling got %d, want it shedding the oldest box instead", code)
	}
	if pushBoxOnDisk(b.box) {
		t.Fatal("the box subscribed to longest ago was not the one shed")
	}
	for _, id := range []identity{a, c, d} {
		if !pushBoxOnDisk(id.box) {
			t.Fatalf("box %s.. was shed out of order", id.box[:8])
		}
	}
	pushMu.Lock()
	full := pushBoxes
	held := pushHeld
	var heldTotal int
	for _, n := range held {
		heldTotal += n
	}
	pushMu.Unlock()
	if full != pushMaxBoxes {
		t.Fatalf("shedding one box for one new one left the count at %d, want %d", full, pushMaxBoxes)
	}
	// b's source was charged for it and got the slot back with it: three
	// boxes held by 203.0.113.1 and its neighbour, not four.
	if heldTotal != 3 {
		t.Fatalf("shares hold %d boxes after one was shed, want 3", heldTotal)
	}

	// A source past its share is refused before anything is shed for it.
	pushMu.Lock()
	for tag := range pushHeld {
		pushHeld[tag] = pushMaxBoxesPerSource
	}
	pushMu.Unlock()
	e := mint()
	if code := subscribeFrom(t, "203.0.113.2", e.did, e.priv, device); code != http.StatusTooManyRequests {
		t.Fatalf("an over-share source at the ceiling got %d, want 429", code)
	}
	if !pushBoxOnDisk(c.box) {
		t.Fatal("a refused subscribe shed somebody else's box")
	}
}

// pushInitCount counted the boxes back in at every boot, so a full store
// stayed shut across restarts. It now lines them up by file time, and a full
// store sheds the oldest straight after a restart too.
func TestPushStoreShedsByAgeAfterARestart(t *testing.T) {
	pushTestSetup(t)
	if err := os.MkdirAll(pushDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var boxes []string
	for i, age := range []time.Duration{48 * time.Hour, 72 * time.Hour, time.Hour} {
		did, _ := testDid(t)
		box := mailboxIDForDid(did)
		boxes = append(boxes, box)
		pushMu.Lock()
		err := writePushBox(box, map[string]pushSubscription{deviceID(byte(50 + i)): {Endpoint: "https://fcm.googleapis.com/fcm/send/x", P256dh: "k", Auth: "a"}}, false)
		pushMu.Unlock()
		if err != nil {
			t.Fatal(err)
		}
		when := time.Now().Add(-age)
		if err := os.Chtimes(pushBoxPath(box), when, when); err != nil {
			t.Fatal(err)
		}
	}
	// A stray file is not a box and is neither counted nor shed.
	if err := os.WriteFile(pushDir+"/notes.txt", []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}

	pushInitCount() // the restart
	pushMu.Lock()
	counted := pushBoxes
	pushBoxes = pushMaxBoxes
	pushMu.Unlock()
	if counted != 3 {
		t.Fatalf("boot counted %d boxes, want 3", counted)
	}

	did, priv := testDid(t)
	if code := subscribeFrom(t, "203.0.113.5", did, priv, deviceID(60)); code != http.StatusNoContent {
		t.Fatalf("a new identity after a restart into a full store got %d", code)
	}
	if pushBoxOnDisk(boxes[1]) {
		t.Fatal("the oldest box on disk survived; a restart lost the shedding order")
	}
	if !pushBoxOnDisk(boxes[0]) || !pushBoxOnDisk(boxes[2]) {
		t.Fatal("a younger box was shed")
	}
}
