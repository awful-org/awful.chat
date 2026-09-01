#!/bin/bash
# Bring up the app for the lab, then the browsers that will drive it.
#
# The relay's peer id is not knowable before it boots and is not guessable, so
# this starts the relay first, reads the identity it prints, and only then
# starts the frontend that has to dial it. The id is stable across restarts
# because the key lives in a volume.
set -eu
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.lab.yml"

echo "== relay"
LAB_RELAY_MULTIADDR=placeholder $COMPOSE up -d relay sfu >/dev/null

PEER_ID=""
for _ in $(seq 1 60); do
  PEER_ID=$(docker logs awful-lab-relay-1 2>&1 | grep -oE 'PeerID: [A-Za-z0-9]+' | tail -1 | cut -d' ' -f2)
  [ -n "$PEER_ID" ] && break
  sleep 1
done
[ -n "$PEER_ID" ] || { echo "relay never printed a PeerID"; exit 1; }
echo "   relay peer id: $PEER_ID"

# /dns4/relay, not an IP: the browsers resolve service names on this network,
# and an address that survives a subnet change is one less thing to fix later.
export LAB_RELAY_MULTIADDR="/dns4/relay/tcp/8080/ws/p2p/$PEER_ID"
echo "$LAB_RELAY_MULTIADDR" > .relay-multiaddr

# Not http://frontend:5173: Vite 7 answers 403 for a Host header that is not
# in `server.allowedHosts`, and changing the app's vite config to please the
# lab would be the wrong way round. "localhost" is allowed by Vite AND
# trusted by Chrome, which the readiness probe below reaches by IP.
# localhost, resolved to the frontend container by each browser (see up.sh):
# it is the only way to get a secure context without terminating TLS.
APP_URL="http://localhost:5173"

echo "== frontend"
$COMPOSE up -d frontend >/dev/null
# Vite has to answer before a browser is pointed at it, or the first
# navigation lands on a connection refused and the run reads as an app fault.
for _ in $(seq 1 90); do
  docker run --rm --network awful-lab curlimages/curl:latest -sf http://172.30.0.12:5173 >/dev/null 2>&1 && break
  sleep 1
done

echo "== browsers"
LAB_NET=awful-lab LAB_APP_IP=172.30.0.12 ./up.sh
echo
echo "$APP_URL" > .app-url
echo "app:   $APP_URL (inside the lab network)"
echo "relay: http://127.0.0.1:18081 (operator endpoints, from the host)"
