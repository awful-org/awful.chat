package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// pushTestSetup points the whole surface at temp directories and empties the
// process-wide state these tests would otherwise inherit from each other:
// the queue, the coalescing map, the box counter and the cached VAPID pair.
func pushTestSetup(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	savedDir, savedVapid, savedSend, savedEnabled := pushDir, pushVapidPath, pushSend, pushEnabled
	pushDir = filepath.Join(dir, "push")
	pushVapidPath = filepath.Join(dir, "push-vapid.json")
	pushEnabled = true
	drainPushQueue()
	pushVapidMu.Lock()
	pushVapidCached = nil
	pushVapidMu.Unlock()
	pushMu.Lock()
	pushBoxes = 0
	pushMu.Unlock()
	pushSentMu.Lock()
	pushLastSent = map[string]time.Time{}
	pushLastSwep = time.Time{}
	pushSentMu.Unlock()
	t.Cleanup(func() {
		pushDir, pushVapidPath, pushSend, pushEnabled = savedDir, savedVapid, savedSend, savedEnabled
		drainPushQueue()
	})
}

func drainPushQueue() {
	for {
		select {
		case <-pushQueue:
		default:
			return
		}
	}
}

// fakePushService records what would have gone to a push vendor and answers
// with a status of the test's choosing.
type fakePushService struct {
	mu       sync.Mutex
	status   int
	err      error
	payloads [][]byte
	opts     []webpush.Options
	subs     []webpush.Subscription
}

func (f *fakePushService) install() {
	pushSend = func(sub *webpush.Subscription, payload []byte, opts *webpush.Options) (int, error) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.payloads = append(f.payloads, append([]byte(nil), payload...))
		f.opts = append(f.opts, *opts)
		f.subs = append(f.subs, *sub)
		return f.status, f.err
	}
}

func (f *fakePushService) calls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.payloads)
}

// pushRequest posts a body from a fresh client IP, so the per-IP limiter is
// never what a test ends up measuring.
var pushReqN int

func pushRequest(t *testing.T, path string, body any, h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	pushReqN++
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
	req.RemoteAddr = "10.0.0.1:4000"
	req.Header.Set("X-Forwarded-For", fmt.Sprintf("192.0.%d.%d", pushReqN/250, pushReqN%250))
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func subscribeBody(did string, priv ed25519.PrivateKey, device, endpoint string) map[string]any {
	ts, sig := authFields(priv)
	return map[string]any{
		"did": did, "ts": ts, "sig": sig, "device": device,
		"subscription": map[string]any{
			"endpoint": endpoint,
			"keys":     map[string]string{"p256dh": "BN" + base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{7}, 63)), "auth": base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 16))},
		},
	}
}

func TestPushSubscribeUnsubscribeRoundTrip(t *testing.T) {
	pushTestSetup(t)
	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	device := deviceID(11)
	const endpoint = "https://fcm.googleapis.com/fcm/send/abc123"

	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, device, endpoint), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("subscribe: got %d %s", w.Code, w.Body.String())
	}
	pushMu.Lock()
	subs, existed := readPushBox(box)
	pushMu.Unlock()
	if !existed || subs[device].Endpoint != endpoint {
		t.Fatalf("subscription not stored under the box: %+v", subs)
	}

	// A second subscribe from the same device replaces, never accumulates.
	const moved = "https://updates.push.services.mozilla.com/wpush/v2/xyz"
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, device, moved), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("resubscribe: got %d %s", w.Code, w.Body.String())
	}
	pushMu.Lock()
	subs, _ = readPushBox(box)
	pushMu.Unlock()
	if len(subs) != 1 || subs[device].Endpoint != moved {
		t.Fatalf("resubscribe should replace one device's entry, got %+v", subs)
	}

	ts, sig := authFields(priv)
	w := pushRequest(t, "/push/unsubscribe", map[string]any{
		"did": did, "ts": ts, "sig": sig, "device": device,
	}, handlePushUnsubscribe)
	if w.Code != 204 {
		t.Fatalf("unsubscribe: got %d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(pushBoxPath(box)); !os.IsNotExist(err) {
		t.Fatal("the last device unsubscribing should leave nothing on disk")
	}
}

