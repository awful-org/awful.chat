package main

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	libp2p "github.com/libp2p/go-libp2p"
	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/host"
	"github.com/libp2p/go-libp2p/p2p/muxer/yamux"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"github.com/libp2p/go-libp2p/p2p/security/noise"
	libp2ptls "github.com/libp2p/go-libp2p/p2p/security/tls"
	"github.com/libp2p/go-libp2p/p2p/transport/websocket"
)

func main() {
	wsPort := flag.Int("ws-port", 9000, "WebSocket listen port (browsers connect here)")
	flag.Parse()

	priv := loadOrGenKey("data/relay.key")

	connMgr, err := connmgr.NewConnManager(256, 512)
	if err != nil {
		log.Fatal(err)
	}

	h, err := libp2p.New(
		libp2p.Identity(priv),
		libp2p.ListenAddrStrings(
			fmt.Sprintf("/ip4/0.0.0.0/tcp/%d/ws", *wsPort),
			fmt.Sprintf("/ip6/::/tcp/%d/ws", *wsPort),
		),
		libp2p.Security(noise.ID, noise.New),
		libp2p.Security(libp2ptls.ID, libp2ptls.New),
		libp2p.Muxer("/yamux/1.0.0", yamux.DefaultTransport),
		libp2p.Transport(websocket.New),
		libp2p.ConnectionManager(connMgr),
		// Force public reachability so EnableRelayService activates immediately.
		libp2p.ForceReachabilityPublic(),
		libp2p.EnableRelayService(
			relayv2.WithInfiniteLimits(), // production: swap for resource-bound limits
		),
		// Browsers don't hole-punch, but server-side holepunch service helps
		// native peers that connect through us coordinate direct connections.
		libp2p.EnableHolePunching(),
		libp2p.DisableRelay(), // relay server doesn't need to dial via relays itself
	)
	if err != nil {
		log.Fatal(err)
	}

	printAddrs(h)

	// Block until SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	<-ctx.Done()

	log.Println("shutting down")
	h.Close()
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
	log.Printf("PeerID: %s\n", h.ID())
	log.Println("Listening on:")
	for _, ma := range h.Addrs() {
		log.Printf("  %s/p2p/%s\n", ma, h.ID())
	}
}
