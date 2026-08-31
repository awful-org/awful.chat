#!/bin/sh
# Write /config.json from the container's environment, at start.
#
# The relay and SFU addresses are served as a file rather than compiled in.
# Inlined, they would make every instance ship a different bundle from
# identical source, so no published per-commit hash could describe any of
# them. One build, many instances.
#
# nginx's own entrypoint runs every /docker-entrypoint.d/*.sh before it starts
# the server, so there is nothing to wire up beyond the executable bit.
#
# There is NO build-time fallback behind this any more: the Dockerfile no
# longer declares the VITE_* args and a production bundle carries no addresses
# at all. An operator upgrading from a compose file that set them as
# `build.args` only will get an instance with no relay, so unset values are a
# loud warning here rather than a quiet empty file.
set -eu

OUT=/usr/share/nginx/html/config.json

# Either name is accepted. APP_* is what these are now: runtime configuration,
# read by the server at start. The VITE_* spellings are the ones already in
# every operator's .env, so an upgrade needs no rename - but they must reach
# the container as ENVIRONMENT, not as build args, which is what
# docker-compose.dokploy.yml was changed to do.
api_url=${APP_API_URL:-${VITE_API_URL:-}}
relay=${APP_RELAY_MULTIADDR:-${VITE_RELAY_MULTIADDR:-}}
sfu=${APP_SFU_URLS:-${VITE_SFU_URLS:-${APP_SFU_URL:-${VITE_SFU_URL:-}}}}

# JSON forbids a raw control character inside a string, so a value carrying a
# stray CR - a .env saved with CRLF line endings, a paste through a web UI -
# would produce a file the app cannot parse. It is dropped rather than
# escaped: no url or multiaddr contains one on purpose, and the alternative
# is an instance that starts clean and has no relay. A backslash and a quote
# are escaped for the same reason.
esc() {
  printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Comma separated list -> JSON array, empty entries dropped.
sfu_json=$(
  # printf '%s\n', not '%s': read returns false on a final line with no
  # newline, and the loop then drops the last url on the floor.
  printf '%s\n' "$sfu" | tr ',' '\n' | while IFS= read -r u; do
    u=$(printf '%s' "$u" | tr -d ' \t')
    [ -n "$u" ] && printf '"%s",' "$(esc "$u")"
  done | sed 's/,$//'
)

cat > "$OUT" <<JSON
{
  "apiUrl": "$(esc "$api_url")",
  "relayMultiaddr": "$(esc "$relay")",
  "sfuUrls": [$sfu_json]
}
JSON

echo "[awful] wrote $OUT (api=${api_url:-unset} relay=${relay:-unset} sfu=${sfu:-unset})"

# Nothing configured means nothing works: no relay to dial, no API. It is
# worth being noisy about, because the container is otherwise healthy and the
# app just silently fails to connect.
if [ -z "$api_url" ] && [ -z "$relay" ]; then
  echo "[awful] WARNING: neither APP_API_URL/VITE_API_URL nor" \
       "APP_RELAY_MULTIADDR/VITE_RELAY_MULTIADDR is set in this container's" \
       "ENVIRONMENT. They are no longer build args - a compose file that only" \
       "passes them under build.args leaves this instance unable to connect." >&2
fi
