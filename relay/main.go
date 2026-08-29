package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	rcmgr "github.com/libp2p/go-libp2p/p2p/host/resource-manager"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptls "github.com/libp2p/go-libp2p/p2p/security/tls"
	"github.com/libp2p/go-libp2p/p2p/transport/websocket"
	"github.com/libp2p/go-libp2p/x/rate"
)

const RendezvousProtocol = "/awful/rendezvous/1.0.0"

type clientMsg struct {
	Type string `json:"type"` // REGISTER | UNREGISTER
	Room string `json:"room"`
}

type serverMsg struct {
	Type  string   `json:"type"` // PEERS | PEER_JOINED | PEER_LEFT
	Room  string   `json:"room"`
	Peers []string `json:"peers"`
	Peer  string   `json:"peer,omitempty"` // PEER_JOINED | PEER_LEFT
}

// rvStream is the slice of network.Stream the registry needs - an
// interface so tests can stub it without a real libp2p stream.
type rvStream interface {
	io.Writer
	SetWriteDeadline(time.Time) error
	Reset() error
}

const (
	// How long a single frame may take to reach one peer before its stream is
	// treated as dead. Only that peer's own writer goroutine ever waits this
	// long, so nobody else's work is queued behind it.
	streamWriteTimeout = 5 * time.Second
	// Outbox depth per peer. A reconnecting peer re-REGISTERs every room it is
	// in at once, so the queue has to absorb a burst of PEERS/PEER_JOINED
	// frames; a peer still behind after this many is not reading its stream at
	// all and gets dropped.
	sendQueueDepth = 256
	// Room ids the app produces are at most 43 bytes ("dm-" plus 40 hex);
	// created codes are 6. Anything past this is not a room, it is a payload.
	maxRoomIDLen = 128
	// A peer re-joins every saved room and every phonebook DM when it
	// connects, which can be hundreds. Past this ceiling a single stream is
	// only growing the registry, which nothing else bounds: the connection
	// manager counts connections, not rooms.
	maxRoomsPerPeer = 1024
	// Registrations the whole registry will hold, across every stream of every
	// peer. maxRoomsPerPeer is per STREAM - connectedClient is one stream, not
	// one peer - and one peerId may hold maxStreamsPerPeer of them, so the
	// per-stream cap bounds a peer's footprint and nothing global: 32 x 1024 =
	// 32768 registrations per peerId for a few hundred bytes of uplink each.
	// Measured at ~451 bytes of heap per registration, so this ceiling is
	// ~90 MB: far past what a real instance needs, and far short of what it
	// takes to OOM the box the relay shares with everything else. The resource
	// manager cannot see this growth - its memory budget covers streams and
	// buffers, not our maps.
	maxTotalRegistrations = 200_000
	// Rendezvous streams one peerId may hold at once. Several are normal - two
	// tabs of the app share a peerId because the libp2p key lives in
	// localStorage - and none of them may evict another, so this exists only to
	// keep the per-peer registry footprint bounded, which is what the old
	// one-client-per-peerId map used to do.
	maxStreamsPerPeer = 32
	// Log lines a single rendezvous stream may cost the relay. Enough to
	// diagnose a genuinely confused client, few enough that a peer spraying
	// junk frames cannot write the disk full.
	maxStreamLogLines = 8
	// Join and leave lines one rendezvous stream may write per
	// membershipLogWindow. REGISTER and UNREGISTER are well-formed 40-byte
	// frames that a peer can send at line rate, so a line each with no budget
	// was the same disk-fill maxStreamLogLines exists to stop. This budget is
	// far larger because those lines are the ones with operational value - a
	// peer re-joins every saved room and every phonebook DM the moment it
	// connects, and an operator wants to see that burst - and it refills, so a
	// stream that does trip it goes quiet for a window rather than for good.
	maxMembershipLogLines = 256
	membershipLogWindow   = time.Minute
	// Stream and connection lifecycle lines the whole relay may write per
	// lifecycleLogWindow. Opening a rendezvous stream, being refused one and
	// closing one each wrote a line with no budget at all, so a single
	// connection cycling open/write/close sustained ~3,900 cycles per second -
	// 3 lines each, ~1.7 MB/s, ~144 GB/day - which is exactly the disk-fill
	// maxStreamLogLines exists to stop, routed around. This budget is GLOBAL
	// rather than per-peer on purpose: a per-peerId map would be keyed by a
	// value the attacker chooses, so the bookkeeping meant to bound memory
	// would itself be unbounded. A real instance sees a handful of these a
	// minute, and the budget refills, so tripping it costs visibility for one
	// window and nothing else.
	maxLifecycleLogLines = 512
	lifecycleLogWindow   = time.Minute
	// Membership changes one rendezvous stream may make per
	// membershipOpWindow. REGISTER/UNREGISTER are 40-byte frames a peer can
	// send at line rate, and each one fans a PEER_JOINED or PEER_LEFT out to
	// every other stream in the room - so flapping one shared room filled a
	// victim's 256-frame outbox in ~130 messages, and a full outbox drops the
	// victim from EVERY room it holds, not just the poisoned one. Well past
	// This MUST stay comfortably above maxRoomsPerPeer: a reconnecting peer
	// re-registers every saved room and every phonebook DM in one burst, so a
	// budget at or below the room cap would throttle the ordinary case and
	// silently leave a client out of its own rooms. 2x the cap leaves room for
	// that burst plus normal churn while still cutting the flap rate by two
	// orders of magnitude (34/s, against the ~4,000/s the attack needs).
	maxMembershipOps   = 2 * maxRoomsPerPeer
	membershipOpWindow = time.Minute
	// registry.register is the only oracle a room-code guesser has: an empty
	// PEERS reply means the room it guessed is empty, a populated one means
	// it hit a real room. Codes are moving to 48 bits, so the relay has to
	// make that oracle expensive without refusing REGISTER outright - a
	// legitimate reconnect re-registers every saved room too, and most of
	// them have nobody else online.
	//
	// maxEmptyRegisters bounds REGISTERs into a room with no OTHER member at
	// registration time, per stream, per emptyRegisterWindow; a REGISTER
	// into a populated room costs nothing against it. Exhausting the budget
	// drops the REGISTER - no PEERS reply, no join - the same way an
	// exhausted membershipOps drops the op above, rather than resetting the
	// stream: the drop alone already silences the oracle for the rest of the
	// window, so paying the cost of a reconnect on top buys nothing.
	//
	// 128/min/stream x maxStreamsPerPeer x connMgrHigh bounds the system-wide
	// guess rate: 128 x 32 x 512 = 2,097,152 empty-room REGISTERs/minute at
	// the absolute worst case (connMgrHigh connections, each holding
	// maxStreamsPerPeer streams, every one saturating this budget) - a
	// vanishing fraction of the 2^48 code space per minute.
	//
	// maxRoomsPerPeer is 1024, so a peer with more than 128 saved EMPTY rooms
	// will exhaust this partway through a reconnect burst and have the rest
	// of that burst silently dropped until the window refills; the budget
	// refills on the same still-open stream without a reconnect, same as
	// every other per-stream budget here. 128 is picked so a realistic user -
	// dozens of rooms, not four figures of them - never gets near it.
	maxEmptyRegisters   = 128
	emptyRegisterWindow = time.Minute
)

