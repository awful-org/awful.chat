package main

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptls "github.com/libp2p/go-libp2p/p2p/security/tls"
	"github.com/libp2p/go-libp2p/p2p/transport/websocket"
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

type connectedClient struct {
	peerId string
	stream network.Stream
	rooms  map[string]struct{}
}

type registry struct {
	mu      sync.Mutex
	rooms   map[string]map[string]struct{} // room → set of peerIds
	clients map[string]*connectedClient    // peerId → client
}

func newRegistry() *registry {
	return &registry{
		rooms:   make(map[string]map[string]struct{}),
		clients: make(map[string]*connectedClient),
	}
}

func (r *registry) sendTo(c *connectedClient, msg serverMsg) {
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
	c.stream.Write(frame)
}

func (r *registry) broadcastToRoom(room string, msg serverMsg, excludePeer string) {
	peers := r.rooms[room]
	for pid := range peers {
		if pid == excludePeer {
			continue
		}
		if c, ok := r.clients[pid]; ok {
			r.sendTo(c, msg)
		}
	}
}

func (r *registry) register(c *connectedClient, room string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.rooms[room] == nil {
		r.rooms[room] = make(map[string]struct{})
	}
	if _, already := r.rooms[room][c.peerId]; already {
		return
	}

	r.rooms[room][c.peerId] = struct{}{}
	c.rooms[room] = struct{}{}

	log.Printf("[rv] %s joined room [%s] (%d peers)", short(c.peerId), room, len(r.rooms[room]))

	// Notify existing peers
	r.broadcastToRoom(room, serverMsg{
		Type: "PEER_JOINED",
		Room: room,
		Peer: c.peerId,
	}, c.peerId)

	// Send full peer list to the joiner
	others := make([]string, 0)
	for pid := range r.rooms[room] {
		if pid != c.peerId {
			others = append(others, pid)
		}
	}
	r.sendTo(c, serverMsg{Type: "PEERS", Room: room, Peers: others})
}

func (r *registry) unregister(c *connectedClient, room string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.doUnregister(c, room)
}

// caller must hold r.mu
func (r *registry) doUnregister(c *connectedClient, room string) {
	peers := r.rooms[room]
	if peers == nil {
		return
	}
	delete(peers, c.peerId)
	delete(c.rooms, room)

	log.Printf("[rv] %s left room [%s] (%d peers)", short(c.peerId), room, len(peers))

	if len(peers) == 0 {
		delete(r.rooms, room)
	} else {
		r.broadcastToRoom(room, serverMsg{
			Type: "PEER_LEFT",
			Room: room,
			Peer: c.peerId,
		}, "")
	}
}

func (r *registry) disconnect(peerId string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	c, ok := r.clients[peerId]
	if !ok {
		return
	}

	for room := range c.rooms {
		r.doUnregister(c, room)
	}
	delete(r.clients, peerId)
	log.Printf("[rv] %s disconnected", short(peerId))
}

// ── Stream handler ────────────────────────────────────────────────────────────

func (r *registry) handleStream(s network.Stream) {
	peerId := s.Conn().RemotePeer().String()
	log.Printf("[rv] %s opened rendezvous stream", short(peerId))

	r.mu.Lock()
	// clean up any stale entry from a previous connection
	if old, ok := r.clients[peerId]; ok {
		for room := range old.rooms {
			r.doUnregister(old, room)
		}
	}
	c := &connectedClient{
		peerId: peerId,
		stream: s,
		rooms:  make(map[string]struct{}),
	}
	r.clients[peerId] = c
	r.mu.Unlock()

	// Read loop — reassemble length-prefixed frames
	buf := make([]byte, 0, 512)
	tmp := make([]byte, 4096)

	for {
		n, err := s.Read(tmp)
		if err != nil {
			break
		}
		buf = append(buf, tmp[:n]...)

		for len(buf) >= 4 {
			msgLen := int(buf[0])<<24 | int(buf[1])<<16 | int(buf[2])<<8 | int(buf[3])
			if len(buf) < 4+msgLen {
				break
			}
			payload := buf[4 : 4+msgLen]
			buf = buf[4+msgLen:]

			var msg clientMsg
			if err := json.Unmarshal(payload, &msg); err != nil {
				log.Printf("[rv] bad message from %s: %v", short(peerId), err)
				continue
			}

			switch msg.Type {
			case "REGISTER":
				r.register(c, msg.Room)
			case "UNREGISTER":
				r.unregister(c, msg.Room)
			default:
				log.Printf("[rv] unknown type from %s: %s", short(peerId), msg.Type)
			}
		}
	}

	log.Printf("[rv] %s stream closed", short(peerId))
	r.disconnect(peerId)
}

// ── Main ──────────────────────────────────────────────────────────────────────

func main() {
	wsPort := flag.Int("ws-port", 9000, "libp2p WebSocket port")
	flag.Parse()

	os.MkdirAll("/app/data", os.ModePerm)
	priv := loadOrGenKey("/app/data/relay.key")

	connMgr, _ := connmgr.NewConnManager(256, 512)

	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(fmt.Sprintf("/ip4/0.0.0.0/tcp/%d/ws", *wsPort)),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Security(libp2ptls.ID, libp2ptls.New),
		libp2p.Muxer("/yamux/1.0.0", yamux.DefaultTransport),
		libp2p.Transport(websocket.New),
		libp2p.ConnectionManager(connMgr),
		libp2p.ForceReachabilityPublic(),
		libp2p.EnableRelay(),
		libp2p.EnableRelayService(relayv2.WithInfiniteLimits()),
		libp2p.EnableHolePunching(),
		libp2p.EnableNATService(),
	)
	if err != nil {
		log.Fatal(err)
	}

	reg := newRegistry()
	h.SetStreamHandler(RendezvousProtocol, reg.handleStream)

	// HTTP server for OG and Klipy endpoints
	go startHTTPServer()

	// Clean up on libp2p disconnect (belt + suspenders with stream close)
	h.Network().Notify(&network.NotifyBundle{
		ConnectedF: func(_ network.Network, c network.Conn) {
			log.Printf("[peer] connect %s", short(c.RemotePeer().String()))
		},
		DisconnectedF: func(_ network.Network, c network.Conn) {
			log.Printf("[peer] disconnect %s", short(c.RemotePeer().String()))
			reg.disconnect(c.RemotePeer().String())
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

func startHTTPServer() {
	mux := http.NewServeMux()
	mux.HandleFunc("/og", handleOgPreview)
	mux.HandleFunc("/klipy/search", handleKlipySearch)
	mux.HandleFunc("/klipy/trending", handleKlipyTrending)

	port := os.Getenv("HTTP_PORT")
	if port == "" {
		port = "3000"
	}

	log.Printf("[http] Starting on port %s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Printf("[http] Server error: %v", err)
	}
}
