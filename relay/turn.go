package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// 2h, not the original 12h: this credential is carried in a plaintext
	// turn: URL (no TLS TURN is offered - see defaultTurnURLs), so a shorter
	// TTL bounds how long a credential that leaked off the wire stays usable.
	// Still comfortably longer than any call or transfer. The response
	// carries the time left, and the client reads it and re-arms its own
	// refresh at half of it (frontend/src/lib/transport/ice-server-list.ts,
	// refreshTurnCredentials), so a tab open for days never runs on a
	// credential whose embedded expiry timestamp has already passed.
	turnCredTTL = 2 * time.Hour
	// Live credentials one client may hold: an IPv4 address or an IPv6 /64,
	// and ipv6AggregateFactor times that for its /48. coturn caps the
	// allocations under each credential's id at --user-quota and the whole
	// server at --total-quota, but a credential was free, so one address
	// minted twenty-five of them in a minute and held all 300 allocations of
	// the default pool - relayed calls and transfers failed for everybody
	// who needs TURN, on every server sharing TURN_SECRET, for as long as it
	// kept re-minting. Past this count the client is handed the newest of
	// the ones it holds again.
	//
	// Counting live credentials alone bounded a rate, not a total. coturn
	// checks a credential's expiry only when an allocation is made, and an
	// allocation its client keeps refreshing outlives the credential, so
	// while every credential carried a fresh id one address gathered the
	// whole default pool in about a day. The ids are not fresh any more: a
	// client's credentials take theirs from a fixed set of
	// turnMaxLivePerClient+1, a /48's from turnMaxLivePerClient*
	// ipv6AggregateFactor+1 (see turnClientID), and coturn counts
	// --user-quota per id, whatever expiry it was minted with. However long
	// it keeps asking and refreshing, one address holds at most that many
	// ids' worth of allocations: 84 at the compose defaults, and a /48 300.
	//
	// The browsers behind one address are one client too. A browser holds
	// two at a time (its current credential and the previous one, still
	// valid for its last hour), so three steady ones each keep their own;
	// past that every ask is handed the newest, and the browsers behind a
	// busy address end up sharing that one credential's --user-quota for
	// new connections rather than spreading over six.
	turnMaxLivePerClient = 6
	// A credential handed out again still has at least this long to run;
	// when the newest has less, a fresh one is minted, so a client holds at
	// most one more than turnMaxLivePerClient.
	turnReissueMinLife = 30 * time.Minute
)

// turnLive is what each client bucket holds: the credentials minted for it
// that have not expired, oldest first. One credential sits in its client's
// own bucket and, for IPv6, in its /48's as well. Bounded by the buckets
// that asked within the last turnCredTTL, at most turnMaxLivePerClient+1
// credentials each.
var (
	turnMu        sync.Mutex
	turnLive      = map[string][]*turnCredential{}
	turnLastSwept time.Time
)

type turnCredential struct {
	username string
	expiry   int64 // unix seconds, as in the username
	slot     int   // which of its client's ids it carries (turnClientID)
}

// defaultTurnURLs is what clients get when TURN_URLS is unset: this
// instance's own coturn, derived from DOMAIN.
//
// It used to be a hardcoded awful.frav.in, so every self-hosted instance
// silently handed its users somebody else's TURN server - and after a domain
// move, so did the original.
//
// IMPORTANT for anyone overriding it: the hostname must resolve straight to
// the machine running coturn. TURN is UDP (and raw TCP), which CDN proxies
// like Cloudflare do not forward, so a proxied hostname yields a TURN server
// that can never be reached.
//
// No 5349 entries. Nothing answers there without a certificate, and a dropped
// port is worse than a closed one: ICE waits out a full connect timeout per
// URL instead of failing fast. Add a turns: URL once coturn has a cert - TLS
// TURN is the only transport some mobile carriers allow.
func defaultTurnURLs() []string {
	host := strings.TrimSpace(os.Getenv("TURN_HOST"))
	if host == "" {
		host = strings.TrimSpace(os.Getenv("DOMAIN"))
	}
	if host == "" {
		return nil
	}
	// TURN_PORT moves coturn (compose passes it to --listening-port), and
	// this used to keep advertising 3478 regardless. The failure is silent
	// and total: clients get credentials for a port coturn is not on, so
	// gathering yields no relay candidate at all, while every health signal
	// - the credential fetch included - still reports success. Worse on a
	// host running two stacks, where 3478 belongs to whichever bound it
	// first: the credentials then reach a DIFFERENT instance's coturn, which
	// rejects them with 401 because it was minted with another secret.
	port := strings.TrimSpace(os.Getenv("TURN_PORT"))
	if port == "" {
		port = "3478"
	}
	return []string{
		"turn:" + host + ":" + port + "?transport=udp",
		"turn:" + host + ":" + port + "?transport=tcp",
	}
}