// rendezvousIdleTimeout closes a stream that has REGISTERed nothing yet and
// sends nothing for this long. Only unregistered streams get a deadline: the
// rendezvous protocol carries no periodic frame of its own - REGISTER and
// UNREGISTER only fire on a room change - so a registered tab legitimately
// sends nothing for hours, and cutting it would make its rooms see it leave
// and rejoin on every timer tick. A registered stream is already bounded
// (maxRoomsPerPeer, maxStreamsPerPeer, connmgr); what was unbounded was a
// peer opening up to maxStreamsPerPeer streams and never sending a byte,
// pinning a goroutine and a registry entry each with nothing to reclaim
// them. A package-level var, not a const, so tests can shrink it.
var rendezvousIdleTimeout = time.Minute

// connectedClient is ONE rendezvous stream, not one peer. A peerId can hold
// several at once - the user's other tab - and each one owns only the rooms it
// registered itself.
type connectedClient struct {
	peerId string
	stream rvStream
	rooms  map[string]struct{}
	// Frames go to a per-client writer goroutine instead of being written from
	// the sending peer's goroutine. Writing inline meant one peer that stopped
	// reading its stream stalled every other member of its rooms for the whole
	// write deadline, because go-yamux blocks once the receiver's window fills.
	out           chan []byte
	done          chan struct{}
	closeOnce     sync.Once
	roomCapLogged bool          // guarded by registry.mu; keeps a capped peer from flooding the log
	joinLeaveLog  membershipLog // guarded by registry.mu; caps the join/leave lines this stream can write
	// emptyRegisters bounds REGISTERs this stream makes into a room with no
	// OTHER member - see maxEmptyRegisters. Set only inside registry.register,
	// which is only ever called from this stream's own read loop, so - like
	// membershipOps in readLoop - it needs no lock of its own even though
	// register() happens to touch it while holding registry.mu.
	emptyRegisters opBudget
}

// newConnectedClient starts the client's writer goroutine. The client must
// later be shut down (shutdown, or the disconnect path) or that goroutine
// stays alive for the life of the process.
func newConnectedClient(peerId string, s rvStream) *connectedClient {
	c := &connectedClient{
		peerId: peerId,
		stream: s,
		rooms:  make(map[string]struct{}),
		out:    make(chan []byte, sendQueueDepth),
		done:   make(chan struct{}),
	}
	go c.writeLoop()
	return c
}

// writeLoop owns every write to the stream, so two frames can never interleave
// and the deadline covers exactly one write.
func (c *connectedClient) writeLoop() {
	for {
		select {
		case frame := <-c.out:
			c.stream.SetWriteDeadline(time.Now().Add(streamWriteTimeout))
			if _, err := c.stream.Write(frame); err != nil {
				c.shutdown()
				return
			}
		case <-c.done:
			return
		}
	}
}

// shutdown stops the writer goroutine and tears the stream down. Resetting the
// stream is what unblocks the read loop in handleStream, which then runs the
// registry cleanup. Safe to call repeatedly and from any goroutine.
func (c *connectedClient) shutdown() {
	c.closeOnce.Do(func() {
		close(c.done)
		// Reset() can BLOCK indefinitely: go-yamux's sendReset queues the RST
		// onto the session send channel with a NIL deadline, and that channel
		// is backed up for exactly the peer being dropped here - one that
		// stopped draining its stream. shutdown() is called from OTHER peers'
		// read loops (the PEER_JOINED and PEER_LEFT broadcasts), and stalling
		// one of those is precisely the "one dead tab stalls the whole room"
		// failure the writer goroutine was introduced to end. The reset needs
		// to happen, not to happen HERE, so it gets its own goroutine.
		// closeOnce keeps it to exactly one.
		go c.stream.Reset()
	})
}

// validRoom rejects room ids the app can never produce: empty, oversized, or
// carrying control characters. The control-character check is also what stops
// a REGISTER from forging whole entries in the relay log, which is not rotated
// and which prints the room id verbatim.
func validRoom(room string) bool {
	if room == "" || len(room) > maxRoomIDLen {
		return false
	}
	for i := 0; i < len(room); i++ {
		if room[i] < 0x20 || room[i] == 0x7f {
			return false
		}
	}
	return true
}

