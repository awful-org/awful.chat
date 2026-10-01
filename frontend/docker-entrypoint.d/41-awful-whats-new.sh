#!/bin/sh
# Write /whats-new.json: the last few pull requests merged into main, for
# Settings > What's new.
#
# Fetched HERE, by the server at start, and served from the instance's own
# origin: the app never asks GitHub anything, so no user's address reaches
# it, and the file is not part of the bundle, so the byte-identical build
# awful-verify checks stays byte-identical.
#
# The repository is the one this build says it came from
# (/.well-known/awful-build.json), so a fork lists its own pull requests.
#
# Best effort and off the startup path: nginx does not wait for GitHub. A
# failure (offline, rate limited - 60 requests an hour unauthenticated, and
# this is one per start) leaves no file, the route answers 404, and the tab
# says there is nothing to show.
set -eu

HTML=/usr/share/nginx/html
OUT=$HTML/whats-new.json
BUILD=$HTML/.well-known/awful-build.json
COUNT=5

# WHATS_NEW=0 keeps this server from contacting GitHub at all; the tab then
# says there is nothing to show.
case $(printf '%s' "${APP_WHATS_NEW:-${WHATS_NEW:-1}}" | tr '[:upper:]' '[:lower:]') in
  0 | false | no | off)
    echo "[awful] what's new: off (WHATS_NEW)"
    exit 0
    ;;
esac

fetch_whats_new() {
  repo=$(jq -r '.repository // empty' "$BUILD" 2>/dev/null || true)
  case $repo in
    github.com/*/*) slug=${repo#github.com/} ;;
    *)
      echo "[awful] what's new: no GitHub repository in $BUILD, skipped"
      return 0
      ;;
  esac

  tmp=$(mktemp)
  # Sorted by update, not merge: the API cannot sort by merge date, so take
  # a page and sort here. Closed-unmerged pull requests drop out.
  if ! wget -q -T 10 -O "$tmp" \
      --header "Accept: application/vnd.github+json" \
      "https://api.github.com/repos/$slug/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=50"; then
    echo "[awful] what's new: GitHub did not answer, skipped"
    rm -f "$tmp"
    return 0
  fi

  if jq --argjson n "$COUNT" '
      [ .[] | select(.merged_at != null) ]
      | sort_by(.merged_at) | reverse | .[:$n]
      | map({
          number,
          title,
          mergedAt: .merged_at,
          url: .html_url,
          body: ((.body // "") | .[0:6000])
        })
    ' "$tmp" > "$tmp.out" 2>/dev/null; then
    chmod 644 "$tmp.out"
    # Whole or not at all: nginx may serve the file while this runs.
    mv "$tmp.out" "$OUT"
    echo "[awful] what's new: wrote $(jq length "$OUT") pull requests from $slug"
  else
    echo "[awful] what's new: unexpected answer from GitHub, skipped"
    rm -f "$tmp.out"
  fi
  rm -f "$tmp"
}

fetch_whats_new &
