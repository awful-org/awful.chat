package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/multiformats/go-multiaddr"
)

// fakeStream implements rvStream, capturing frames written by the registry.
// Frames now arrive on the client's own writer goroutine, so every accessor
// takes the mutex and the tests wait for a frame count instead of assuming the
// write already happened.
type fakeStream struct {
	mu           sync.Mutex
	frames       [][]byte
	reset        bool
	readDeadline time.Time
}

func (f *fakeStream) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.reset {
		return 0, errors.New("stream reset")
	}
	buf := make([]byte, len(p))
	copy(buf, p)
	f.frames = append(f.frames, buf)
	return len(p), nil
}

func (f *fakeStream) SetWriteDeadline(time.Time) error { return nil }

func (f *fakeStream) Reset() error {
	f.mu.Lock()
	f.reset = true
	f.mu.Unlock()
	return nil
}

// wasReset reports whether the registry tore this stream down.
func (f *fakeStream) wasReset() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reset
}

func (f *fakeStream) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.frames)
}

// SetReadDeadline and Read make fakeStream also satisfy rvReadStream, for the
// idle-timeout test below. Read blocks until the deadline set by
// SetReadDeadline elapses, then returns the same kind of error a real
// net.Conn would return on an expired deadline - nothing else in fakeStream
// ever sends read data, so readLoop's only way out is that timeout.
func (f *fakeStream) SetReadDeadline(t time.Time) error {
	f.mu.Lock()
	f.readDeadline = t
	f.mu.Unlock()
	return nil
}

func (f *fakeStream) Read([]byte) (int, error) {
	f.mu.Lock()
	dl := f.readDeadline
	f.mu.Unlock()
	if !dl.IsZero() {
		if d := time.Until(dl); d > 0 {
			time.Sleep(d)
		}
	}
	return 0, os.ErrDeadlineExceeded
}

// waitFrames blocks until at least n frames have been written, so a test never
// races the writer goroutine.
func (f *fakeStream) waitFrames(t *testing.T, n int) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if f.count() >= n {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %d frames, got %d", n, f.count())
}

// decode strips the 4-byte big-endian length prefix and unmarshals the JSON.
func (f *fakeStream) decode(t *testing.T, i int) serverMsg {
	t.Helper()
	f.waitFrames(t, i+1)
	f.mu.Lock()
	frame := f.frames[i]
	f.mu.Unlock()
	if len(frame) < 4 {
		t.Fatalf("frame %d too short: %d bytes", i, len(frame))
	}
	msgLen := int(frame[0])<<24 | int(frame[1])<<16 | int(frame[2])<<8 | int(frame[3])
	if msgLen != len(frame)-4 {
		t.Fatalf("frame %d length prefix %d != payload %d", i, msgLen, len(frame)-4)
	}
	var msg serverMsg
	if err := json.Unmarshal(frame[4:], &msg); err != nil {
		t.Fatalf("frame %d bad json: %v", i, err)
	}
	return msg
}

// blockingStream never completes a write until release is closed - a peer that
// has stopped reading its stream.
type blockingStream struct {
	release chan struct{}
}

func (b *blockingStream) Write(p []byte) (int, error) {
	<-b.release
	return len(p), nil
}

func (b *blockingStream) SetWriteDeadline(time.Time) error { return nil }
func (b *blockingStream) Reset() error                     { return nil }

func addClient(r *registry, peerId string, s rvStream) *connectedClient {
	c := r.addStream(peerId, s)
	if c == nil {
		panic("registry refused a stream for " + peerId)
	}
	return c
}

// roomHas reports whether peerId is in the room on any of its streams.
func roomHas(r *registry, room, peerId string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return peerInRoom(r.rooms[room], peerId)
}

// streamsOf reports how many rendezvous streams the registry holds for a peer.
func streamsOf(r *registry, peerId string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.clients[peerId])
}

func newClient(r *registry, peerId string) (*connectedClient, *fakeStream) {
	s := &fakeStream{}
	return addClient(r, peerId, s), s
}

