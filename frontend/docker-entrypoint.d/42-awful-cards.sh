#!/bin/sh
# Put the /qs and /qc link cards in use on an instance that serves those pages.
# nginx.conf includes every .conf in $ON; nginx-cards/ says what they do.
#
# Read out of the config.json that 40-awful-config.sh has just written, so the
# page and its card cannot disagree about a flag.
set -eu

CONFIG=${CONFIG:-/usr/share/nginx/html/config.json}
CARDS=${CARDS:-/etc/nginx/awful-cards}
ON=${ON:-/etc/nginx/awful-cards-on}

mkdir -p "$ON"
# A restarted container keeps its files, and the flag may be off now.
rm -f "$ON/qs.conf" "$ON/qc.conf"

if [ "$(jq -r .useQs "$CONFIG")" = true ]; then cp "$CARDS/qs.conf" "$ON/"; fi
if [ "$(jq -r .useQc "$CONFIG")" = true ]; then cp "$CARDS/qc.conf" "$ON/"; fi

echo "[awful] link cards: $(ls "$ON" | tr '\n' ' ')"