// logSafe makes a peer-supplied string safe to put in a log line: control
// characters (a newline forges an entire entry) become '.', and the result is
// truncated because nothing rotates or size-caps the relay's logs.
func logSafe(s string) string {
	const maxLogged = 64
	if len(s) > maxLogged {
		s = s[:maxLogged]
	}
	// The string this runs on for every join and leave is a room id that
	// handleStream already put through validRoom, so it has nothing to rewrite:
	// scan first and copy only for input that really does carry something
	// unprintable, instead of paying two allocations per membership change.
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			b := []byte(s)
			for j := i; j < len(b); j++ {
				if b[j] < 0x20 || b[j] == 0x7f {
					b[j] = '.'
				}
			}
			return string(b)
		}
	}
	return s
}

// logBudget caps how many log lines a single connection can make the relay
// write. maxMsgLen has no lower bound and the logs are neither rotated nor
// size-capped, so a peer streaming tiny malformed frames at line rate would
// otherwise earn a line each and fill the disk.
type logBudget struct{ left int }

// allow reports whether one more line may be written, spending the budget.
func (b *logBudget) allow() bool {
	if b.left <= 0 {
		return false
	}
	b.left--
	return true
}

// spent reports that the budget just ran out, so the caller can say once that
// it is going quiet rather than leaving an operator wondering.
func (b *logBudget) spent() bool { return b.left == 0 }

// lifecycleLog is the process-wide budget for stream and connection lifecycle
// lines. It has its own mutex because, unlike membershipLog, it is written
// from paths that do not hold registry.mu.
type lifecycleLog struct {
	mu          sync.Mutex
	left        int
	windowStart time.Time
	quieted     bool
}

var lifecycleLines lifecycleLog

// allow reports whether one more lifecycle line may be written. It says once,
// on the line that spends the budget, that it is going quiet - otherwise an
// operator watching a flood sees it simply stop.
func (l *lifecycleLog) allow(now time.Time) (ok, quiet bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.windowStart) >= lifecycleLogWindow {
		l.windowStart = now
		l.left = maxLifecycleLogLines
		l.quieted = false
	}
	if l.left <= 0 {
		// quiet is true exactly once per window, so the caller can say it is
		// going silent rather than leaving an operator watching a flood
		// wonder why the lines stopped.
		quiet := !l.quieted
		l.quieted = true
		return false, quiet
	}
	l.left--
	return true, false
}

// lifecycleLogf writes a lifecycle line if the global budget allows it. Every
// line is emitted with the budget's lock released - log.Printf writes to
// stderr synchronously, straight into docker's logging driver, and holding a
// shared lock across that write is what puts every other logger behind it.
func lifecycleLogf(format string, args ...any) {
	ok, quiet := lifecycleLines.allow(time.Now())
	if ok {
		log.Printf(format, args...)
		return
	}
	if quiet {
		log.Printf("[rv] lifecycle log budget spent, stream open/close lines are dropped for up to %s", lifecycleLogWindow)
	}
}

// opBudget is a per-stream refilling allowance for membership changes. It is
// the same shape as membershipLog but gates the WORK rather than the logging,
// and it is touched only from that stream's own read loop, so it needs no
// lock. The zero value is a full budget whose window opens on first use.
type opBudget struct {
	left        int
	windowStart time.Time
	started     bool
}

func (o *opBudget) allow(now time.Time) bool {
	if !o.started || now.Sub(o.windowStart) >= membershipOpWindow {
		o.started = true
		o.windowStart = now
		o.left = maxMembershipOps
	}
	if o.left <= 0 {
		return false
	}
	o.left--
	return true
}

// membershipLog is the per-stream budget for the join and leave lines. Those
// frames are well-formed and tiny, so logBudget's one-shot allowance would
// silence a normal peer for the rest of its session; this one refills every
// membershipLogWindow, which bounds the disk a flapping peer can eat while
// still showing every join and leave at ordinary volume. The zero value is a
// full budget.
type membershipLog struct {
	left        int
	windowStart time.Time
}

// allow reports whether one more membership line may be written, refilling the
// budget first when the window has rolled over. quiet is true on the line that
// spends the last of the budget, so the caller can say once that it is going
// quiet. The caller holds registry.mu, which is what keeps this free of a lock
// of its own.
func (m *membershipLog) allow(now time.Time) (ok, quiet bool) {
	if now.Sub(m.windowStart) >= membershipLogWindow {
		m.windowStart = now
		m.left = maxMembershipLogLines
	}
	if m.left <= 0 {
		return false, false
	}
	m.left--
	return true, m.left == 0
}

// sayQuiet reports that a stream has spent its join/leave budget, so an
// operator who sees a busy peer go silent in the log knows why.
func sayQuiet(peerId string) {
	log.Printf("[rv] %s used up its join/leave log budget, further ones are dropped for up to %s",
		short(peerId), membershipLogWindow)
}

// leaveLine is the "left room" line doUnregister would have written, carried
// back to the caller instead so it can be emitted with registry.mu released.
// write is false when the stream's budget refused it or there was nothing to
// report.
type leaveLine struct {
	peerId string
	room   string
	peers  int
	write  bool
	quiet  bool
}

func (l leaveLine) emit() {
	if !l.write {
		return
	}
	log.Printf("[rv] %s left room [%s] (%d peers)", short(l.peerId), logSafe(l.room), l.peers)
	if l.quiet {
		sayQuiet(l.peerId)
	}
}