// Only a holder of the did can file a subscription under its box, and the
// endpoint is checked before anything is stored.
func TestPushSubscribeRejectsBadInput(t *testing.T) {
	pushTestSetup(t)
	did, priv := testDid(t)
	device := deviceID(12)

	bad := subscribeBody(did, priv, device, "http://plaintext.example.com/x")
	if w := pushRequest(t, "/push/subscribe", bad, handlePushSubscribe); w.Code != 400 {
		t.Fatalf("http endpoint: got %d, want 400", w.Code)
	}
	bad = subscribeBody(did, priv, "not-a-peer-id", "https://push.example.com/x")
	if w := pushRequest(t, "/push/subscribe", bad, handlePushSubscribe); w.Code != 400 {
		t.Fatalf("bad device: got %d, want 400", w.Code)
	}
	forged := subscribeBody(did, priv, device, "https://push.example.com/x")
	forged["sig"] = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 64))
	if w := pushRequest(t, "/push/subscribe", forged, handlePushSubscribe); w.Code != 401 {
		t.Fatalf("forged signature: got %d, want 401", w.Code)
	}
}

// A deposit is the only thing that wakes a phone. It must enqueue the
// wake-up and never send it on the request path, and the payload is the whole
// disclosure: "check your box", nothing else.
func TestDepositEnqueuesAContentFreePush(t *testing.T) {
	pushTestSetup(t)
	mailboxDir = t.TempDir()
	fake := &fakePushService{status: 201}
	fake.install()

	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	device := deviceID(13)
	const endpoint = "https://fcm.googleapis.com/fcm/send/wake-me"
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, device, endpoint), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("subscribe: got %d %s", w.Code, w.Body.String())
	}

	m := &mailboxClient{t: t, did: did, priv: priv}
	m.deposit(box, []byte("sealed"))
	if fake.calls() != 0 {
		t.Fatal("a deposit must not talk to a push service on its own request path")
	}

	select {
	case got := <-pushQueue:
		if got != box {
			t.Fatalf("enqueued %q, want the deposited box", got)
		}
	default:
		t.Fatal("a deposit enqueued no wake-up")
	}

	pushDeliver(box)
	if fake.calls() != 1 {
		t.Fatalf("delivered %d pushes, want 1", fake.calls())
	}
	if got := string(fake.payloads[0]); got != `{"t":"mail"}` {
		t.Fatalf("payload %q, want {\"t\":\"mail\"}", got)
	}
	if fake.subs[0].Endpoint != endpoint {
		t.Fatalf("sent to %q, want the subscribed endpoint", fake.subs[0].Endpoint)
	}
	if fake.opts[0].TTL != 86400 {
		t.Fatalf("TTL %d, want 86400", fake.opts[0].TTL)
	}
	if fake.opts[0].Urgency != webpush.UrgencyNormal {
		t.Fatalf("urgency %q, want normal", fake.opts[0].Urgency)
	}
	if fake.opts[0].VAPIDPublicKey == "" || fake.opts[0].VAPIDPrivateKey == "" {
		t.Fatal("the push went out without a VAPID pair")
	}
}

// A busy conversation deposits many blobs a second. The phone collects
// everything waiting when it wakes, so one wake-up per minute is the whole
// benefit and every extra one is battery plus a finer view for the vendor.
func TestPushWakeUpsAreCoalescedPerBox(t *testing.T) {
	pushTestSetup(t)
	box := mailboxIDForDid("did:key:whatever")

	for i := 0; i < 5; i++ {
		pushNotifyBox(box)
	}
	enqueued := 0
	for {
		select {
		case <-pushQueue:
			enqueued++
			continue
		default:
		}
		break
	}
	if enqueued != 1 {
		t.Fatalf("five deposits in one window enqueued %d wake-ups, want 1", enqueued)
	}

	// Once the window has passed the next deposit wakes the device again.
	pushSentMu.Lock()
	pushLastSent[box] = time.Now().Add(-pushCoalesceWindow - time.Second)
	pushSentMu.Unlock()
	pushNotifyBox(box)
	select {
	case <-pushQueue:
	default:
		t.Fatal("no wake-up after the coalescing window elapsed")
	}
}

