package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// signedBody is an authenticated call's payload plus who signs it, turned
// into a request by the test helpers the way the app builds one.
type signedBody struct {
	action  string
	did     string
	priv    ed25519.PrivateKey
	payload map[string]any
}

func (b signedBody) request(t *testing.T, path string) *http.Request {
	t.Helper()
	return v2Request(t, path, b.action, b.did, b.priv, b.payload)
}

// v2Request signs a request the way the app does: the proof covers the
// action, the relay's host, the device, the time and the exact body bytes,
// and the body carries a nonce so no two proofs are alike.
func v2Request(t *testing.T, path, action, did string, priv ed25519.PrivateKey, payload map[string]any) *http.Request {
	t.Helper()
	body := map[string]any{}
	for k, v := range payload {
		body[k] = v
	}
	nonce := make([]byte, 16)
	rand.Read(nonce)
	body["nonce"] = hex.EncodeToString(nonce)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	device, _ := body["device"].(string)
	req := httptest.NewRequest("POST", path, bytes.NewReader(raw))
	signV2(req, action, did, priv, device, time.Now().Unix(), raw)
	return req
}

func signV2(req *http.Request, action, did string, priv ed25519.PrivateKey, device string, ts int64, body []byte) {
	sum := sha256.Sum256(body)
	sig := ed25519.Sign(priv, mailboxAuthMessage(action, strings.ToLower(req.Host), device, ts, hex.EncodeToString(sum[:])))
	req.Header.Set("Authorization", fmt.Sprintf("%s %s %d %s", mailboxAuthScheme, did, ts, base64.StdEncoding.EncodeToString(sig)))
}

// replayAs sends the exact proof and body of req to another handler.
func replayAs(req *http.Request, body []byte, path string, h http.HandlerFunc) int {
	again := httptest.NewRequest("POST", path, bytes.NewReader(body))
	again.Header.Set("Authorization", req.Header.Get("Authorization"))
	w := httptest.NewRecorder()
	h(w, again)
	return w.Code
}

// One v1 proof - a signature over the timestamp alone - used to work for
// every authenticated call for about two and a half minutes. Now it opens
// collect, the read-only call, and nothing else.
func TestLegacyProofOnlyCollects(t *testing.T) {
	mailboxDir = t.TempDir()
	pushTestSetup(t)
	did, priv := testDid(t)
	device := deviceID(21)
	legacy := func() map[string]any {
		ts, sig := authFields(priv)
		return map[string]any{"did": did, "ts": ts, "sig": sig, "device": device}
	}
	post := func(path string, body map[string]any, h http.HandlerFunc) int {
		raw, _ := json.Marshal(body)
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", path, bytes.NewReader(raw)))
		return w.Code
	}
	if code := post("/mailbox/collect", legacy(), handleMailboxCollect); code != 200 {
		t.Fatalf("legacy collect: %d, want 200 during the transition", code)
	}
	// An old client collecting twice in one second signs the same bytes
	// twice; its second collect is not a replay attack.
	b := legacy()
	if post("/mailbox/collect", b, handleMailboxCollect) != 200 || post("/mailbox/collect", b, handleMailboxCollect) != 200 {
		t.Fatal("a repeated legacy collect was refused")
	}
	ack := legacy()
	ack["ids"] = []string{"abc"}
	if code := post("/mailbox/ack", ack, handleMailboxAck); code != 401 {
		t.Fatalf("legacy ack: %d, want 401", code)
	}
	sub := legacy()
	sub["subscription"] = subscribeBody(did, priv, device, "https://fcm.googleapis.com/fcm/send/x").payload["subscription"]
	if code := post("/push/subscribe", sub, handlePushSubscribe); code != 401 {
		t.Fatalf("legacy subscribe: %d, want 401", code)
	}
	if code := post("/push/unsubscribe", legacy(), handlePushUnsubscribe); code != 401 {
		t.Fatalf("legacy unsubscribe: %d, want 401", code)
	}
}

