package main

import (
	"bytes"
	"fmt"
	"io"
	"testing"
	"time"
)

// resetDiagRings empties the per-peer rings, so a test sees only its own.
func resetDiagRings(t *testing.T) {
	t.Helper()
	diagMu.Lock()
	defer diagMu.Unlock()
	diagPeers = map[string]*peerDiag{}
	diagLastSwept = time.Time{}
}

func diagRing(peerId string) *peerDiag {
	diagMu.Lock()
	defer diagMu.Unlock()
	return diagPeers[peerId]
}

// Every peerId the relay saw used to get a whole 256-event ring at once,
// about 21 KiB, read only if that peer ever uploads a bundle. A ring now
// grows with what is recorded and wraps exactly as before once full.
func TestDiagRingGrowsOnDemand(t *testing.T) {
	enableTelemetry(t)
	resetDiagRings(t)
	const peer = "peer-ring-grows"

	diagRecord(peer, relayDiagEvent{Kind: "rv.open"})
	if c := cap(diagRing(peer).events); c > 4 {
		t.Fatalf("a peer seen once holds room for %d events, want a handful", c)
	}

	for i := 1; i < telemetryRingCapacity+44; i++ {
		diagRecord(peer, relayDiagEvent{Kind: "rv.register"})
	}
	events, dropped := diagSnapshot(peer)
	if len(events) != telemetryRingCapacity || dropped != 44 {
		t.Fatalf("ring holds %d events and dropped %d, want %d and 44", len(events), dropped, telemetryRingCapacity)
	}
	if c := cap(diagRing(peer).events); c != telemetryRingCapacity {
		t.Fatalf("a full ring has room for %d events, want exactly %d", c, telemetryRingCapacity)
	}
	for i, e := range events {
		if e.Seq != 45+i {
			t.Fatalf("event %d has seq %d, want %d: oldest first, no gaps", i, e.Seq, 45+i)
		}
		if e.Peer == nil || *e.Peer != peer {
			t.Fatalf("event %d is about %v, want %s", i, e.Peer, peer)
		}
	}
}

// Nothing freed a ring when its peer left, so the table filled with peers
// long gone. A ring nothing has been recorded into for telemetryRingIdle is
// dropped.
func TestDiagRingsGoOnceTheirPeerIsQuiet(t *testing.T) {
	enableTelemetry(t)
	resetDiagRings(t)
	diagRecord("peer-gone", relayDiagEvent{Kind: "rv.open"})
	diagRecord("peer-here", relayDiagEvent{Kind: "rv.open"})

	diagMu.Lock()
	diagPeers["peer-gone"].lastTouch = time.Now().Add(-telemetryRingIdle - time.Second)
	diagLastSwept = time.Time{}
	diagMu.Unlock()
	diagRecord("peer-here", relayDiagEvent{Kind: "rv.register"})

	if diagRing("peer-gone") != nil {
		t.Fatal("a ring idle past telemetryRingIdle was kept")
	}
	if events, _ := diagSnapshot("peer-here"); len(events) != 2 {
		t.Fatalf("a live peer's ring has %d events, want 2", len(events))
	}
}

// junkStream sends one buffer of wire bytes, then ends.
type junkStream struct {
	fakeStream
	wire *bytes.Reader
}

func (s *junkStream) Read(p []byte) (int, error) {
	n, err := s.wire.Read(p)
	if err == io.EOF {
		return 0, io.EOF
	}
	return n, err
}

// readLoop recorded an rv.send.fail, with a map of its own, for every junk
// frame, so a peer could fill its ring with the heaviest events there are -
// and keep it, since rings outlived their peers. Those events now come out
// of the stream's complaint budget, and constant reasons share one map.
func TestJunkFramesCostTheRingLittle(t *testing.T) {
	enableTelemetry(t)
	resetDiagRings(t)
	const peer = "peer-junk"
	var wire bytes.Buffer
	for range 300 {
		wire.Write([]byte{0, 0, 0, 1, '{'}) // a frame that is not JSON
	}
	s := &junkStream{wire: bytes.NewReader(wire.Bytes())}
	r := newRegistry()
	c := addClient(r, peer, s)
	r.readLoop(s, peer, c)

	events, _ := diagSnapshot(peer)
	var fails []relayDiagEvent
	for _, e := range events {
		if e.Kind == "rv.send.fail" {
			fails = append(fails, e)
		}
	}
	if len(fails) != maxStreamLogLines {
		t.Fatalf("300 junk frames recorded %d rv.send.fail events, want the stream's %d complaints", len(fails), maxStreamLogLines)
	}
	if !sameMap(fails[0].D, fails[1].D) || fails[0].D["reason"] != "malformed" {
		t.Fatal("two events with one constant reason carry a map each")
	}
}

// sameMap reports whether two maps are the same map, not just equal.
func sameMap(a, b map[string]any) bool {
	return fmt.Sprintf("%p", a) == fmt.Sprintf("%p", b)
}
