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
	"container/list"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
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
	// pushWorkers drain this. A burst that outruns delivery drops wake-ups
	// rather than growing without bound - the mailbox still holds the
	// message, and the next deposit or foreground collect finds it.
	pushQueueDepth = 1024
	// Delivery used to be ONE worker sending to a box's devices one at a
	// time with a 15 s timeout each. Sixteen subscribed devices whose
	// endpoints accepted TLS and never answered held that worker for four
	// minutes per wake-up, and every real wake-up on the instance queued
	// behind it until the queue overflowed and dropped them. Now: a pool of
	// workers, a short timeout per send, a cap on sends in flight to any one
	// push service, and a service or box that keeps failing is suspended
	// with backoff instead of retried at full cost on every deposit. The
	// allowlist below is what makes "never answers" rare in the first place:
	// an endpoint has to be at a real push service.
	pushWorkers = 8
	// A push service answers in well under a second; five is generous for
	// a slow mobile-network day and short enough that a hung send costs a
	// worker five seconds, not fifteen.
	pushSendTimeout = 5 * time.Second
	// Sends in flight to one push service at once. Four workers' worth, so
	// one service that has gone slow can occupy at most half the pool.
	pushPerHostConcurrency = 4
	// How long a send waits for a free slot at its push service before the
	// wake-up is skipped for that device. The mailbox keeps the message;
	// the next deposit tries again.
	pushHostWait = 2 * time.Second
	// A push service that fails this many sends in a row is suspended for a
	// backoff that doubles, from pushHostBackoffMin to pushHostBackoffMax,
	// and resets on the first success.
	pushHostFailThreshold = 5
	pushHostBackoffMin    = 30 * time.Second
	pushHostBackoffMax    = 10 * time.Minute
	// The same for one box whose every device failed this many deliveries
	// in a row: its wake-ups are skipped for a doubling backoff.
	pushBoxFailThreshold = 3
	pushBoxBackoffMin    = time.Minute
	pushBoxBackoffMax    = time.Hour
	// Seconds a push service should hold an undelivered wake-up. A day, so a
	// phone that was off overnight still gets told once it is back.
	pushTTL = 86400
	// Boxes holding subscriptions. Subscribing needs a did signature, but
	// dids are free to mint, so without a ceiling this is an unbounded
	// on-disk sink for anyone with curl - the same reasoning as
	// mailboxGlobalMaxBoxes. A full store sheds the box subscribed to
	// longest ago rather than refusing (pushShedOldest).
	pushMaxBoxes = 65536
	// The part of pushMaxBoxes one source may hold: an IPv4 address or an
	// IPv6 /56 (shareKey), and ipv6AggregateFactor times that for the /48
	// around it, so one allocation's 256 /56s are not 256 shares. The
	// ceiling used to be the only limit: one address minting dids filled the
	// store in a day and a half, after which every identity that subscribed
	// for the first time got 507 and no wake-ups, for good - a restart
	// counted the same files back in. A sixty-fourth is a thousand
	// identities behind one address, far past a household or an office, and
	// it means shedding by age cannot be turned into a way to push real
	// users out: a source over its share is refused before anything is shed.
	pushMaxBoxesPerSource = pushMaxBoxes / 64
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

	// pushOrder is every stored box, the one subscribed to longest ago at
	// the front, and pushOrderAt finds a box in it. A device subscribes again
	// on every unlock, so the front is the box whose devices have gone
	// longest without opening the app - an abandoned identity, or a minted
	// one - and that is what a full store sheds. Rebuilt from file times at
	// boot. Guarded by pushMu.
	pushOrder   = list.New()
	pushOrderAt = map[string]*list.Element{}
	// pushHeld is how many boxes each source created and still holds, for
	// pushMaxBoxesPerSource. Memory only, keyed by a hash under the
	// mailbox's per-process key, never an address: a restart forgets it,
	// which only means boxes from before the restart count against nobody.
	// Guarded by pushMu.
	pushHeld = map[string]int{}
	// When a full store last said so, so shedding writes a line an hour at
	// most. Guarded by pushMu.
	pushFullLogged time.Time

	pushVapidMu     sync.Mutex
	pushVapidCached *vapidKeys

	pushSentMu   sync.Mutex
	pushLastSent = map[string]time.Time{}
	pushLastSwep time.Time
)