// handleTurnCredentials issues short-lived TURN credentials using coturn's
// REST / use-auth-secret convention (coturn `static-auth-secret`):
//
//	username   = <unix-expiry>:<id>
//	credential = base64(HMAC-SHA1(secret, username))
//
// where the id is one of a few fixed for each client (turnClientID), or a
// random one for a proxy's address.
//
// coturn must be configured with `use-auth-secret` and the same
// `static-auth-secret` as TURN_SECRET. When TURN_SECRET is unset the endpoint
// returns 204 so the client keeps using its bundled fallback ICE servers -
// nothing breaks until an operator opts in.
func handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
	if !isAllowedOrigin(r.Header.Get("Origin")) {
		apiError(w, r, "Origin not allowed", http.StatusForbidden)
		return
	}
	// Minting was free and unmetered: the Origin check holds only honest
	// browsers, so anyone with curl could spin HMACs and TURN identities
	// without bound. Before the TURN_SECRET read, so the 204 path is metered
	// too. 30/min rather than the 10 the other handlers use because
	// refreshTurnCredentials fires on every connect() and the reconnect
	// backoff starts at 3s - a flapping tab behind a shared NAT would trip a
	// tighter budget and silently fall back to the static credentials.
	const turnCredsRateLimit = 30
	if !rateAllowClient(r, "turn:", turnCredsRateLimit) {
		apiError(w, r, "rate limited", http.StatusTooManyRequests)
		return
	}

	secret := os.Getenv("TURN_SECRET")
	if secret == "" {
		withCors(w, r, func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusNoContent)
		})
		return
	}

	urls := defaultTurnURLs()
	if env := strings.TrimSpace(os.Getenv("TURN_URLS")); env != "" {
		var custom []string
		for _, p := range strings.Split(env, ",") {
			if p = strings.TrimSpace(p); p != "" {
				custom = append(custom, p)
			}
		}
		if len(custom) > 0 {
			urls = custom
		}
	}
	if len(urls) == 0 {
		// Nothing to hand out: no TURN_URLS and no DOMAIN to derive one from.
		// A 204 is the documented "this instance has no TURN" answer and the
		// client keeps its STUN-only list, which is honest - an empty urls
		// array would have the client build a TURN entry pointing nowhere.
		withCors(w, r, func(w http.ResponseWriter) {
			w.WriteHeader(http.StatusNoContent)
		})
		return
	}

	now := time.Now()
	cred, err := turnCredentialFor(r, now, secret)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(cred.username))
	credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	resp := map[string]any{
		"username":   cred.username,
		"credential": credential,
		// Seconds this credential has left, which is the full TTL for a
		// fresh one and less for one handed out again.
		"ttl":  cred.expiry - now.Unix(),
		"urls": urls,
	}
	withCors(w, r, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	})
}

