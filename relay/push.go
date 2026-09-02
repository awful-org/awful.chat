package main

// Content-free Web Push: waking a device that has offline mail.
//
// A phone's app is closed most of the day. DMs reach it through the mailbox
// (mailbox.go), and nothing else in this system can wake it, so a message
// sat there until the user happened to open the app. The relay already
// learns THAT a box has mail - that is the one fact a deposit tells it
// (docs/spec.md, "Server Privacy") - and that one fact is all it forwards.
//
// WHAT THE RELAY NOW HOLDS. For each subscribed device: a push endpoint URL
// at a push vendor (Google, Mozilla, Apple) plus the two public keys the
// payload is encrypted to, filed under the same box id the mailbox uses -
// SHA-256 of the recipient did. A push endpoint is a STABLE PER-DEVICE
// IDENTIFIER issued by a third party: while the subscription lives it links
// that device to that identity, and the vendor sees every wake-up the relay
// sends. This is new disclosure, it is per device and opt-in, and
// /push/unsubscribe deletes it.
//
// WHAT THE RELAY SENDS. The whole message is {"t":"mail"} - "check your
// box". No sender, no room, no count, no content, and at most one per box
// per minute, so the wake-up stream is not a finer traffic-analysis channel
// than the deposit stream a push service would already see. Everything real
// stays sealed in the mailbox blob the device collects once it is awake.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

const (
	// Per-IP budget, matching the authed mailbox routes: subscribing is a
	// signature verification plus a small write, the same shape of work.
	pushRateLimit = 30
	// One subscription per device, and a box is one identity. Sixteen is well
	// past a real person's device count and keeps the stored file small.
	pushMaxDevices = 16
	// A push endpoint is a vendor URL; 2 KiB is far more than any of them
	// issue and bounds what an authenticated caller can park on disk.
	pushMaxEndpoint = 2048
	// p256dh is 88 base64url characters and auth is 24. The cap is only here
	// so the stored file cannot be padded out.
	pushMaxKeyLen = 256
	// At most one wake-up per box per window. A deposit inside it sends
	// nothing on purpose: the device collects EVERYTHING waiting when it
	// wakes, so a second push would cost battery and tell the push vendor
	// more about this box's traffic than it needs to know.
	pushCoalesceWindow = time.Minute
	// One worker drains this. A burst that outruns delivery drops wake-ups
	// rather than growing without bound - the mailbox still holds the
	// message, and the next deposit or foreground collect finds it.
	pushQueueDepth = 1024
	// Seconds a push service should hold an undelivered wake-up. A day, so a
	// phone that was off overnight still gets told once it is back.
	pushTTL = 86400
	// Boxes holding subscriptions. Subscribing needs a did signature, but
	// dids are free to mint, so without a ceiling this is an unbounded
	// on-disk sink for anyone with curl - the same reasoning as
	// mailboxGlobalMaxBoxes.
	pushMaxBoxes = 65536
)

// pushPayload is the entire message. Byte-for-byte what the frontend's
// service worker matches on; see the privacy note above before adding to it.
var pushPayload = []byte(`{"t":"mail"}`)

// pushEnabled gates everything here. Default ON: the mailbox is useless to a
// phone without it. PUSH_ENABLED=0 makes /push/config answer enabled:false,
// the other two routes 404, and deposits enqueue nothing. A package var, not
// a const, so a test can flip it like telemetryEnabled.
var pushEnabled = os.Getenv("PUSH_ENABLED") != "0"

var pushDir = func() string {
	if d := os.Getenv("PUSH_DIR"); d != "" {
		return d
	}
	return "/app/data/push"
}()

// pushVapidPath holds the instance's VAPID pair. Persisted like relay.key and
// for the same reason: the public half is baked into every subscription a
// browser has already created, so regenerating it silently breaks all of them.
var pushVapidPath = "/app/data/push-vapid.json"

type vapidKeys struct {
	PublicKey  string `json:"publicKey"`
	PrivateKey string `json:"privateKey"`
}

// pushSubscription is one device's half of a Web Push subscription, exactly
// the fields the browser hands the page.
type pushSubscription struct {
	Endpoint string `json:"endpoint"`
	P256dh   string `json:"p256dh"`
	Auth     string `json:"auth"`
	Ts       int64  `json:"ts"` // subscribed unix seconds, for oldest-first eviction
}