var pushQueue = make(chan string, pushQueueDepth)

// One client for every push send, over the SSRF-safe dialer the proxies use
// (see pluginProxySafeDial): a subscription endpoint is attacker input, and
// a push service that hangs must not hold a worker for longer than one
// pushSendTimeout.
var pushHTTPClient = &http.Client{Timeout: pushSendTimeout, Transport: &http.Transport{
	DialContext:         pluginProxySafeDial,
	IdleConnTimeout:     90 * time.Second,
	MaxIdleConns:        32,
	MaxIdleConnsPerHost: pushPerHostConcurrency,
}}

// ── Push services ─────────────────────────────────────────────────────────

// defaultPushHosts are the push services browsers actually hand out
// endpoints at: Chrome, Edge-on-Android, Samsung Internet, Opera and Brave
// use Firebase Cloud Messaging; Firefox uses Mozilla's autopush; Safari
// (macOS 13+, iOS 16.4+) uses Apple's; Edge on Windows uses WNS. A "*."
// entry matches any subdomain. PUSH_ALLOWED_HOSTS replaces this list for an
// operator whose users need another service; "*" allows any https host,
// which is how the relay behaved before and lets a subscriber aim the relay
// at any server on the internet.
var defaultPushHosts = []string{
	"fcm.googleapis.com",
	"updates.push.services.mozilla.com",
	"web.push.apple.com",
	"*.push.apple.com",
	"*.notify.windows.com",
}

var pushAllowedHosts = parsePushHosts(os.Getenv("PUSH_ALLOWED_HOSTS"))

