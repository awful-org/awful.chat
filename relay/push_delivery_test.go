package main

import (
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func resetPushDelivery(t *testing.T) {
	t.Helper()
	pushHostsMu.Lock()
	pushHosts = map[string]*pushHostState{}
	pushHostsMu.Unlock()
	pushBoxFailMu.Lock()
	pushBoxFail = map[string]*pushBoxState{}
	pushBoxFailMu.Unlock()
}

// Only the push services browsers really use, on 443. Any other https url
// let a subscriber aim the relay's POSTs at a server of its choosing - one
// that accepts TLS and never answers held the single push worker hostage.
func TestPushEndpointAllowlist(t *testing.T) {
	cases := map[string]bool{
		"https://fcm.googleapis.com/fcm/send/abc":                true,
		"https://updates.push.services.mozilla.com/wpush/v2/abc": true,
		"https://web.push.apple.com/QGd3":                        true,
		"https://api.push.apple.com/3/device/x":                  true,
		"https://wns2-by3p.notify.windows.com/w/?token=abc":      true,
		"https://fcm.googleapis.com:443/fcm/send/abc":            true,
		"https://fcm.googleapis.com:8443/fcm/send/abc":           false,
		"http://fcm.googleapis.com/fcm/send/abc":                 false,
		"https://evil.example.com/fcm.googleapis.com":            false,
		"https://fcm.googleapis.com.evil.example/x":              false,
		"https://notify.windows.com.evil.example/x":              false,
		"https://push.apple.com/x":                               false, // "*." is a subdomain, not the apex
		"https://user:pw@fcm.googleapis.com/fcm/send/abc":        false,
		"https://evilnotify.windows.com/x":                       false,
	}
	for endpoint, want := range cases {
		if got := validPushEndpoint(endpoint); got != want {
			t.Errorf("%s: allowed=%v, want %v", endpoint, got, want)
		}
	}

	// The operator override replaces the list; "*" is the old behaviour.
	saved := pushAllowedHosts
	defer func() { pushAllowedHosts = saved }()
	pushAllowedHosts = parsePushHosts("push.example.org, *.push.example.net")
	if !validPushEndpoint("https://push.example.org/x") || !validPushEndpoint("https://a.push.example.net/x") {
		t.Error("PUSH_ALLOWED_HOSTS entries not honoured")
	}
	if validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc") {
		t.Error("PUSH_ALLOWED_HOSTS should replace the default list")
	}
	pushAllowedHosts = parsePushHosts("*")
	if !validPushEndpoint("https://anything.example/x") {
		t.Error(`"*" should allow any https host`)
	}
	if got := parsePushHosts(" , "); len(got) != len(defaultPushHosts) {
		t.Error("an empty override should fall back to the defaults")
	}
}

// A push service that has stopped answering takes at most
// pushPerHostConcurrency workers with it, and a wake-up for a device at a
// healthy service still goes out while it hangs.
func TestPushSlowServiceDoesNotStallOthers(t *testing.T) {
	pushTestSetup(t)
	resetPushDelivery(t)
	release := make(chan struct{})
	var hung, fast atomic.Int32
	pushSend = func(sub *webpush.Subscription, payload []byte, opts *webpush.Options) (int, error) {
		if pushEndpointKey(sub.Endpoint) == "*.notify.windows.com" {
			hung.Add(1)
			<-release
			return 201, nil
		}
		fast.Add(1)
		return 201, nil
	}
	// Many boxes, each with one device at the hanging service, delivered by
	// more goroutines than that service has slots.
	var wg sync.WaitGroup
	// Unblock the hung sends and let every delivery finish before this
	// test's directories and seams are torn down under it.
	defer func() { close(release); wg.Wait() }()
	for i := 0; i < pushPerHostConcurrency*3; i++ {
		did, priv := testDid(t)
		box := mailboxIDForDid(did)
		if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, deviceID(byte(40+i)), "https://wns2-by3p.notify.windows.com/w/?token=x"), handlePushSubscribe); w.Code != 204 {
			t.Fatalf("subscribe: %d %s", w.Code, w.Body.String())
		}
		wg.Add(1)
		go func() { defer wg.Done(); pushDeliver(box) }()
	}
	time.Sleep(100 * time.Millisecond)
	if n := hung.Load(); n > pushPerHostConcurrency {
		t.Fatalf("%d sends in flight to one push service, cap is %d", n, pushPerHostConcurrency)
	}

	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, deviceID(99), "https://fcm.googleapis.com/fcm/send/ok"), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("subscribe: %d", w.Code)
	}
	done := make(chan struct{})
	go func() { pushDeliver(box); close(done) }()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("a wake-up to a healthy service waited on a hung one")
	}
	if fast.Load() != 1 {
		t.Fatalf("healthy service got %d sends, want 1", fast.Load())
	}
	// The ones that found no slot give up after pushHostWait instead of
	// queueing forever behind the hung service.
	waited := make(chan struct{})
	go func() { wg.Wait(); close(waited) }()
	select {
	case <-waited:
		t.Fatal("deliveries holding a slot finished while the service still hung")
	case <-time.After(pushHostWait + 500*time.Millisecond):
	}
	if n := hung.Load(); n != pushPerHostConcurrency {
		t.Fatalf("%d sends reached the hung service, want exactly its %d slots", n, pushPerHostConcurrency)
	}
}

// A push service that keeps failing is suspended with backoff, and a box
// whose every device keeps failing is too, instead of both being retried at
// full cost on every deposit.
func TestPushFailingServiceAndBoxBackOff(t *testing.T) {
	pushTestSetup(t)
	resetPushDelivery(t)
	var calls atomic.Int32
	pushSend = func(*webpush.Subscription, []byte, *webpush.Options) (int, error) {
		calls.Add(1)
		return http.StatusServiceUnavailable, nil
	}
	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, deviceID(70), "https://web.push.apple.com/x"), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("subscribe: %d", w.Code)
	}
	for i := 0; i < 20; i++ {
		pushDeliver(box)
	}
	if n := calls.Load(); n != pushBoxFailThreshold {
		t.Fatalf("a failing box was sent to %d times, want it suspended after %d", n, pushBoxFailThreshold)
	}
	if !pushBoxSuspended(box, time.Now()) {
		t.Fatal("box not suspended")
	}

	// The service itself: distinct boxes, one device each, all failing.
	resetPushDelivery(t)
	calls.Store(0)
	for i := 0; i < pushHostFailThreshold*3; i++ {
		d, p := testDid(t)
		b := mailboxIDForDid(d)
		pushRequest(t, "/push/subscribe", subscribeBody(d, p, deviceID(byte(80+i)), "https://web.push.apple.com/y"), handlePushSubscribe)
		pushDeliver(b)
	}
	if n := calls.Load(); n != pushHostFailThreshold {
		t.Fatalf("a failing service got %d sends, want it suspended after %d", n, pushHostFailThreshold)
	}
}