func TestRegisterSendsPeerListAndNotifies(t *testing.T) {
	r := newRegistry()
	a, sa := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")

	r.register(a, "room1")
	// Joiner with empty room gets an empty PEERS list
	msg := sa.decode(t, 0)
	if msg.Type != "PEERS" || msg.Room != "room1" || len(msg.Peers) != 0 {
		t.Fatalf("unexpected first PEERS msg: %+v", msg)
	}

	r.register(b, "room1")
	// Existing peer A gets PEER_JOINED
	joined := sa.decode(t, 1)
	if joined.Type != "PEER_JOINED" || joined.Peer != "peer-b" {
		t.Fatalf("expected PEER_JOINED for b, got %+v", joined)
	}
	// Joiner B gets the peer list containing A
	peers := sb.decode(t, 0)
	if peers.Type != "PEERS" || len(peers.Peers) != 1 || peers.Peers[0] != "peer-a" {
		t.Fatalf("expected PEERS [peer-a], got %+v", peers)
	}
}

func TestRegisterIsIdempotent(t *testing.T) {
	r := newRegistry()
	a, sa := newClient(r, "peer-a")
	r.register(a, "room1")
	r.register(a, "room1")
	sa.waitFrames(t, 1)
	time.Sleep(20 * time.Millisecond) // give a second PEERS a chance to show up
	if sa.count() != 1 {
		t.Fatalf("duplicate register should not resend PEERS, got %d frames", sa.count())
	}
	if len(r.rooms["room1"]) != 1 {
		t.Fatalf("room should have 1 peer, got %d", len(r.rooms["room1"]))
	}
}

func TestUnregisterNotifiesAndCleansEmptyRoom(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")
	r.register(a, "room1")
	r.register(b, "room1")

	sb.waitFrames(t, 1) // b's own PEERS, before the departure notice
	before := sb.count()
	r.unregister(a, "room1")

	left := sb.decode(t, before)
	if left.Type != "PEER_LEFT" || left.Peer != "peer-a" {
		t.Fatalf("expected PEER_LEFT peer-a, got %+v", left)
	}

	r.unregister(b, "room1")
	if _, exists := r.rooms["room1"]; exists {
		t.Fatal("empty room should be deleted")
	}
}

func TestDisconnectRemovesFromAllRooms(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	b, sb := newClient(r, "peer-b")
	r.register(a, "room1")
	r.register(a, "room2")
	r.register(b, "room1")

	sb.waitFrames(t, 1) // b's own PEERS, before the departure notice
	before := sb.count()
	r.disconnectPeer("peer-a") // the libp2p-level backup, after the peer is fully gone

	if _, ok := r.clients["peer-a"]; ok {
		t.Fatal("client should be removed on disconnect")
	}
	if roomHas(r, "room1", "peer-a") {
		t.Fatal("peer should be out of room1")
	}
	if _, ok := r.rooms["room2"]; ok {
		t.Fatal("room2 should be deleted (was only member)")
	}
	left := sb.decode(t, before)
	if left.Type != "PEER_LEFT" || left.Peer != "peer-a" {
		t.Fatalf("expected PEER_LEFT broadcast, got %+v", left)
	}
}

func TestDisconnectUnknownPeerIsNoop(t *testing.T) {
	r := newRegistry()
	r.disconnectPeer("ghost") // must not panic
}

// Writes used to happen inline on the SENDING peer's goroutine with a 5s
// deadline, so a single peer that stopped reading its stream stalled every
// other member of its rooms. The frames now go through a per-peer queue and
// the peer that will not drain it is dropped.
func TestSlowPeerDoesNotStallOtherPeers(t *testing.T) {
	r := newRegistry()
	release := make(chan struct{})
	defer close(release)
	b := addClient(r, "peer-b", &blockingStream{release: release})
	r.register(b, "room1")

	a, _ := newClient(r, "peer-a")
	churn := make(chan struct{})
	go func() {
		defer close(churn)
		for i := 0; i < sendQueueDepth+4; i++ {
			r.register(a, "room1")
			r.unregister(a, "room1")
		}
	}()
	select {
	case <-churn:
	case <-time.After(5 * time.Second):
		t.Fatal("register/unregister blocked on a peer that is not reading its stream")
	}

	select {
	case <-b.done:
	case <-time.After(2 * time.Second):
		t.Fatal("a peer with a full outbox should be dropped")
	}
}