type registry struct {
	mu sync.Mutex
	// room → the streams registered in it. Membership is tracked per STREAM,
	// not per peerId: two tabs of the app share one peerId, so keying rooms by
	// peerId meant either tab's rendezvous stream wiped the other tab's rooms.
	rooms map[string]map[*connectedClient]struct{}
	// peerId → that peer's live rendezvous streams.
	clients map[string]map[*connectedClient]struct{}
	// Sum of len(c.rooms) over every live stream, kept incrementally because
	// the only alternative is walking the whole registry on every REGISTER.
	total int
	// Said once when total first reaches the ceiling, so the line does not
	// repeat per refused frame - which would be the disk-fill it prevents.
	totalCapLogged bool
}

func newRegistry() *registry {
	return &registry{
		rooms:   make(map[string]map[*connectedClient]struct{}),
		clients: make(map[string]map[*connectedClient]struct{}),
	}
}

// addStream admits a new rendezvous stream for a peer, or returns nil when the
// peer already holds maxStreamsPerPeer of them. An existing stream is never
// superseded: an earlier stream is far more likely to be the user's other tab
// than a stale session, and tearing it down made the two tabs reset each other
// forever, wiping the loser's room membership every round.
func (r *registry) addStream(peerId string, s rvStream) *connectedClient {
	r.mu.Lock()
	defer r.mu.Unlock()

	streams := r.clients[peerId]
	if len(streams) >= maxStreamsPerPeer {
		return nil
	}
	if streams == nil {
		streams = make(map[*connectedClient]struct{})
		r.clients[peerId] = streams
	}
	c := newConnectedClient(peerId, s)
	streams[c] = struct{}{}
	return c
}

// isLive reports whether this stream is still in the registry; caller holds
// r.mu. A stream that has been evicted must not put itself back into a room:
// nothing would ever clean that entry up again (RELAY-02).
func (r *registry) isLive(c *connectedClient) bool {
	_, ok := r.clients[c.peerId][c]
	return ok
}

// peerInRoom reports whether any of the room's streams belongs to peerId.
func peerInRoom(members map[*connectedClient]struct{}, peerId string) bool {
	for m := range members {
		if m.peerId == peerId {
			return true
		}
	}
	return false
}

func (r *registry) sendTo(c *connectedClient, msg serverMsg) {
	select {
	case <-c.done:
		// The client is already gone; its read loop runs the cleanup.
		return
	default:
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}
	// 4-byte big-endian length prefix to match the JS client framing
	frame := make([]byte, 4+len(data))
	frame[0] = byte(len(data) >> 24)
	frame[1] = byte(len(data) >> 16)
	frame[2] = byte(len(data) >> 8)
	frame[3] = byte(len(data))
	copy(frame[4:], data)

	select {
	case c.out <- frame:
		// Handed to this client's writer goroutine; the caller (some other
		// peer's read loop) never waits on the network.
	default:
		// A full outbox means the peer is not draining its stream. Dropping it
		// is the point: the alternative is blocking the caller on a write that
		// will not complete, which is how one dead tab stalled a whole room.
		// It has missed frames either way, so it has to reconnect to resync.
		log.Printf("[rv] %s is not reading its stream, dropping it", short(c.peerId))
		c.shutdown()
	}
}

// register admits c into room. It returns false only when the room had no
// OTHER member and this stream's maxEmptyRegisters budget was already spent -
// the empty-room-guess oracle case - in which case nothing happens: c is not
// added, no PEERS is sent, and the caller (readLoop) is left to log it. Every
// other path, including the existing caps above, returns true; they already
// log their own refusal here and need no extra signal to the caller.
func (r *registry) register(c *connectedClient, room string) bool {
	r.mu.Lock()

	// A stream the registry has already let go of - its read loop ended, or the
	// peer's last connection dropped and the libp2p backup cleaned up after it -
	// must not put itself back into a room, because nothing would ever remove
	// that entry again (RELAY-02).
	if !r.isLive(c) {
		r.mu.Unlock()
		return true
	}

	if _, already := c.rooms[room]; already {
		r.mu.Unlock()
		return true
	}
	if r.total >= maxTotalRegistrations {
		sayCapped := !r.totalCapLogged
		r.totalCapLogged = true
		r.mu.Unlock()
		if sayCapped {
			log.Printf("[rv] registry is at its %d-registration ceiling, ignoring further REGISTERs", maxTotalRegistrations)
		}
		return true
	}
	if len(c.rooms) >= maxRoomsPerPeer {
		sayCapped := !c.roomCapLogged
		c.roomCapLogged = true
		r.mu.Unlock()
		// Every line the registry writes is emitted with the lock released.
		// log.Printf takes its own mutex and then writes to stderr
		// synchronously - in docker, straight into the json-file logging driver
		// - so a line written under the single global registry lock puts every
		// other join and leave in the process behind that one write(2).
		if sayCapped {
			log.Printf("[rv] %s hit the %d-room cap, ignoring further REGISTERs", short(c.peerId), maxRoomsPerPeer)
		}
		return true
	}

	members := r.rooms[room]
	// Whether the room has an OTHER member has to be read right here, under
	// the same lock that is about to add c to it - a second lookup after
	// unlocking could race a concurrent register into the same room and
	// charge (or spare) the wrong REGISTER. An empty room is the oracle a
	// code guesser is fishing for, so only THAT case spends the budget; a
	// REGISTER into a room that already has somebody else in it is free.
	if len(members) == 0 && !c.emptyRegisters.allow(time.Now()) {
		r.mu.Unlock()
		return false
	}
	if members == nil {
		members = make(map[*connectedClient]struct{})
		r.rooms[room] = members
	}
	// Only a peer's FIRST stream in a room is a join the rest of the room hears
	// about. A second tab carries the same peerId, which everybody has already
	// dialled, so announcing it again would only churn their dials.
	announce := !peerInRoom(members, c.peerId)
	members[c] = struct{}{}
	c.rooms[room] = struct{}{}
	r.total++

	// Snapshot under the lock: who to notify (every stream except this peer's
	// own) and the peer list the joiner gets (one entry per distinct peerId,
	// never the joiner itself).
	targetClients := make([]*connectedClient, 0, len(members))
	others := make([]string, 0, len(members))
	seen := make(map[string]struct{}, len(members))
	for m := range members {
		if m.peerId == c.peerId {
			continue
		}
		targetClients = append(targetClients, m)
		if _, dup := seen[m.peerId]; dup {
			continue
		}
		seen[m.peerId] = struct{}{}
		others = append(others, m.peerId)
	}

	// Decide whether the join line is affordable while the budget is still
	// under the lock that guards it, and write it once the lock is gone.
	sayJoin, quiet := c.joinLeaveLog.allow(time.Now())

	r.mu.Unlock()

	if sayJoin {
		log.Printf("[rv] %s joined room [%s] (%d peers)", short(c.peerId), logSafe(room), len(others)+1)
		if quiet {
			sayQuiet(c.peerId)
		}
	}

	// Send notifications outside the lock. The joiner's own PEERS goes first:
	// it is the frame that answers the REGISTER, and queuing it behind a
	// broadcast to everyone else only delays the join for no reason.
	r.sendTo(c, serverMsg{Type: "PEERS", Room: room, Peers: others})
	if !announce {
		return true
	}
	for _, tc := range targetClients {
		r.sendTo(tc, serverMsg{
			Type: "PEER_JOINED",
			Room: room,
			Peer: c.peerId,
		})
	}
	return true
}

