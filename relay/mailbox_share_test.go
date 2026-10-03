package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// depositFrom posts one blob as the client at addr, through our own proxy.
func depositFrom(t *testing.T, addr, box string, blob []byte) int {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"box":  box,
		"blob": base64.StdEncoding.EncodeToString(blob),
	})
	req := httptest.NewRequest("POST", "/mailbox/deposit", bytes.NewReader(body))
	req.RemoteAddr = "10.0.0.1:4000"
	req.Header.Set("X-Forwarded-For", addr)
	w := httptest.NewRecorder()
	handleMailboxDeposit(w, req)
	return w.Code
}

func freshMailbox(t *testing.T) {
	t.Helper()
	empty := t.TempDir()
	mailboxDir = t.TempDir()
	mailboxInitUsedBytes()
	resetRateLimiter(t)
	// The counters and indexes are process-wide, and a test that pushed them
	// to a ceiling must not hand that ceiling to whichever test runs next.
	t.Cleanup(func() {
		mailboxDir = empty
		mailboxInitUsedBytes()
	})
}

// One IPv6 /56 is 256 separate /64 buckets. Each of them keeps its own
// budget, but together they now share one aggregate for their /48, so the
// allocation deposits a few clients' worth a minute, not 256 clients' worth.
func TestMailboxDepositRateAggregatesIPv6(t *testing.T) {
	freshMailbox(t)
	did, _ := testDid(t)
	box := mailboxIDForDid(did)
	accepted := 0
	for i := 0; i < 256 && accepted <= mailboxDepositLimit*ipv6AggregateFactor; i++ {
		addr := fmt.Sprintf("2001:db8:0:%x::1", i) // a new /64 in one /56
		for j := 0; j < mailboxDepositLimit; j++ {
			code := depositFrom(t, addr, box, []byte("x"))
			if code == http.StatusTooManyRequests {
				break
			}
			if code != http.StatusNoContent {
				t.Fatalf("deposit %d/%d: %d", i, j, code)
			}
			accepted++
		}
	}
	if accepted != mailboxDepositLimit*ipv6AggregateFactor {
		t.Fatalf("one /48 got %d deposits in a window, want %d", accepted, mailboxDepositLimit*ipv6AggregateFactor)
	}
	// A different allocation is not caught by that one's aggregate.
	if code := depositFrom(t, "2001:db8:1::1", box, []byte("x")); code != http.StatusNoContent {
		t.Fatalf("another /48 was refused: %d", code)
	}
}

// However patient, one source can hold only its share of the global
// budget: the rate limit refills every minute and blobs live two days.
func TestMailboxSourceShareOfTheGlobalBudget(t *testing.T) {
	freshMailbox(t)
	const attacker = "198.51.100.66"
	held := 0
	for held < mailboxMaxHeldPerSource {
		// A fresh recipient every mailboxMaxMsgs, so the per-box cap never
		// evicts, and a fresh rate window whenever this one runs out.
		did, _ := testDid(t)
		box := mailboxIDForDid(did)
		for j := 0; j < mailboxMaxMsgs && held < mailboxMaxHeldPerSource; j++ {
			code := depositFrom(t, attacker, box, []byte("x"))
			if code == http.StatusTooManyRequests {
				resetRateLimiter(t)
				code = depositFrom(t, attacker, box, []byte("x"))
			}
			if code != http.StatusNoContent {
				t.Fatalf("deposit %d refused inside the share: %d", held, code)
			}
			held++
		}
	}
	resetRateLimiter(t)
	did, _ := testDid(t)
	if code := depositFrom(t, attacker, mailboxIDForDid(did), []byte("x")); code != http.StatusTooManyRequests {
		t.Fatalf("a source past its share got %d, want 429", code)
	}
	// Everybody else still gets in.
	if code := depositFrom(t, "198.51.100.67", mailboxIDForDid(did), []byte("x")); code != http.StatusNoContent {
		t.Fatalf("an unrelated source was refused: %d", code)
	}
}

// A box that is full sheds the depositor's own blobs before anyone else's,
// so one source can no longer flush a named user's pending mail by parking
// a hundred blobs in their box.
func TestMailboxFullBoxEvictsTheDepositorsOwnFirst(t *testing.T) {
	freshMailbox(t)
	did, _ := testDid(t)
	box := mailboxIDForDid(did)
	// The worst case for the recipient: the box is already full of real mail,
	// from as many different senders.
	const real = mailboxMaxMsgs
	for i := 0; i < real; i++ {
		if code := depositFrom(t, fmt.Sprintf("203.0.%d.%d", i/250, i%250+1), box, []byte(fmt.Sprintf("real-%d", i))); code != http.StatusNoContent {
			t.Fatalf("real deposit %d: %d", i, code)
		}
	}
	// One source keeps depositing, well past the cap.
	for i := 0; i < mailboxMaxMsgs*2; i++ {
		if i%mailboxDepositLimit == 0 {
			resetRateLimiter(t)
		}
		if code := depositFrom(t, "198.51.100.99", box, []byte("junk")); code != http.StatusNoContent {
			t.Fatalf("junk deposit %d: %d", i, code)
		}
	}
	entries, _ := os.ReadDir(boxPath(box))
	survivors := 0
	for _, e := range entries {
		b, err := os.ReadFile(boxPath(box) + "/" + e.Name())
		if err == nil && bytes.HasPrefix(b, []byte("real-")) {
			survivors++
		}
	}
	// The junk's first blob has none of its own to shed yet, so it costs the
	// box exactly one real message; every one after that sheds junk.
	if survivors != real-1 {
		t.Fatalf("%d of %d real messages survived a single-source flood, want %d", survivors, real, real-1)
	}
	if len(entries) > mailboxMaxMsgs {
		t.Fatalf("box holds %d blobs, cap is %d", len(entries), mailboxMaxMsgs)
	}
}