// 404 and 410 are how a push service says a subscription is dead. Keeping it
// means retrying against that endpoint for as long as the box lives.
func TestPushGoneRemovesTheSubscription(t *testing.T) {
	pushTestSetup(t)
	fake := &fakePushService{status: http.StatusGone}
	fake.install()

	did, priv := testDid(t)
	box := mailboxIDForDid(did)
	device := deviceID(14)
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, device, "https://push.example.com/dead"), handlePushSubscribe); w.Code != 204 {
		t.Fatalf("subscribe: got %d %s", w.Code, w.Body.String())
	}

	pushDeliver(box)
	pushMu.Lock()
	subs, _ := readPushBox(box)
	pushMu.Unlock()
	if len(subs) != 0 {
		t.Fatalf("a 410 left %d subscription(s) in place", len(subs))
	}
	if _, err := os.Stat(pushBoxPath(box)); !os.IsNotExist(err) {
		t.Fatal("the emptied box file should be removed")
	}
}

// PUSH_ENABLED=0 has to leave nothing reachable: config says so, the two
// write routes do not exist, and a deposit enqueues nothing.
func TestPushDisabledAnswersAsSpecified(t *testing.T) {
	pushTestSetup(t)
	pushEnabled = false
	mailboxDir = t.TempDir()

	req := httptest.NewRequest("GET", "/push/config", nil)
	w := httptest.NewRecorder()
	handlePushConfig(w, req)
	if w.Code != 200 {
		t.Fatalf("config while disabled: got %d, want 200", w.Code)
	}
	var cfg map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg["enabled"] != false {
		t.Fatalf("config while disabled: %v", cfg)
	}
	if _, leaked := cfg["publicKey"]; leaked {
		t.Fatal("a disabled instance handed out a VAPID key")
	}

	did, priv := testDid(t)
	device := deviceID(15)
	if w := pushRequest(t, "/push/subscribe", subscribeBody(did, priv, device, "https://push.example.com/x"), handlePushSubscribe); w.Code != 404 {
		t.Fatalf("subscribe while disabled: got %d, want 404", w.Code)
	}
	ts, sig := authFields(priv)
	if w := pushRequest(t, "/push/unsubscribe", map[string]any{
		"did": did, "ts": ts, "sig": sig, "device": device,
	}, handlePushUnsubscribe); w.Code != 404 {
		t.Fatalf("unsubscribe while disabled: got %d, want 404", w.Code)
	}

	m := &mailboxClient{t: t, did: did, priv: priv}
	m.deposit(mailboxIDForDid(did), []byte("sealed"))
	select {
	case got := <-pushQueue:
		t.Fatalf("a disabled instance enqueued a wake-up for %q", got)
	default:
	}
}

// The key pair is what every existing subscription was created against, so it
// has to survive a restart; regenerating it silently breaks all of them.
func TestPushVapidKeysPersist(t *testing.T) {
	pushTestSetup(t)
	first, err := pushKeys()
	if err != nil {
		t.Fatal(err)
	}
	if first.PublicKey == "" || first.PrivateKey == "" {
		t.Fatal("generated an empty VAPID pair")
	}
	info, err := os.Stat(pushVapidPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("push-vapid.json is %v, want 0600", info.Mode().Perm())
	}

	// A restart re-reads the file rather than minting a new pair.
	pushVapidMu.Lock()
	pushVapidCached = nil
	pushVapidMu.Unlock()
	second, err := pushKeys()
	if err != nil {
		t.Fatal(err)
	}
	if second.PublicKey != first.PublicKey {
		t.Fatal("the VAPID public key changed across a reload")
	}
}

// The VAPID subject is a contact a push vendor can reach, and an operator who
// sets neither PUSH_CONTACT nor DOMAIN still needs a well-formed one.
func TestPushSubjectAlwaysHasAScheme(t *testing.T) {
	t.Setenv("PUSH_CONTACT", "ops@example.com")
	if got := pushSubject(); got != "mailto:ops@example.com" {
		t.Fatalf("pushSubject() = %q", got)
	}
	t.Setenv("PUSH_CONTACT", "https://example.com/contact")
	if got := pushSubject(); got != "https://example.com/contact" {
		t.Fatalf("pushSubject() = %q", got)
	}
	t.Setenv("PUSH_CONTACT", "")
	if got := pushSubject(); got != "mailto:admin@example.invalid" && got != "mailto:admin@"+domain {
		t.Fatalf("pushSubject() = %q with no contact set", got)
	}
}