func parsePushHosts(raw string) []string {
	var out []string
	for _, h := range strings.Split(raw, ",") {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	if len(out) == 0 {
		return defaultPushHosts
	}
	return out
}

// pushHostKey returns the allowlist entry an endpoint host falls under,
// which is also the key its concurrency slots and backoff are kept under -
// one per push SERVICE, not per hostname, so a service that spreads its
// endpoints over many subdomains is still one service to be gentle with.
// Empty when no entry allows the host.
func pushHostKey(host string) string {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	for _, h := range pushAllowedHosts {
		switch {
		case h == "*":
			return host
		case strings.HasPrefix(h, "*."):
			if strings.HasSuffix(host, h[1:]) && len(host) > len(h)-1 {
				return h
			}
		case host == h:
			return h
		}
	}
	return ""
}

type pushHostState struct {
	slots          chan struct{}
	fails          int
	backoff        time.Duration
	suspendedUntil time.Time
}

var (
	pushHostsMu sync.Mutex
	pushHosts   = map[string]*pushHostState{}
)

func pushHost(key string) *pushHostState {
	pushHostsMu.Lock()
	defer pushHostsMu.Unlock()
	st := pushHosts[key]
	if st == nil {
		st = &pushHostState{slots: make(chan struct{}, pushPerHostConcurrency)}
		pushHosts[key] = st
	}
	return st
}

// pushHostSuspended reports whether a push service is sitting out a backoff.
func pushHostSuspended(st *pushHostState, now time.Time) bool {
	pushHostsMu.Lock()
	defer pushHostsMu.Unlock()
	return now.Before(st.suspendedUntil)
}

// pushHostResult records one send's outcome at a push service. ok is any
// answer at all from the service, including 404/410: those are about the
// subscription, not about the service being unwell.
func pushHostResult(st *pushHostState, ok bool, now time.Time) {
	pushHostsMu.Lock()
	defer pushHostsMu.Unlock()
	if ok {
		st.fails, st.backoff = 0, 0
		return
	}
	st.fails++
	if st.fails < pushHostFailThreshold {
		return
	}
	st.backoff = nextBackoff(st.backoff, pushHostBackoffMin, pushHostBackoffMax)
	st.suspendedUntil = now.Add(st.backoff)
	st.fails = 0
}

func nextBackoff(cur, lo, hi time.Duration) time.Duration {
	if cur < lo {
		return lo
	}
	if cur*2 > hi {
		return hi
	}
	return cur * 2
}

// Per-box failure state, see pushBoxFailThreshold. Only boxes that have
// failed are here and a success deletes the entry, so it is bounded by the
// subscribed boxes.
type pushBoxState struct {
	fails          int
	backoff        time.Duration
	suspendedUntil time.Time
}

var (
	pushBoxFailMu sync.Mutex
	pushBoxFail   = map[string]*pushBoxState{}
)

func pushBoxSuspended(box string, now time.Time) bool {
	pushBoxFailMu.Lock()
	defer pushBoxFailMu.Unlock()
	st := pushBoxFail[box]
	return st != nil && now.Before(st.suspendedUntil)
}

func pushBoxResult(box string, ok bool, now time.Time) {
	pushBoxFailMu.Lock()
	defer pushBoxFailMu.Unlock()
	if ok {
		delete(pushBoxFail, box)
		return
	}
	st := pushBoxFail[box]
	if st == nil {
		st = &pushBoxState{}
		pushBoxFail[box] = st
	}
	st.fails++
	if st.fails >= pushBoxFailThreshold {
		st.backoff = nextBackoff(st.backoff, pushBoxBackoffMin, pushBoxBackoffMax)
		st.suspendedUntil = now.Add(st.backoff)
		st.fails = 0
	}
}

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
		if existed && os.Remove(pushBoxPath(box)) == nil {
			if pushBoxes > 0 {
				pushBoxes--
			}
			pushUntrack(box)
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
// restart, and lines them up oldest file first, so shedding does too. Runs
// once at boot, like mailboxInitUsedBytes. The shares start empty.
func pushInitCount() {
	pushMu.Lock()
	defer pushMu.Unlock()
	pushBoxes = 0
	pushOrder.Init()
	pushOrderAt = map[string]*list.Element{}
	pushHeld = map[string]int{}
	type stored struct {
		box string
		mod time.Time
	}
	var boxes []stored
	entries, _ := os.ReadDir(pushDir)
	for _, e := range entries {
		box, ok := strings.CutSuffix(e.Name(), ".json")
		if e.IsDir() || !ok || !mailboxBoxRe.MatchString(box) {
			continue
		}
		s := stored{box: box}
		if info, err := e.Info(); err == nil {
			s.mod = info.ModTime()
		}
		boxes = append(boxes, s)
	}
	sort.Slice(boxes, func(i, j int) bool {
		if boxes[i].mod.Equal(boxes[j].mod) {
			return boxes[i].box < boxes[j].box
		}
		return boxes[i].mod.Before(boxes[j].mod)
	})
	for _, s := range boxes {
		pushOrderAt[s.box] = pushOrder.PushBack(&pushStoredBox{box: s.box})
	}
	pushBoxes = len(boxes)
}

// pushStoredBox is one entry of pushOrder: the box and the share tags its
// creation was charged to, empty for a box no share holds.
type pushStoredBox struct {
	box     string
	sources []string
}

// pushSourceTags names the shares a subscribe from r is charged to: the
// source's own (an IPv4 address or IPv6 /56) and, for IPv6, its /48. None
// for a proxy-class address, which is everybody behind it (exemptFromShares).
// Keyed hashes, like mailboxSourceTag, so the store's bookkeeping never
// holds an address.
func pushSourceTags(r *http.Request) []string {
	addr := clientAddr(r)
	own := shareKey(addr)
	if own == "" {
		return nil
	}
	keys := []string{own}
	if _, agg := clientBuckets(addr); agg != "" {
		keys = append(keys, agg)
	}
	tags := make([]string, len(keys))
	for i, k := range keys {
		m := hmac.New(sha256.New, mailboxSourceKey)
		m.Write([]byte("push:" + k))
		tags[i] = hex.EncodeToString(m.Sum(nil)[:12])
	}
	return tags
}

// pushShareFull reports whether a source already holds its share of boxes:
// pushMaxBoxesPerSource for its own tag, ipv6AggregateFactor times that for
// its /48's. Caller holds pushMu.
func pushShareFull(sources []string) bool {
	for i, s := range sources {
		limit := pushMaxBoxesPerSource
		if i > 0 {
			limit *= ipv6AggregateFactor
		}
		if pushHeld[s] >= limit {
			return true
		}
	}
	return false
}

// pushTrack records a subscribe to box: it moves to the back of pushOrder,
// and a box being created is charged to sources. Caller holds pushMu.
func pushTrack(box string, sources []string, created bool) {
	if el, ok := pushOrderAt[box]; ok {
		pushOrder.MoveToBack(el)
		return
	}
	entry := &pushStoredBox{box: box}
	if created {
		entry.sources = sources
		for _, s := range sources {
			pushHeld[s]++
		}
	}
	pushOrderAt[box] = pushOrder.PushBack(entry)
}

// pushUntrack forgets a box whose file is gone and returns its share.
// Caller holds pushMu.
func pushUntrack(box string) {
	el, ok := pushOrderAt[box]
	if !ok {
		return
	}
	delete(pushOrderAt, box)
	entry := pushOrder.Remove(el).(*pushStoredBox)
	for _, s := range entry.sources {
		if pushHeld[s]--; pushHeld[s] <= 0 {
			delete(pushHeld, s)
		}
	}
}

// pushShedOldest makes room in a full store by deleting the box subscribed
// to longest ago, and reports whether it freed one. That box's devices stop
// being woken until one of them opens the app again, which subscribes
// afresh. Caller holds pushMu.
func pushShedOldest() bool {
	el := pushOrder.Front()
	if el == nil {
		return false
	}
	box := el.Value.(*pushStoredBox).box
	if err := os.Remove(pushBoxPath(box)); err != nil && !os.IsNotExist(err) {
		return false
	}
	pushUntrack(box)
	if pushBoxes > 0 {
		pushBoxes--
	}
	if now := time.Now(); now.Sub(pushFullLogged) >= time.Hour {
		pushFullLogged = now
		log.Printf("[push] the subscription store is full (%d boxes): each new one replaces the box subscribed to longest ago", pushMaxBoxes)
	}
	return true
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
	now := time.Now()
	if pushBoxSuspended(box, now) {
		return
	}
	sent, expired, failed, skipped := 0, 0, 0, 0
	var dead []string
	for device, s := range subs {
		key := pushEndpointKey(s.Endpoint)
		if key == "" {
			// Stored before the allowlist, or an operator has narrowed it
			// since. Skipped, not deleted: a PUSH_ALLOWED_HOSTS set by
			// mistake must be undoable by setting it back, and a deleted
			// subscription only returns when its device next re-subscribes.
			// The device's own unsubscribe, or a 404/410 once it is allowed
			// again, still removes it.
			skipped++
			continue
		}
		host := pushHost(key)
		if pushHostSuspended(host, time.Now()) {
			skipped++
			continue
		}
		select {
		case host.slots <- struct{}{}:
		case <-time.After(pushHostWait):
			skipped++
			continue
		}
		status, err := pushSend(
			&webpush.Subscription{
				Endpoint: s.Endpoint,
				Keys:     webpush.Keys{P256dh: s.P256dh, Auth: s.Auth},
			},
			pushPayload,
			opts,
		)
		<-host.slots
		pushHostResult(host, err == nil && status < 500, time.Now())
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
	if sent+failed > 0 {
		pushBoxResult(box, sent > 0, time.Now())
	}
	// Counts only. An endpoint is a per-device identifier at a vendor and
	// must never reach a log line.
	log.Printf("[push] wake-up: %d sent, %d expired, %d failed, %d skipped", sent, expired, failed, skipped)
}

// pushEndpointKey is the push service an endpoint belongs to, or empty when
// it is not one this relay sends to.
func pushEndpointKey(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil {
		return ""
	}
	if p := u.Port(); p != "" && p != "443" {
		return ""
	}
	return pushHostKey(u.Hostname())
}

// startPushWorker drains the queue on pushWorkers goroutines, so however
// many deposits land at once the relay has at most that many push requests
// open, and one slow push service cannot hold all of them (see
// pushPerHostConcurrency).
func startPushWorker() {
	if !pushEnabled {
		return
	}
	pushInitCount()
	log.Printf("[push] sending to %s", strings.Join(pushAllowedHosts, ", "))
	for range pushWorkers {
		go func() {
			for box := range pushQueue {
				pushDeliver(box)
			}
		}()
	}
}

// ── HTTP ──────────────────────────────────────────────────────────────────

// validPushEndpoint accepts only an https URL small enough to store, on
// port 443, at a push service the relay sends to (defaultPushHosts). The
// browser picks the service, but browsers only pick from a handful; without
// the allowlist a subscriber - dids are free - could point the relay at any
// server on the internet and have it POST there on every deposit.
func validPushEndpoint(raw string) bool {
	if raw == "" || len(raw) > pushMaxEndpoint {
		return false
	}
	return pushEndpointKey(raw) != ""
}

// handlePushConfig tells the client whether to offer push at all, and hands
// it the VAPID public key its subscribe() call needs.
func handlePushConfig(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	if !rateAllowClient(r, "push:", pushRateLimit) {
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
	if !rateAllowClient(r, "push:", pushRateLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Device       string `json:"device"`
		Subscription struct {
			Endpoint string `json:"endpoint"`
			Keys     struct {
				P256dh string `json:"p256dh"`
				Auth   string `json:"auth"`
			} `json:"keys"`
		} `json:"subscription"`
	}
	body, ok := readMailboxBody(w, r, 8*1024)
	if !ok {
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
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
	// The mailbox's auth, for this action: the same key, skew and box
	// derivation - so a subscription can only ever be filed under the box
	// its holder can also collect from - and a proof that signs this
	// endpoint and this device, so a captured one cannot subscribe anybody
	// else's.
	box, err := authenticateMailbox(r, pushActionSubscribe, body, req.Device, "", 0, "")
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	sources := pushSourceTags(r)
	pushMu.Lock()
	subs, existed := readPushBox(box)
	if !existed {
		// A new box costs its source a slot of its share, checked before
		// anything is shed: a source past its share must not be able to
		// push somebody else's box out by asking for one more.
		if pushShareFull(sources) {
			pushMu.Unlock()
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		if pushBoxes >= pushMaxBoxes && !pushShedOldest() {
			pushMu.Unlock()
			http.Error(w, "push full", http.StatusInsufficientStorage)
			return
		}
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
	if err == nil {
		pushTrack(box, sources, !existed)
	}
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
	if !rateAllowClient(r, "push:", pushRateLimit) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	var req struct {
		Device string `json:"device"`
	}
	body, ok := readMailboxBody(w, r, 4096)
	if !ok {
		return
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	if !mailboxDeviceRe.MatchString(req.Device) {
		http.Error(w, "bad device", http.StatusBadRequest)
		return
	}
	box, err := authenticateMailbox(r, pushActionUnsubscribe, body, req.Device, "", 0, "")
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	pushRemoveDevices(box, []string{req.Device})
	w.WriteHeader(http.StatusNoContent)
}