func (r *registry) unregister(c *connectedClient, room string) {
	r.mu.Lock()
	// Same guard as register: a stream the registry has let go of no longer
	// speaks for anyone.
	if !r.isLive(c) {
		r.mu.Unlock()
		return
	}
	targets, line := r.doUnregister(c, room)
	r.mu.Unlock()

	line.emit()

	// Send notifications outside the lock
	for _, tc := range targets {
		r.sendTo(tc, serverMsg{
			Type: "PEER_LEFT",
			Room: room,
			Peer: c.peerId,
		})
	}
}

// caller must hold r.mu
// returns the list of clients to notify about the departure, and the log line
// the caller should emit once it has released the lock. That list is empty
// when the peer is still in the room on another of its own streams: from the
// rest of the room's point of view nobody left, and a PEER_LEFT would stop
// them dialling a peer that is still there.
func (r *registry) doUnregister(c *connectedClient, room string) ([]*connectedClient, leaveLine) {
	members := r.rooms[room]
	if members == nil {
		return nil, leaveLine{}
	}
	if _, joined := members[c]; !joined {
		return nil, leaveLine{}
	}
	delete(members, c)
	delete(c.rooms, room)
	r.total--

	line := leaveLine{peerId: c.peerId, room: room}
	line.write, line.quiet = c.joinLeaveLog.allow(time.Now())
	if line.write {
		// The peer count exists only to fill in this line, so it is only worth
		// the map when the line is actually going to be written.
		line.peers = distinctPeers(members)
	}

	if len(members) == 0 {
		delete(r.rooms, room)
		return nil, line
	}
	// The peer is still in the room on another of its own streams - the user's
	// other tab - so from the rest of the room's point of view nobody left and
	// there is nobody to notify. This is the common case while a multi-tab peer
	// disconnects, and it used to build a targets slice only to throw it away.
	if peerInRoom(members, c.peerId) {
		return nil, line
	}

	// Nothing left in the room belongs to the departing peer, so every
	// remaining stream is one to notify.
	targets := make([]*connectedClient, 0, len(members))
	for m := range members {
		targets = append(targets, m)
	}
	return targets, line
}

// distinctPeers counts peerIds rather than streams: two tabs of one peer are
// one peer to everybody else in the room.
func distinctPeers(members map[*connectedClient]struct{}) int {
	seen := make(map[string]struct{}, len(members))
	for m := range members {
		seen[m.peerId] = struct{}{}
	}
	return len(seen)
}

// departure is one PEER_LEFT waiting to go out once the lock is released.
type departure struct {
	room   string
	client *connectedClient
}

// evict takes one stream out of every room it joined and out of r.clients.
// Caller must hold r.mu; the returned notifications are sent, and the returned
// lines logged, without it.
func (r *registry) evict(c *connectedClient) ([]departure, []leaveLine) {
	var notifications []departure
	var lines []leaveLine
	for room := range c.rooms {
		targets, line := r.doUnregister(c, room)
		if line.write {
			lines = append(lines, line)
		}
		for _, tc := range targets {
			notifications = append(notifications, departure{room, tc})
		}
	}
	streams := r.clients[c.peerId]
	delete(streams, c)
	if len(streams) == 0 {
		delete(r.clients, c.peerId)
	}
	return notifications, lines
}

// removeClient drops ONE stream: the rooms that stream registered, and nothing
// else. Another stream of the same peerId - the user's other tab - keeps its
// own memberships, which is the whole reason the registry is keyed by stream.
// It returns how many streams that peer still has open.
func (r *registry) removeClient(c *connectedClient) int {
	r.mu.Lock()
	if !r.isLive(c) {
		left := len(r.clients[c.peerId])
		r.mu.Unlock()
		c.shutdown()
		return left
	}
	notifications, lines := r.evict(c)
	left := len(r.clients[c.peerId])
	r.mu.Unlock()

	// Stop this client's writer goroutine, otherwise it outlives the session
	// for as long as the process runs.
	c.shutdown()

	for _, l := range lines {
		l.emit()
	}

	// Send notifications outside the lock
	for _, n := range notifications {
		r.sendTo(n.client, serverMsg{
			Type: "PEER_LEFT",
			Room: n.room,
			Peer: c.peerId,
		})
	}
	return left
}