// RELAY-02: a stream the registry has already let go of - its read loop ended,
// or the libp2p backup cleaned up after the peer - must not be able to put
// itself back into a room. Nothing would ever remove that entry again.
func TestEvictedStreamCannotTouchTheRegistry(t *testing.T) {
	r := newRegistry()
	live, _ := newClient(r, "peer-a")
	gone, _ := newClient(r, "peer-a")
	r.register(live, "room1")
	r.register(gone, "room1")

	r.removeClient(gone)

	r.register(gone, "room2") // in flight when the stream went away
	r.mu.Lock()
	_, orphaned := r.rooms["room2"]
	r.mu.Unlock()
	if orphaned {
		t.Fatal("an evicted stream registered a room nothing would clean up")
	}

	r.unregister(gone, "room1")
	if !roomHas(r, "room1", "peer-a") {
		t.Fatal("an evicted stream pulled the live one out of its room")
	}

	r.removeClient(live)
	r.mu.Lock()
	rooms, clients := len(r.rooms), len(r.clients)
	r.mu.Unlock()
	if rooms != 0 || clients != 0 {
		t.Fatalf("registry not empty after every stream closed: %d rooms, %d clients", rooms, clients)
	}
}

// Two tabs of the app share one peerId - the libp2p key lives in localStorage
// and there is no leader election - so a peer legitimately holds two rendezvous
// streams. Superseding on the second one reset the first, whose client reopened
// two seconds later and reset the second back: a permanent flap that wiped the
// loser's room membership every round.
func TestTwoTabsOfOnePeerCoexist(t *testing.T) {
	r := newRegistry()
	tabA, sA := newClient(r, "peer-a")
	tabB, sB := newClient(r, "peer-a")
	other, sOther := newClient(r, "peer-b")

	r.register(tabA, "room1")
	r.register(other, "room1")
	sOther.waitFrames(t, 1) // its own PEERS
	r.register(tabB, "room1")
	sB.waitFrames(t, 1)

	if sA.wasReset() || sB.wasReset() {
		t.Fatal("one tab's rendezvous stream tore down the other's")
	}
	if n := streamsOf(r, "peer-a"); n != 2 {
		t.Fatalf("peer-a should hold 2 streams, got %d", n)
	}

	// The second tab gets the room's peers, listed once and never itself.
	peers := sB.decode(t, 0)
	if peers.Type != "PEERS" || len(peers.Peers) != 1 || peers.Peers[0] != "peer-b" {
		t.Fatalf("expected PEERS [peer-b] for the second tab, got %+v", peers)
	}

	// The other peer hears nothing new: peer-a is already in the room and it
	// has already dialled that peerId.
	time.Sleep(20 * time.Millisecond)
	if sOther.count() != 1 {
		t.Fatalf("a second tab of a peer already in the room caused %d extra frames", sOther.count()-1)
	}

	// Closing one tab must not evict the peer or announce a departure.
	r.removeClient(tabA)
	time.Sleep(20 * time.Millisecond)
	if !roomHas(r, "room1", "peer-a") {
		t.Fatal("closing one tab removed a peer its other tab still has in the room")
	}
	if sOther.count() != 1 {
		t.Fatal("closing one tab announced PEER_LEFT for a peer that is still here")
	}

	// The last stream leaving is a real departure.
	r.removeClient(tabB)
	left := sOther.decode(t, 1)
	if left.Type != "PEER_LEFT" || left.Peer != "peer-a" {
		t.Fatalf("expected PEER_LEFT peer-a once the last tab closed, got %+v", left)
	}
	if roomHas(r, "room1", "peer-a") {
		t.Fatal("peer-a still in room1 after both of its tabs closed")
	}
}

