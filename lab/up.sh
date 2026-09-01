#!/bin/bash
# Start (or restart) the lab's browsers and the origin they load from.
#
# The page server exists only to give Chrome a real http:// origin: a
# WebRTC page must be a secure context, and `about:blank` is not one. Every
# browser trusts that one origin explicitly rather than running with web
# security off, so what the lab measures is still what a user's browser does.
set -u
cd "$(dirname "$0")"
NET="${LAB_NET:-awful-lab}"
COUNT="${LAB_PEERS:-2}"
IMAGE="${LAB_BROWSER_IMAGE:-zenika/alpine-chrome:latest}"
# The address the app is served from. The browsers reach it as
# "http://localhost:5173" - see the resolver rule below.
APP_IP="${LAB_APP_IP:-172.30.0.12}"

# Why the resolver rule: WebRTC and WebCrypto need a SECURE CONTEXT, and
# http://<container-ip>:5173 is not one - crypto.subtle and
# navigator.mediaDevices are simply absent there, so the app cannot even
# create an identity, let alone open a microphone.
# --unsafely-treat-insecure-origin-as-secure did not take effect in this
# Chromium. Chrome always trusts "localhost", so the browsers resolve
# localhost to the frontend's address instead: a real secure context, no
# security switches disabled, and the app runs exactly as it does for a user.
#
# `--headless`, not `--headless=new`: the new headless shell ignores
# --remote-debugging-address and binds the debug port to loopback INSIDE the
# container, where nothing can reach it (Chromium 124). Checked, not assumed.
docker network create "$NET" >/dev/null 2>&1

docker rm -f lab-page >/dev/null 2>&1
docker run -d --name lab-page --network "$NET" \
  -v "$PWD/pages:/www:ro" -w /www node:22-slim \
  node -e '
    const http = require("http"), fs = require("fs"), path = require("path");
    http.createServer((req, res) => {
      const file = path.join("/www", path.normalize(req.url.split("?")[0]).replace(/^\/+/, "") || "blank.html");
      fs.readFile(file, (err, body) => {
        if (err) { res.writeHead(404); res.end("no"); return; }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      });
    }).listen(8000);
  ' >/dev/null

for i in $(seq 1 "$COUNT"); do
  name="lab-browser-$i"
  port=$((9330 + i))
  docker rm -f "$name" >/dev/null 2>&1
  # NET_ADMIN is what lets `impair.sh` shape this browser's own uplink from
  # inside its namespace, so one peer can be on a bad network while the
  # others are not - which is the whole point of the matrix.
  docker run -d --name "$name" --network "$NET" --cap-add=NET_ADMIN \
    --shm-size=1g -p "127.0.0.1:$port:9222" \
    --entrypoint chromium-browser "$IMAGE" \
      --headless --no-sandbox --disable-dev-shm-usage \
      --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 \
      --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
      --autoplay-policy=no-user-gesture-required \
      --host-resolver-rules="MAP localhost $APP_IP" \
      --user-data-dir="/tmp/prof-$i" \
      about:blank >/dev/null
done

for i in $(seq 1 "$COUNT"); do
  port=$((9330 + i))
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$port/json/version" >/dev/null && break
    sleep 0.5
  done
  curl -sf "http://127.0.0.1:$port/json/version" >/dev/null \
    || { echo "lab-browser-$i never opened its debug port"; exit 1; }
done
echo "lab up: $COUNT browsers on ports $((9331))..$((9330 + COUNT))"