var (
	// pushMu guards the on-disk subscription store and pushBoxes, the same
	// single-lock shape mailboxMu uses: the write volume is tiny and one lock
	// keeps the ceiling check race-free.
	pushMu    sync.Mutex
	pushBoxes int

	pushVapidMu     sync.Mutex
	pushVapidCached *vapidKeys

	pushSentMu   sync.Mutex
	pushLastSent = map[string]time.Time{}
	pushLastSwep time.Time
)

var pushQueue = make(chan string, pushQueueDepth)

// One client for every push send, over the SSRF-safe transport the proxies
// share (see pluginProxyTransport): a subscription endpoint is attacker
// input, and a push service that hangs must not hold the worker forever.
var pushHTTPClient = &http.Client{Timeout: 15 * time.Second, Transport: pluginProxyTransport}

// pushSend is the one outbound call to a push service, behind a package-level
// seam so a test can see what would go over the wire without one. It returns
// the status code because 404 and 410 are how a push service says the
// subscription is dead, and the caller acts on that.
var pushSend = func(sub *webpush.Subscription, payload []byte, opts *webpush.Options) (int, error) {
	resp, err := webpush.SendNotification(payload, sub, opts)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	// Drain a bounded amount so the connection can be reused; the body is
	// never useful and a hostile one could be large.
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, nil
}

// pushSubject is the VAPID "sub" claim - a contact a push vendor can reach if
// this instance misbehaves. RFC 8292 wants a mailto: or https: URI, so a bare
// address is prefixed rather than sent as an invalid claim.
func pushSubject() string {
	c := strings.TrimSpace(os.Getenv("PUSH_CONTACT"))
	if c == "" {
		if domain != "" {
			return "mailto:admin@" + domain
		}
		// .invalid is reserved and can never resolve, which is the honest
		// answer for an instance that named no domain and no contact.
		return "mailto:admin@example.invalid"
	}
	if !strings.Contains(c, ":") {
		return "mailto:" + c
	}
	return c
}

// pushKeys returns this instance's VAPID pair, generating and persisting it on
// first use.
func pushKeys() (*vapidKeys, error) {
	pushVapidMu.Lock()
	defer pushVapidMu.Unlock()
	if pushVapidCached != nil {
		return pushVapidCached, nil
	}
	if data, err := os.ReadFile(pushVapidPath); err == nil {
		var k vapidKeys
		if json.Unmarshal(data, &k) == nil && k.PublicKey != "" && k.PrivateKey != "" {
			pushVapidCached = &k
			return pushVapidCached, nil
		}
	}
	priv, pub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		return nil, err
	}
	k := &vapidKeys{PublicKey: pub, PrivateKey: priv}
	data, err := json.Marshal(k)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(pushVapidPath), 0o700); err != nil {
		return nil, err
	}
	// 0600 like relay.key: the private half signs every VAPID header this
	// instance sends.
	if err := os.WriteFile(pushVapidPath, data, 0o600); err != nil {
		return nil, err
	}
	pushVapidCached = k
	return k, nil
}

// ── Store ─────────────────────────────────────────────────────────────────

func pushBoxPath(box string) string { return filepath.Join(pushDir, box+".json") }

// readPushBox returns a box's device map and whether a file backed it. Caller
// holds pushMu.
func readPushBox(box string) (map[string]pushSubscription, bool) {
	data, err := os.ReadFile(pushBoxPath(box))
	if err != nil {
		return map[string]pushSubscription{}, false
	}
	devices := map[string]pushSubscription{}
	if json.Unmarshal(data, &devices) != nil {
		return map[string]pushSubscription{}, true
	}
	return devices, true
}