// disconnectPeer drops every stream a peerId holds. It is the libp2p-level
// backup for the read loop and only runs once the peer has no connection left
// at all, so there is no other tab of that peer to protect at that point.
func (r *registry) disconnectPeer(peerId string) {
	r.mu.Lock()

	streams := r.clients[peerId]
	if len(streams) == 0 {
		r.mu.Unlock()
		return
	}
	doomed := make([]*connectedClient, 0, len(streams))
	for c := range streams {
		doomed = append(doomed, c)
	}
	// Evicting the streams one at a time means the room only reports the peer
	// as gone when its last stream leaves, so PEER_LEFT is still sent once.
	var notifications []departure
	var lines []leaveLine
	for _, c := range doomed {
		n, l := r.evict(c)
		notifications = append(notifications, n...)
		lines = append(lines, l...)
	}

	r.mu.Unlock()

	for _, l := range lines {
		l.emit()
	}
	lifecycleLogf("[rv] %s disconnected", short(peerId))

	// Stop the writer goroutines, otherwise they outlive the session for as
	// long as the process runs.
	for _, c := range doomed {
		c.shutdown()
	}

	// Send notifications outside the lock
	for _, n := range notifications {
		r.sendTo(n.client, serverMsg{
			Type: "PEER_LEFT",
			Room: n.room,
			Peer: peerId,
		})
	}
}

// ── Stream handler ────────────────────────────────────────────────────────────

// rvReadStream is what the read loop needs from a stream, split from
// rvStream (the write side, used by addStream/connectedClient/writeLoop) so a
// fake implementing just these methods can drive readLoop - including the
// idle-timeout path - without a real libp2p connection. network.Stream
// satisfies this implicitly.
type rvReadStream interface {
	rvStream
	io.Reader
	SetReadDeadline(time.Time) error
}

func (r *registry) handleStream(s network.Stream) {
	peerId := s.Conn().RemotePeer().String()
	lifecycleLogf("[rv] %s opened rendezvous stream", short(peerId))

	// Every stream stands on its own; an earlier stream from the same peerId is
	// left alone. Two tabs of the app share a peerId (the libp2p key lives in
	// localStorage and there is no leader election), so superseding meant each
	// tab reset the other's stream, the client reconnected two seconds later and
	// reset it back - a permanent flap that wiped the loser's rooms every round.
	// A stream that registers after the registry has let it go is what RELAY-02
	// was really about, and register/unregister guard that directly.
	c := r.addStream(peerId, s)
	if c == nil {
		lifecycleLogf("[rv] %s already holds %d rendezvous streams, refusing another", short(peerId), maxStreamsPerPeer)
		s.Reset()
		return
	}

	r.readLoop(s, peerId, c)

	// The count matters now that a peerId can hold several streams: "stream
	// closed" alone no longer means the peer is gone. removeClient is also
	// what tears the stream down (via c.shutdown) - the idle-timeout case
	// above ends up here exactly like any other read error.
	lifecycleLogf("[rv] %s stream closed (%d still open)", short(peerId), r.removeClient(c))
}

// readLoop reassembles length-prefixed frames from a rendezvous stream and
// dispatches each one, until s.Read errors - including an idle timeout, see
// rendezvousIdleTimeout. Split out of handleStream so a fake satisfying only
// rvReadStream can exercise it in tests.
func (r *registry) readLoop(s rvReadStream, peerId string, c *connectedClient) {
	// Read loop - reassemble length-prefixed frames
	const maxMsgLen = 8192 // Max size for a single frame (REGISTER/UNREGISTER payloads are tiny)
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 4096)

	// Every complaint this stream can provoke comes out of one small budget:
	// maxMsgLen has no lower bound, so a peer can stream tiny junk frames at
	// line rate and would otherwise get a log line for each one.
	budget := &logBudget{left: maxStreamLogLines}
	membershipOps := &opBudget{}
	warn := func(format string, args ...any) {
		if !budget.allow() {
			return
		}
		log.Printf(format, args...)
		if budget.spent() {
			log.Printf("[rv] %s used up its log budget, further complaints about this stream are dropped", short(peerId))
		}
	}

	// Set once the stream has registered a room; from then on it is a
	// legitimate quiet participant and gets no deadline.
	registered := false

readLoop:
	for {
		// A stream that never registers would otherwise pin this goroutine
		// and its registry entry forever - see rendezvousIdleTimeout.
		if registered {
			s.SetReadDeadline(time.Time{})
		} else {
			s.SetReadDeadline(time.Now().Add(rendezvousIdleTimeout))
		}
		n, err := s.Read(tmp)
		if err != nil {
			break
		}
		buf = append(buf, tmp[:n]...)

		for len(buf) >= 4 {
			msgLen := int(buf[0])<<24 | int(buf[1])<<16 | int(buf[2])<<8 | int(buf[3])
			// Reject oversized frames to prevent memory DoS. Abort the whole
			// stream - a plain `break` here would leave the bad length header in
			// buf and re-trip on every subsequent read while buf grows unbounded.
			if msgLen > maxMsgLen {
				log.Printf("[rv] message too large from %s: %d bytes, closing stream", short(peerId), msgLen)
				s.Reset()
				break readLoop
			}
			if len(buf) < 4+msgLen {
				break
			}
			payload := buf[4 : 4+msgLen]
			buf = buf[4+msgLen:]

			var msg clientMsg
			if err := json.Unmarshal(payload, &msg); err != nil {
				warn("[rv] bad message from %s: %v", short(peerId), err)
				continue
			}

			if msg.Type == "REGISTER" || msg.Type == "UNREGISTER" {
				if !validRoom(msg.Room) {
					warn("[rv] %s sent an unusable room id (%d bytes), ignoring", short(peerId), len(msg.Room))
					continue
				}
			}

			switch msg.Type {
			case "REGISTER", "UNREGISTER":
				// Refuse the OPERATION, not just its log line. Each membership
				// change fans a frame out to every other stream in the room,
				// and a peer flapping one shared room fills another member's
				// outbox in ~130 messages - at which point sendTo drops that
				// member, and dropping it evicts it from every room it holds,
				// including rooms the flapper was never in. A real client
				// registers each room once per connection.
				if !membershipOps.allow(time.Now()) {
					warn("[rv] %s is changing rooms faster than %d/%s, ignoring", short(peerId), maxMembershipOps, membershipOpWindow)
					continue
				}
				if msg.Type == "REGISTER" {
					// register only refuses (false) when the room had no OTHER
					// member and this stream's empty-register budget - the
					// room-code-guessing oracle case - was already spent. Warn
					// and drop the REGISTER exactly like an exhausted
					// membershipOps above: no PEERS goes out, so the guess
					// gets no answer, and there is nothing more to do with it.
					if !r.register(c, msg.Room) {
						warn("[rv] %s exhausted its empty-room register budget (%d/%s), ignoring", short(peerId), maxEmptyRegisters, emptyRegisterWindow)
						continue
					}
					registered = true
				} else {
					r.unregister(c, msg.Room)
				}
			default:
				warn("[rv] unknown type from %s: %s", short(peerId), logSafe(msg.Type))
			}
		}
	}
}