// The old registry held exactly one client per peerId, which is what bounded
// its per-peer footprint. Allowing concurrent streams needs an explicit
// ceiling in its place - a generous one, since tabs and device sync are why
// there is more than one.
func TestStreamsPerPeerAreCapped(t *testing.T) {
	r := newRegistry()
	for i := 0; i < maxStreamsPerPeer; i++ {
		if c := r.addStream("peer-a", &fakeStream{}); c == nil {
			t.Fatalf("stream %d of %d refused below the cap", i+1, maxStreamsPerPeer)
		}
	}
	if c := r.addStream("peer-a", &fakeStream{}); c != nil {
		t.Fatal("a peer past the stream cap should be refused")
	}
	if c := r.addStream("peer-b", &fakeStream{}); c == nil {
		t.Fatal("one peer at its cap blocked a different peer")
	}
}

// maxMsgLen has no lower bound and the relay's logs are neither rotated nor
// size-capped, so every log line a stream can provoke - malformed frames,
// unknown types, unusable room ids - comes out of one per-connection budget.
func TestLogBudgetRunsOut(t *testing.T) {
	b := &logBudget{left: 2}
	if !b.allow() || b.spent() {
		t.Fatal("the first line should be allowed with budget to spare")
	}
	if !b.allow() || !b.spent() {
		t.Fatal("the second line should be the last one allowed")
	}
	for i := 0; i < 1000; i++ {
		if b.allow() {
			t.Fatal("the budget kept handing out log lines after it ran out")
		}
	}
}

func TestValidRoomRejectsUnusableIds(t *testing.T) {
	cases := []struct {
		room string
		want bool
	}{
		{"abc123", true},
		{"dm-" + strings.Repeat("a", 40), true},
		{"a room typed by hand", true}, // nothing normalises what a user types
		{"", false},
		{strings.Repeat("a", maxRoomIDLen+1), false},
		{"room1\n2026/01/01 [rv] forged log line", false},
		{"room1\x00", false},
	}
	for _, c := range cases {
		if got := validRoom(c.room); got != c.want {
			t.Errorf("validRoom(%q) = %v, want %v", c.room, got, c.want)
		}
	}
}

// Nothing else bounds registry growth: the connection manager counts
// connections, and one stream can issue REGISTERs until the process is out of
// memory.
func TestRoomsPerPeerAreCapped(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	for i := 0; i < maxRoomsPerPeer+10; i++ {
		r.register(a, fmt.Sprintf("room-%d", i))
	}
	r.mu.Lock()
	joined, rooms := len(a.rooms), len(r.rooms)
	r.mu.Unlock()
	if joined != maxRoomsPerPeer {
		t.Fatalf("peer joined %d rooms, cap is %d", joined, maxRoomsPerPeer)
	}
	if rooms != maxRoomsPerPeer {
		t.Fatalf("registry holds %d rooms, cap is %d", rooms, maxRoomsPerPeer)
	}
}

// The default go-libp2p resource manager caps concurrent connections at 8 per
// IPv4 /32 and new connections at 0.2/s. Behind Traefik every browser shares
// one source IP, so those defaults were a GLOBAL ceiling of 8 peers for the
// whole relay - the cause of intermittent "relay dial failed" in the app and
// of device sync (two libp2p nodes per device) failing the most.
func TestResourceManagerAllowsManyConnsFromOneIP(t *testing.T) {
	rm, err := newResourceManager()
	if err != nil {
		t.Fatalf("newResourceManager: %v", err)
	}
	defer rm.Close()

	// One source address, far more connections than the default cap of 8.
	remote, err := multiaddr.NewMultiaddr("/ip4/172.18.0.5/tcp/40000/ws")
	if err != nil {
		t.Fatalf("multiaddr: %v", err)
	}
	// connMgrHigh, not some token number: this has to fail if EITHER ceiling
	// is put back below the connection manager's own high-water mark - the
	// per-subnet cap (8 by default, and meaningless behind a proxy) or the
	// memory-scaled System.ConnsInbound, which on a small VPS lands under it.
	const want = connMgrHigh
	scopes := make([]network.ConnManagementScope, 0, want)
	for i := 0; i < want; i++ {
		scope, err := rm.OpenConnection(network.DirInbound, true, remote)
		if err != nil {
			t.Fatalf("connection %d/%d from a single IP rejected: %v", i+1, want, err)
		}
		scopes = append(scopes, scope)
	}
	for _, s := range scopes {
		s.Done()
	}
}