// writePushBox persists a box, removing the file once no device is left so an
// unsubscribed identity leaves nothing behind. Caller holds pushMu.
func writePushBox(box string, devices map[string]pushSubscription, existed bool) error {
	if len(devices) == 0 {
		if existed && os.Remove(pushBoxPath(box)) == nil && pushBoxes > 0 {
			pushBoxes--
		}
		return nil
	}
	data, err := json.Marshal(devices)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(pushDir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(pushBoxPath(box), data, 0o600); err != nil {
		return err
	}
	if !existed {
		pushBoxes++
	}
	return nil
}

// pushInitCount counts the boxes already on disk, so the ceiling survives a
// restart. Runs once at boot, like mailboxInitUsedBytes.
func pushInitCount() {
	pushMu.Lock()
	defer pushMu.Unlock()
	pushBoxes = 0
	entries, _ := os.ReadDir(pushDir)
	for _, e := range entries {
		if !e.IsDir() {
			pushBoxes++
		}
	}
}

// pushRemoveDevices drops subscriptions a push service has told us are dead.
func pushRemoveDevices(box string, devices []string) {
	pushMu.Lock()
	defer pushMu.Unlock()
	subs, existed := readPushBox(box)
	if !existed {
		return
	}
	for _, d := range devices {
		delete(subs, d)
	}
	_ = writePushBox(box, subs, existed)
}

// ── Delivery ──────────────────────────────────────────────────────────────

// pushNotifyBox enqueues one wake-up, at most one per box per
// pushCoalesceWindow. Called from the deposit handler: it must never do
// anything but bookkeeping and a non-blocking channel send.
func pushNotifyBox(box string) {
	if !pushEnabled || !mailboxBoxRe.MatchString(box) {
		return
	}
	now := time.Now()
	pushSentMu.Lock()
	if last, ok := pushLastSent[box]; ok && now.Sub(last) < pushCoalesceWindow {
		pushSentMu.Unlock()
		return
	}
	pushLastSent[box] = now
	// Same opportunistic sweep as rateAllow: without it this map keeps one
	// entry per box that has ever received mail, forever.
	if now.Sub(pushLastSwep) > pushCoalesceWindow {
		pushLastSwep = now
		for k, t := range pushLastSent {
			if now.Sub(t) >= pushCoalesceWindow {
				delete(pushLastSent, k)
			}
		}
	}
	pushSentMu.Unlock()

	select {
	case pushQueue <- box:
	default:
		log.Printf("[push] queue full, dropped a wake-up")
	}
}

// pushDeliver sends the wake-up to every device subscribed to one box. Worker
// goroutine only - never a deposit's request path.
func pushDeliver(box string) {
	// readPushBox hands back a map of its own, so the sends below happen off
	// the lock and a slow push service never blocks a subscribe.
	pushMu.Lock()
	subs, _ := readPushBox(box)
	pushMu.Unlock()
	if len(subs) == 0 {
		return
	}
	keys, err := pushKeys()
	if err != nil {
		log.Printf("[push] vapid keys unavailable: %v", err)
		return
	}

	opts := &webpush.Options{
		// The endpoint is a client-chosen https URL the relay will POST to.
		// Same dialer as /og and /plugin-proxy: resolve, refuse anything that
		// would reach this deployment's own network, then dial the checked
		// address. And a timeout, which the library's default client lacks.
		HTTPClient:      pushHTTPClient,
		Subscriber:      pushSubject(),
		TTL:             pushTTL,
		Urgency:         webpush.UrgencyNormal,
		VAPIDPublicKey:  keys.PublicKey,
		VAPIDPrivateKey: keys.PrivateKey,
	}
	sent, expired, failed := 0, 0, 0
	var dead []string
	for device, s := range subs {
		status, err := pushSend(
			&webpush.Subscription{
				Endpoint: s.Endpoint,
				Keys:     webpush.Keys{P256dh: s.P256dh, Auth: s.Auth},
			},
			pushPayload,
			opts,
		)
		switch {
		case err != nil:
			failed++
		case status == http.StatusNotFound || status == http.StatusGone:
			// The push service's way of saying this subscription is gone for
			// good. Keeping it would retry forever against a dead endpoint.
			expired++
			dead = append(dead, device)
		case status >= 200 && status < 300:
			sent++
		default:
			failed++
		}
	}
	if len(dead) > 0 {
		pushRemoveDevices(box, dead)
	}
	// Counts only. An endpoint is a per-device identifier at a vendor and
	// must never reach a log line.
	log.Printf("[push] wake-up: %d sent, %d expired, %d failed", sent, expired, failed)
}

// startPushWorker drains the queue on exactly one goroutine, so however many
// deposits land at once the relay opens one push request at a time.
func startPushWorker() {
	if !pushEnabled {
		return
	}
	pushInitCount()
	go func() {
		for box := range pushQueue {
			pushDeliver(box)
		}
	}()
}

// ── HTTP ──────────────────────────────────────────────────────────────────

// validPushEndpoint accepts only an https URL small enough to store. The push
// service is chosen by the browser, not by us, so there is no host allowlist
// to apply - what bounds abuse is that subscribing needs a did signature.
func validPushEndpoint(raw string) bool {
	if raw == "" || len(raw) > pushMaxEndpoint {
		return false
	}
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != ""
}

// handlePushConfig tells the client whether to offer push at all, and hands
// it the VAPID public key its subscribe() call needs.
func handlePushConfig(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllow("push:"+clientIP(r), pushRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}
	body := map[string]any{"enabled": false}
	if pushEnabled {
		if keys, err := pushKeys(); err != nil {
			// No key pair means nothing a browser could subscribe with, so
			// say disabled rather than advertise a surface that 500s.
			log.Printf("[push] vapid keys unavailable: %v", err)
		} else {
			body = map[string]any{"enabled": true, "publicKey": keys.PublicKey}
		}
	}
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	})
}