// A v2 proof is good for the one request it signs: its action, its relay,
// its device, its body, once.
func TestV2ProofIsBoundToItsRequest(t *testing.T) {
	mailboxDir = t.TempDir()
	pushTestSetup(t)
	did, priv := testDid(t)
	device := deviceID(22)

	collect := v2Request(t, "/mailbox/collect", mailboxActionCollect, did, priv, map[string]any{"device": device})
	body := bodyOf(t, collect)

	// The captured collect proof, replayed as an ack or a push call with the
	// same body, fails: the action is signed.
	if code := replayAs(collect, body, "/mailbox/ack", handleMailboxAck); code != 401 {
		t.Fatalf("collect proof accepted as an ack: %d", code)
	}
	if code := replayAs(collect, body, "/push/unsubscribe", handlePushUnsubscribe); code != 401 {
		t.Fatalf("collect proof accepted as an unsubscribe: %d", code)
	}

	// The genuine request works, once.
	if code := replayAs(collect, body, "/mailbox/collect", handleMailboxCollect); code != 200 {
		t.Fatalf("genuine collect: %d", code)
	}
	if code := replayAs(collect, body, "/mailbox/collect", handleMailboxCollect); code != 401 {
		t.Fatalf("replayed collect: %d, want 401", code)
	}

	// The device is signed: the same proof with the victim's device swapped
	// into the body is a different body and a different device.
	ack := v2Request(t, "/mailbox/ack", mailboxActionAck, did, priv, map[string]any{"device": device, "ids": []string{"abc"}})
	ackBody := bodyOf(t, ack)
	swapped := bytes.Replace(ackBody, []byte(device), []byte(deviceID(23)), 1)
	if code := replayAs(ack, swapped, "/mailbox/ack", handleMailboxAck); code != 401 {
		t.Fatalf("ack with a swapped device accepted: %d", code)
	}

	// The endpoint is signed: a captured subscribe cannot be re-aimed.
	sub := subscribeBody(did, priv, device, "https://fcm.googleapis.com/fcm/send/mine").request(t, "/push/subscribe")
	subBody := bodyOf(t, sub)
	moved := bytes.Replace(subBody, []byte("/mine"), []byte("/theirs"), 1)
	if code := replayAs(sub, moved, "/push/subscribe", handlePushSubscribe); code != 401 {
		t.Fatalf("subscribe with a swapped endpoint accepted: %d", code)
	}

	// The relay is signed: a proof made for another host fails here.
	other := httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	other.Host = "relay.other.example"
	fresh := map[string]any{"device": device, "nonce": "n1"}
	raw, _ := json.Marshal(fresh)
	signV2(other, mailboxActionCollect, did, priv, device, time.Now().Unix(), raw)
	if code := replayAs(other, raw, "/mailbox/collect", handleMailboxCollect); code != 401 {
		t.Fatalf("a proof for another relay accepted: %d", code)
	}

	// And the timestamp still has to be fresh.
	stale := httptest.NewRequest("POST", "/mailbox/collect", nil)
	raw, _ = json.Marshal(map[string]any{"device": device, "nonce": "n2"})
	signV2(stale, mailboxActionCollect, did, priv, device, time.Now().Add(-10*time.Minute).Unix(), raw)
	if code := replayAs(stale, raw, "/mailbox/collect", handleMailboxCollect); code != 401 {
		t.Fatalf("a stale v2 proof accepted: %d", code)
	}
}

func bodyOf(t *testing.T, req *http.Request) []byte {
	t.Helper()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(req.Body); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// The replay cache is bounded however many proofs arrive.
func TestReplayCacheIsBounded(t *testing.T) {
	mailboxSeenMu.Lock()
	mailboxSeen, mailboxSeenOrder = map[string]time.Time{}, nil
	mailboxSeenMu.Unlock()
	ts := time.Now().Unix()
	for i := 0; i < mailboxSeenMax+100; i++ {
		if !mailboxAuthFirstUse(fmt.Sprintf("sig-%d", i), ts) {
			t.Fatalf("fresh proof %d refused", i)
		}
	}
	mailboxSeenMu.Lock()
	n, order := len(mailboxSeen), len(mailboxSeenOrder)
	mailboxSeenMu.Unlock()
	if n > mailboxSeenMax || order > mailboxSeenMax {
		t.Fatalf("cache holds %d (%d ordered), cap is %d", n, order, mailboxSeenMax)
	}
	if mailboxAuthFirstUse(fmt.Sprintf("sig-%d", mailboxSeenMax+99), ts) {
		t.Fatal("a proof still in the cache was accepted twice")
	}
}

// The same vector frontend/src/lib/transport/mailbox-auth.test.ts pins, so
// the app and the relay cannot drift apart on the signed format.
func TestMailboxAuthMessageVector(t *testing.T) {
	body := []byte(`{"ids":["abc"],"device":"dev","nonce":"00"}`)
	sum := sha256.Sum256(body)
	got := string(mailboxAuthMessage(mailboxActionAck, "relay.test", "dev", 1700000000, hex.EncodeToString(sum[:])))
	const want = "awful-mailbox:v2:ack:relay.test:dev:1700000000:26215402fa91f88e5b53ca396aea66a1d15dc0fa399ffacc7084ef9fba2f12e6"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
}

// Lenient base64 lets the unused low bits of a signature's last character
// vary, so one proof had sixteen spellings, and a replay cache keyed on the
// text took each for a new proof.
func TestReplayedProofInAnotherSpellingIsRefused(t *testing.T) {
	mailboxDir = t.TempDir()
	did, priv := testDid(t)
	req := v2Request(t, "/mailbox/collect", mailboxActionCollect, did, priv, map[string]any{"device": deviceID(24)})
	body := bodyOf(t, req)
	auth := req.Header.Get("Authorization")
	f := strings.Fields(auth)
	sig := f[3]
	// 64 bytes is 86 significant characters; the 86th carries two bits of
	// the signature and four that decoding ignores.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	i := strings.IndexByte(alphabet, sig[85])
	respelled := sig[:85] + string(alphabet[i^1]) + sig[86:]
	a, _ := base64.StdEncoding.DecodeString(sig)
	b, err := base64.StdEncoding.DecodeString(respelled)
	if err != nil || !bytes.Equal(a, b) || respelled == sig {
		t.Fatalf("test bug: the respelling does not decode to the same signature")
	}

	if code := replayAs(req, body, "/mailbox/collect", handleMailboxCollect); code != 200 {
		t.Fatalf("genuine collect: %d", code)
	}
	again := httptest.NewRequest("POST", "/mailbox/collect", bytes.NewReader(body))
	again.Header.Set("Authorization", strings.Join([]string{f[0], f[1], f[2], respelled}, " "))
	w := httptest.NewRecorder()
	handleMailboxCollect(w, again)
	if w.Code != 401 {
		t.Fatalf("the same proof respelled was accepted again: %d", w.Code)
	}

	// Keyed on the bytes, the cache refuses it too, whatever the decoder.
	mailboxSeenMu.Lock()
	_, seen := mailboxSeen[string(a)]
	mailboxSeenMu.Unlock()
	if !seen {
		t.Fatal("the replay cache is not keyed on the signature bytes")
	}
}