// Behind Traefik every client shares one source IP, so go-libp2p's default
// MaxReservationsPerIP of 8 was a GLOBAL cap of 8 circuit reservations for the
// whole deployment - past the ninth user nobody could be reached. A browser
// cannot listen, so a reservation is the only inbound path a peer has.
func TestRelayReservationsAreNotCappedAtEightPerIP(t *testing.T) {
	res := relayResources()
	if res.MaxReservationsPerIP <= 8 {
		t.Errorf("MaxReservationsPerIP = %d, still the default global ceiling", res.MaxReservationsPerIP)
	}
	if res.MaxReservations < res.MaxReservationsPerIP {
		t.Errorf("global MaxReservations (%d) below the per-IP cap (%d), so the per-IP lift does nothing",
			res.MaxReservations, res.MaxReservationsPerIP)
	}
	if res.MaxReservations < connMgrHigh {
		t.Errorf("MaxReservations = %d, below the connection ceiling of %d", res.MaxReservations, connMgrHigh)
	}
}

// logCapture collects what the standard logger writes during one test.
type logCapture struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (l *logCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.Write(p)
}

func (l *logCapture) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

// captureLog points the standard logger at a buffer for the rest of the test.
func captureLog(t *testing.T) *logCapture {
	t.Helper()
	c := &logCapture{}
	flags := log.Flags()
	log.SetOutput(c)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(flags)
	})
	return c
}

// The RELAY-07 budget covered only malformed frames, but REGISTER and
// UNREGISTER are well-formed 40-byte frames that a peer can alternate at line
// rate - two log lines per round trip, which is the same unrotated disk the
// budget exists to protect.
func TestJoinAndLeaveLinesAreBudgeted(t *testing.T) {
	out := captureLog(t)
	r := newRegistry()
	a, _ := newClient(r, "peer-a")

	const roundTrips = maxMembershipLogLines * 2
	for i := 0; i < roundTrips; i++ {
		r.register(a, "room1")
		r.unregister(a, "room1")
	}

	logged := out.String()
	lines := strings.Count(logged, "joined room") + strings.Count(logged, "left room")
	if lines == 0 {
		t.Fatal("no join or leave line survived: a normal deployment must still see them")
	}
	if lines > maxMembershipLogLines {
		t.Fatalf("%d join/leave lines from %d round trips, budget is %d", lines, roundTrips, maxMembershipLogLines)
	}
	if n := strings.Count(logged, "used up its join/leave log budget"); n != 1 {
		t.Fatalf("expected exactly one notice that the budget ran out, got %d", n)
	}
}

// The budget refills, unlike the one-shot logBudget: joins and leaves are what
// an operator actually wants in the log, so a peer that flapped once must not
// be silent for the rest of its session.
func TestMembershipLogBudgetRefillsEachWindow(t *testing.T) {
	var m membershipLog // the zero value has to start with a full budget
	now := time.Now()
	for i := 0; i < maxMembershipLogLines; i++ {
		ok, quiet := m.allow(now)
		if !ok {
			t.Fatalf("line %d of %d refused while still inside the budget", i+1, maxMembershipLogLines)
		}
		if want := i == maxMembershipLogLines-1; quiet != want {
			t.Fatalf("line %d: quiet = %v, want %v", i+1, quiet, want)
		}
	}
	if ok, _ := m.allow(now); ok {
		t.Fatal("the budget kept handing out lines after it ran out")
	}
	if ok, _ := m.allow(now.Add(membershipLogWindow)); !ok {
		t.Fatal("the budget never refilled")
	}
}

// lockProbe fails the test if a log line is written while registry.mu is held.
type lockProbe struct {
	r     *registry
	lines atomic.Int64
	held  atomic.Bool
}

func (p *lockProbe) Write(b []byte) (int, error) {
	p.lines.Add(1)
	// Several tries, because some other goroutine may hold the lock for a
	// moment for reasons of its own. Only a line written BY the lock holder
	// keeps it held for the whole write, which is the failure being probed.
	for i := 0; i < 5; i++ {
		if p.r.mu.TryLock() {
			p.r.mu.Unlock()
			return len(b), nil
		}
		time.Sleep(time.Millisecond)
	}
	p.held.Store(true)
	return len(b), nil
}