// turnCredentialFor picks the credential for r's client: a fresh one, or -
// once the client already holds turnMaxLivePerClient - the newest it holds,
// again. A proxy-class address is everybody behind it (exemptFromShares), so
// it is no one client and gets a fresh credential with a random id every
// time, as every client did before.
func turnCredentialFor(r *http.Request, now time.Time, secret string) (*turnCredential, error) {
	addr := clientAddr(r)
	if exemptFromShares(addr) {
		id, err := randomTurnID()
		if err != nil {
			return nil, err
		}
		return mintTurnCredential(now, id, 0), nil
	}
	own, agg := clientBuckets(addr)
	keys, limits := []string{own}, []int{turnMaxLivePerClient}
	if agg != "" {
		keys = append(keys, agg)
		limits = append(limits, turnMaxLivePerClient*ipv6AggregateFactor)
	}

	turnMu.Lock()
	defer turnMu.Unlock()
	// Same opportunistic sweep as rateAllow: without it a bucket that never
	// asks again keeps its expired credentials for the life of the process.
	if now.Sub(turnLastSwept) > time.Minute {
		turnLastSwept = now
		for k := range turnLive {
			turnLiveLocked(k, now)
		}
	}
	for i, k := range keys {
		live := turnLiveLocked(k, now)
		if len(live) < limits[i] {
			continue
		}
		if newest := live[len(live)-1]; newest.expiry-now.Unix() >= int64(turnReissueMinLife/time.Second) {
			return newest, nil
		}
	}
	// A fresh credential carries the next of its client's ids in turn, from
	// the widest bucket it counts against: for IPv6 the /48, so a /48 has one
	// set of ids however many /64s ask. A bucket holds fewer live credentials
	// than it has ids whenever one is minted, so the next id is never one a
	// live credential carries, and an id comes back only after all the others
	// (or once the client has held nothing for turnCredTTL): a long call
	// still holding allocations under an old credential seldom shares its
	// quota with a new one.
	idKey, ids := keys[len(keys)-1], limits[len(limits)-1]+1
	slot := 0
	if live := turnLive[idKey]; len(live) > 0 {
		slot = (live[len(live)-1].slot + 1) % ids
	}
	c := mintTurnCredential(now, turnClientID(secret, idKey, slot), slot)
	for _, k := range keys {
		turnLive[k] = append(turnLive[k], c)
	}
	return c, nil
}

// turnClientID is one of a client's fixed credential ids: a keyed hash of
// its bucket and a slot, eight bytes in hex like the random id it replaces.
// coturn counts --user-quota for the part of a username after "<digits>:"
// (get_real_username in its userdb.c), so every credential carrying this id
// draws on one quota whatever its expiry, the allocations a client keeps
// refreshing past an old credential's end included. Keyed on TURN_SECRET
// rather than a per-process key, so a relay restart does not hand every
// address a new set; and nobody without the secret can tell which address
// an id stands for, though coturn and the network see the address anyway.
func turnClientID(secret, bucket string, slot int) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("awful turn id\x00" + bucket + "\x00" + strconv.Itoa(slot)))
	return hex.EncodeToString(mac.Sum(nil)[:8])
}

// randomTurnID is the id for a credential that belongs to no one client.
func randomTurnID() (string, error) {
	idBytes := make([]byte, 8)
	if _, err := rand.Read(idBytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(idBytes), nil
}

// turnLiveLocked drops a bucket's expired credentials and returns the rest,
// oldest first. They were minted in order with one TTL, so the expired ones
// are always a prefix. Caller holds turnMu.
func turnLiveLocked(key string, now time.Time) []*turnCredential {
	live := turnLive[key]
	i := 0
	for i < len(live) && live[i].expiry <= now.Unix() {
		i++
	}
	if i == len(live) {
		delete(turnLive, key)
		return nil
	}
	if i > 0 {
		live = append([]*turnCredential(nil), live[i:]...)
		turnLive[key] = live
	}
	return live
}

func mintTurnCredential(now time.Time, id string, slot int) *turnCredential {
	// coturn's REST form is "<expiry>[:<id>]". The id half matters: coturn
	// keys --user-quota on it, and on the whole username when there is none,
	// so minting a bare timestamp put every client that asked in the same
	// wall-clock second into ONE 12-allocation bucket. A voice call is a mesh
	// (one peer connection per peer, two allocations each) and file transfer
	// uses the same ICE list, so a handful of simultaneous joiners exhausted
	// a shared quota and relay candidates simply stopped appearing. It also
	// makes an abusive session distinguishable in coturn's logs.
	expiry := now.Add(turnCredTTL).Unix()
	return &turnCredential{
		username: strconv.FormatInt(expiry, 10) + ":" + id,
		expiry:   expiry,
		slot:     slot,
	}
}
