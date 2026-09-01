#!/bin/bash
# Stop everything the lab started. Leaves images and the relay's identity
# volume alone, so the next `stack.sh` is fast and the peer id is unchanged.
set -u
cd "$(dirname "$0")"
docker rm -f lab-page $(docker ps -aq --filter "name=lab-browser-") >/dev/null 2>&1
LAB_RELAY_MULTIADDR=placeholder docker compose -f docker-compose.lab.yml down >/dev/null 2>&1
echo "lab down"