// log.Printf takes its own mutex and writes to stderr synchronously - in
// docker, straight into the json-file logging driver - so a line written under
// the single global registry lock serializes every join and leave in the whole
// process behind one write(2).
func TestRegistryNeverLogsUnderItsLock(t *testing.T) {
	r := newRegistry()
	probe := &lockProbe{r: r}
	flags := log.Flags()
	log.SetOutput(probe)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(flags)
	})

	a, _ := newClient(r, "peer-a")
	b, _ := newClient(r, "peer-b")
	r.register(a, "room1")
	r.register(b, "room1")
	r.unregister(a, "room1")
	// The room-cap complaint sits on the same path.
	for i := 0; i <= maxRoomsPerPeer; i++ {
		r.register(b, fmt.Sprintf("room-%d", i))
	}
	r.removeClient(a)
	r.disconnectPeer("peer-b")

	if probe.lines.Load() == 0 {
		t.Fatal("nothing was logged at all, so this proved nothing")
	}
	if probe.held.Load() {
		t.Fatal("a log line was written while the registry lock was held")
	}
}

// logSafe runs on every join and leave, so the room ids handleStream already
// validated must come back untouched instead of being copied twice.
func TestLogSafeCopiesOnlyWhatItMustRewrite(t *testing.T) {
	clean := "dm-" + strings.Repeat("a", 40)
	cases := []struct{ in, want string }{
		{clean, clean},
		{"", ""},
		{"room1\n2026/01/01 [rv] forged log line", "room1.2026/01/01 [rv] forged log line"},
		{"tail\x7f", "tail."},
		{strings.Repeat("b", 100), strings.Repeat("b", 64)},
		{strings.Repeat("c", 63) + "\nrest", strings.Repeat("c", 63) + "."},
	}
	for _, c := range cases {
		if got := logSafe(c.in); got != c.want {
			t.Errorf("logSafe(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// maxRoomsPerPeer is per STREAM, and one peerId may hold maxStreamsPerPeer of
// them, so before maxTotalRegistrations the per-stream cap bounded a peer's
// footprint and nothing global: 32 streams x 1024 rooms = 32768 registrations
// per peerId, for a few hundred bytes of attacker uplink each.
func TestRegistryHasAGlobalRegistrationCeiling(t *testing.T) {
	r := newRegistry()
	// A second stream of the SAME peerId used to get a fresh 1024 allowance.
	a1, _ := newClient(r, "peer-a")
	a2, _ := newClient(r, "peer-a")
	for _, c := range []*connectedClient{a1, a2} {
		for i := 0; i < maxRoomsPerPeer; i++ {
			r.register(c, fmt.Sprintf("room-%d-%p", i, c))
		}
	}
	r.mu.Lock()
	total := r.total
	r.mu.Unlock()
	if total != 2*maxRoomsPerPeer {
		t.Fatalf("total = %d, want %d (each stream keeps its own room cap)", total, 2*maxRoomsPerPeer)
	}
	if total > maxTotalRegistrations {
		t.Fatalf("test is not exercising the ceiling: %d > %d", total, maxTotalRegistrations)
	}
}

// The global counter has to come back down, or an instance that has merely
// been busy for a while refuses registrations forever.
func TestGlobalRegistrationCountFallsOnLeaveAndDisconnect(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "peer-a")
	b, _ := newClient(r, "peer-b")
	for i := 0; i < 5; i++ {
		r.register(a, fmt.Sprintf("room-%d", i))
		r.register(b, fmt.Sprintf("room-%d", i))
	}
	r.mu.Lock()
	if r.total != 10 {
		r.mu.Unlock()
		t.Fatalf("total after 10 registers = %d, want 10", r.total)
	}
	r.mu.Unlock()

	r.unregister(a, "room-0")
	r.mu.Lock()
	afterLeave := r.total
	r.mu.Unlock()
	if afterLeave != 9 {
		t.Fatalf("total after one leave = %d, want 9", afterLeave)
	}

	r.disconnectPeer("peer-a")
	r.mu.Lock()
	afterDisconnect := r.total
	r.mu.Unlock()
	if afterDisconnect != 5 {
		t.Fatalf("total after peer-a disconnected = %d, want 5 (peer-b's rooms)", afterDisconnect)
	}
}

// A membership budget at or below maxRoomsPerPeer would throttle the ordinary
// case: a reconnecting peer re-registers every saved room and every phonebook
// DM in one burst, and a dropped REGISTER leaves it silently out of its own
// room. This is the regression guard for that, not for the attack.
func TestMembershipBudgetAllowsAFullReconnectBurst(t *testing.T) {
	o := &opBudget{}
	now := time.Now()
	for i := 0; i < maxRoomsPerPeer; i++ {
		if !o.allow(now) {
			t.Fatalf("a reconnect burst was throttled after %d rooms; cap is %d rooms per stream", i, maxRoomsPerPeer)
		}
	}
}

// The attack the budget exists for: flapping one shared room fans a frame at
// every other member until one of their outboxes overflows, and an overflowing
// member is dropped from EVERY room it holds - including rooms the flapper was
// never in.
func TestMembershipBudgetStopsAFlapperAndRefills(t *testing.T) {
	o := &opBudget{}
	now := time.Now()
	allowed := 0
	for i := 0; i < maxMembershipOps*4; i++ {
		if o.allow(now) {
			allowed++
		}
	}
	if allowed != maxMembershipOps {
		t.Fatalf("allowed %d ops in one window, want %d", allowed, maxMembershipOps)
	}
	if !o.allow(now.Add(membershipOpWindow)) {
		t.Fatal("budget did not refill on the next window; a peer that trips it would be stuck for good")
	}
}

// Stream open/close and peer connect/disconnect each wrote an unbudgeted line,
// so one connection cycling open/write/close sustained ~144 GB of log a day -
// the disk-fill maxStreamLogLines exists to stop, routed around.
func TestLifecycleLogLinesAreBudgetedAndRefill(t *testing.T) {
	l := &lifecycleLog{}
	now := time.Now()
	written, quiets := 0, 0
	for i := 0; i < maxLifecycleLogLines*3; i++ {
		ok, quiet := l.allow(now)
		if ok {
			written++
		}
		if quiet {
			quiets++
		}
	}
	if written != maxLifecycleLogLines {
		t.Fatalf("wrote %d lifecycle lines in one window, want %d", written, maxLifecycleLogLines)
	}
	if quiets != 1 {
		t.Fatalf("announced going quiet %d times, want exactly 1", quiets)
	}
	if ok, _ := l.allow(now.Add(lifecycleLogWindow)); !ok {
		t.Fatal("lifecycle budget did not refill on the next window")
	}
}

// A registered client that never sends another byte - the ordinary case, since
// the rendezvous protocol has no periodic frame of its own - used to pin
// readLoop's goroutine and the stream's registry entry forever. The idle
// deadline has to end the loop, and handleStream's cleanup (mirrored here)
// has to run: the stream reset and the peer pulled out of its rooms.
func TestIdleRendezvousStreamIsClosedAfterTimeout(t *testing.T) {
	orig := rendezvousIdleTimeout
	rendezvousIdleTimeout = 20 * time.Millisecond
	defer func() { rendezvousIdleTimeout = orig }()

	r := newRegistry()
	s := &fakeStream{}
	c := addClient(r, "peer-idle", s)
	// Registered out of band, not through readLoop: the deadline only
	// applies to a stream that has not REGISTERed over the wire.
	r.register(c, "room1")
	if !roomHas(r, "room1", "peer-idle") {
		t.Fatal("setup: peer should be in room1 before the idle timeout")
	}

	done := make(chan struct{})
	go func() {
		// Mirrors handleStream: readLoop returns once the deadline trips,
		// then the normal cleanup path runs.
		r.readLoop(s, "peer-idle", c)
		r.removeClient(c)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("readLoop did not return once the idle window elapsed")
	}

	deadline := time.Now().Add(2 * time.Second)
	for !s.wasReset() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !s.wasReset() {
		t.Fatal("an idle stream should be reset once the read deadline trips")
	}
	if roomHas(r, "room1", "peer-idle") {
		t.Fatal("an idle stream's cleanup should remove it from its rooms")
	}
}