// handlePushSubscribe stores one device's subscription under the box the
// caller proved it owns, replacing whatever that device had before.
func handlePushSubscribe(w http.ResponseWriter, r *http.Request) {
	if !pushEnabled {
		http.NotFound(w, r)
		return
	}
	// Same method set, origin rule and preflight as the mailbox routes these
	// subscriptions belong to.
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("push:"+clientIP(r), pushRateLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did          string `json:"did"`
		Ts           int64  `json:"ts"`
		Sig          string `json:"sig"`
		Device       string `json:"device"`
		Subscription struct {
			Endpoint string `json:"endpoint"`
			Keys     struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			} `json:"keys"`
		} `json:"subscription"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8*1024)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxDeviceRe.MatchString(req.Device) {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}
	if !validPushEndpoint(req.Subscription.Endpoint) {
		http.Error(w, "bad endpoint", http.StatusBadRequest)
		return
	}
	k := req.Subscription.Keys
	if k.P256dh == "" || k.Auth == "" || len(k.P256dh) > pushMaxKeyLen || len(k.Auth) > pushMaxKeyLen {
		http.Error(w, "bad keys", http.StatusBadRequest)
		return
	}
	// The same auth the mailbox uses, verbatim: same signed string, same
	// helper, same skew, and the same box derivation - so a subscription can
	// only ever be filed under the box its holder can also collect from.
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	pushMu.Lock()
	subs, existed := readPushBox(box)
	if !existed && pushBoxes >= pushMaxBoxes {
		pushMu.Unlock()
		http.Error(w, "push full", http.StatusInsufficientStorage)
		return
	}
	if _, replacing := subs[req.Device]; !replacing && len(subs) >= pushMaxDevices {
		// Oldest out first, so a user cycling through devices keeps the ones
		// they actually use instead of being refused on the seventeenth.
		oldest, oldestTs := "", int64(0)
		for d, s := range subs {
			if oldest == "" || s.Ts < oldestTs {
				oldest, oldestTs = d, s.Ts
			}
		}
		delete(subs, oldest)
	}
	subs[req.Device] = pushSubscription{
		Endpoint: req.Subscription.Endpoint,
		P256dh:   k.P256dh,
		Auth:     k.Auth,
		Ts:       time.Now().Unix(),
	}
	err = writePushBox(box, subs, existed)
	pushMu.Unlock()
	if err != nil {
		http.Error(w, "storage error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handlePushUnsubscribe drops one device's subscription.
func handlePushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if !pushEnabled {
		http.NotFound(w, r)
		return
	}
	if !mailboxCORS(w, r) {
		return
	}
	if !rateAllow("push:"+clientIP(r), pushRateLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Did    string `json:"did"`
		Ts     int64  `json:"ts"`
		Sig    string `json:"sig"`
		Device string `json:"device"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxDeviceRe.MatchString(req.Device) {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}
	box, err := verifyMailboxAuth(req.Did, req.Ts, req.Sig)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	pushRemoveDevices(box, []string{req.Device})
	w.WriteHeader(http.StatusNoContent)
}