// Connection ceiling for the whole relay. The low mark is where the connection
// manager starts trimming idle peers, the high mark is a hard stop.
const (
	connMgrLow  = 256
	connMgrHigh = 512
)

// relayResources lifts the circuit-relay reservation ceilings for the same
// reason newResourceManager lifts the connection ones: behind Traefik every
// client reaches this process from ONE source IP, so go-libp2p's default
// MaxReservationsPerIP of 8 (circuitv2/relay/resources.go) is not a per-user
// limit at all - it is a global cap of 8 reservations for the whole
// deployment, and WithInfiniteLimits does not touch it (it only clears the
// per-circuit duration and byte Limit). A browser cannot listen, so every
// inbound connection to a peer runs through its relay reservation: past the
// ninth user, peers simply could not reach each other, and the app reported
// it as a reservation timeout.
func relayResources() relayv2.Resources {
	res := relayv2.DefaultResources()
	res.MaxReservations = connMgrHigh
	// Per-IP and per-ASN are meaningless while the proxy is the only peer we
	// see; the global ceiling above is the one that counts.
	res.MaxReservationsPerIP = connMgrHigh
	res.MaxReservationsPerASN = connMgrHigh
	return res
}

// newResourceManager builds the libp2p resource manager for the relay.
// Extracted so main_test.go can assert the ceiling it lifts.
func newResourceManager() (network.ResourceManager, error) {
	// EVERY browser reaches this process from a single source IP - Traefik's,
	// on the docker network - because the compose routes relay.<domain>
	// through it and nothing forwards the real client address.
	//
	// go-libp2p's DEFAULT resource manager caps concurrent connections at 8
	// per IPv4 /32 and new connections at 0.2/s (burst 16), exempting only
	// loopback. Behind a proxy those are not per-user limits protecting the
	// host: they are a GLOBAL ceiling of 8 live peers for the whole service,
	// refilling one every five seconds. Past it, connections are rejected at
	// accept - which is exactly the intermittent
	// "WebSocket connection to wss://relay... failed" users hit, and why
	// device sync (the one feature that opens a SECOND libp2p node per
	// device, doubling the count) tripped it first.
	//
	// So the per-subnet caps are raised to double the connection-manager
	// ceiling (connMgrHigh * 2 = 1024) and the connection rate limiter is
	// disabled: the connmgr (above) at 512 and the memory/stream limits from
	// DefaultLimits stay as the real protection. The resource manager's
	// System.ConnsInbound is also lifted to the same value so the connection
	// manager remains the binding limit rather than the resource manager
	// doing hard rejections.
	// Per-IP limits only become meaningful again if the client address ever
	// reaches us (PROXY protocol on the entrypoint, or a directly exposed
	// listener) - see docs/spec.md.
	subnetLimit := func(prefix int) rcmgr.ConnLimitPerSubnet {
		return rcmgr.ConnLimitPerSubnet{ConnCount: connMgrHigh * 2, PrefixLength: prefix}
	}
	// The memory-scaled defaults also cap TOTAL inbound connections
	// (System.ConnsInbound is 64 + 64*(scaledMiB/1024), so a small VPS lands
	// well under connMgrHigh * 2). Those are hard rejections, while the
	// connection manager trims gracefully, so the system connection numbers
	// are lifted to match the connection-manager ceiling and per-subnet cap,
	// keeping connmgr the binding limit. Memory, streams and file descriptors
	// keep the scaled defaults - they are the ones actually protecting the host.
	scaled := rcmgr.DefaultLimits.AutoScale()
	limits := scaled.ToPartialLimitConfig()
	limits.System.Conns = rcmgr.LimitVal(connMgrHigh * 2)
	limits.System.ConnsInbound = rcmgr.LimitVal(connMgrHigh * 2)
	limits.System.ConnsOutbound = rcmgr.LimitVal(connMgrHigh * 2)
	// Connections still being upgraded (noise + muxer) sit in the transient
	// scope, whose scaled default is a few hundred. A relay restart makes
	// every client reconnect at once, and those arrive as one burst.
	limits.Transient.Conns = rcmgr.LimitVal(connMgrHigh)
	limits.Transient.ConnsInbound = rcmgr.LimitVal(connMgrHigh)
	limits.Transient.ConnsOutbound = rcmgr.LimitVal(connMgrHigh)

	return rcmgr.NewResourceManager(
		rcmgr.NewFixedLimiter(limits.Build(scaled)),
		rcmgr.WithLimitPerSubnet(
			[]rcmgr.ConnLimitPerSubnet{subnetLimit(32)},
			[]rcmgr.ConnLimitPerSubnet{subnetLimit(56), subnetLimit(48)},
		),
		// Zero value = no rate limiting (see x/rate.Limiter).
		rcmgr.WithConnRateLimiters(&rate.Limiter{}),
	)
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	flag.Parse()

	os.MkdirAll("/app/data", os.ModePerm)
	priv := loadOrGenKey("/app/data/relay.key")

	connMgr, _ := connmgr.NewConnManager(connMgrLow, connMgrHigh)

	rm, err := newResourceManager()
	if err != nil {
		log.Fatalf("resource manager: %v", err)
	}
	// Say the ceiling out loud at boot. Resource-manager rejections are logged
	// at DEBUG by go-libp2p, so when the default per-IP cap was silently
	// refusing connections the relay logs looked perfectly healthy. Run with
	// GOLOG_LOG_LEVEL=rcmgr=debug to see individual rejections.
	log.Printf("[relay] connection limits: connmgr %d/%d, per-subnet cap %d",
		connMgrLow, connMgrHigh, connMgrHigh*2)

	// Get port from env or default to 8080
	httpPort := os.Getenv("HTTP_PORT")
	if httpPort == "" {
		httpPort = "8080"
	}

	// libp2p WebSocket
	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/tcp/%s/ws", httpPort)),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Security(libp2ptls.ID, libp2ptls.New),
		libp2p.Muxer("/yamux/1.0.0", yamux.DefaultTransport),
		libp2p.Transport(websocket.New),
		libp2p.ConnectionManager(connMgr),
		libp2p.ResourceManager(rm),
		libp2p.ForceReachabilityPublic(),
		libp2p.EnableRelay(),
		libp2p.EnableRelayService(
			relayv2.WithResources(relayResources()),
			relayv2.WithInfiniteLimits(),
		),
		libp2p.EnableHolePunching(),
		libp2p.EnableNATService(),
	)
	if err != nil {
		log.Fatal(err)
	}

	reg := newRegistry()
	h.SetStreamHandler(RendezvousProtocol, reg.handleStream)

	// HTTP server for OG and Klipy endpoints (run on separate internal port)
	apiPort := "8081"
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/og", getOnly(handleOgPreview))
		// the frontend fetches /og/preview (path inherited from the old signal server)
		mux.HandleFunc("/og/preview", getOnly(handleOgPreview))
		mux.HandleFunc("/klipy/search", getOnly(handleKlipySearch))
		mux.HandleFunc("/klipy/trending", getOnly(handleKlipyTrending))
		mux.HandleFunc("/turn-credentials", getOnly(handleTurnCredentials))
		mux.HandleFunc("/invite", postOnly(handleInviteCreate))
		mux.HandleFunc("/invite/", getOnly(handleInviteResolve))
		mux.HandleFunc("/plugin-proxy", getOnly(handlePluginProxy))
		mux.HandleFunc("/mailbox/deposit", handleMailboxDeposit)
		mux.HandleFunc("/mailbox/collect", handleMailboxCollect)
		mux.HandleFunc("/mailbox/ack", handleMailboxAck)
		startMailboxSweeper()
		log.Printf("[http] Starting API server on port %s", apiPort)
		server := &http.Server{
			Addr:              ":" + apiPort,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      15 * time.Second,
			IdleTimeout:       30 * time.Second,
		}
		if err := server.ListenAndServe(); err != nil {
			log.Printf("[http] API server error: %v", err)
		}
	}()

	// Clean up on libp2p disconnect (belt + suspenders with stream close)
	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(_ network.Network, c network.Conn) {
			// Deliberately NOT closing the peer's older connections here. Two
			// tabs of the app share one peerId (the device key lives in
			// localStorage), so "older connection from the same peer" cannot
			// be told apart from "the user's other tab" - closing it makes
			// live tabs kill each other's relay connection in a permanent
			// flap loop. Stale circuits from reloads are handled client-side
			// instead: streams are ping-confirmed before use and unanswered
			// connections are dropped there.
			lifecycleLogf("[peer] connect %s", short(c.RemotePeer().String()))
		},
		DisconnectedF: func(n network.Network, c network.Conn) {
			peerId := c.RemotePeer()
			// A peer that reconnected on a fresh connection is still Connected -
			// don't let this old connection's teardown evict the new session.
			// Only clean up when the peer is genuinely gone. (handleStream's
			// stream-close path is the authoritative cleanup.)
			if n.Connectedness(peerId) == network.Connected {
				return
			}
			lifecycleLogf("[peer] disconnect %s", short(peerId.String()))
			reg.disconnectPeer(peerId.String())
		},
	})

	printAddrs(h)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	h.Close()
}

func short(peerId string) string {
	if len(peerId) > 8 {
		return peerId[len(peerId)-8:]
	}
	return peerId
}

func loadOrGenKey(path string) crypto.PrivKey {
	data, err := os.ReadFile(path)
	if err == nil {
		priv, err := crypto.UnmarshalPrivateKey(data)
		if err == nil {
			return priv
		}
	}

	priv, _, err := crypto.GenerateEd25519Key(rand.Reader)
	if err != nil {
		log.Fatal(err)
	}
	data, err = crypto.MarshalPrivateKey(priv)
	if err != nil {
		log.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		log.Fatal(err)
	}
	return priv
}

func printAddrs(h host.Host) {
	log.Printf("PeerID: %s", h.ID())
	for _, ma := range h.Addrs() {
		log.Printf(" %s/p2p/%s", ma, h.ID())
	}
}
