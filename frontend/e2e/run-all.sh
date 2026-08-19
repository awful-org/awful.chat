#!/bin/bash
# Run every e2e scenario, restarting the browsers halfway so Firefox memory
# stays flat (a full day of runs against the same instances once OOMed the
# machine). Exits nonzero if any scenario fails.
set -u
cd "$(dirname "$0")"
FIRST="dm-extras sync-recovers dm-removal title-and-sound dtln-gain clock-skew"
SECOND="room-removal reconnect-churn audio-prefs peer-volume background-sync rapid-switch drag-drop call-status call-roster-ttl history-pull"
fail=0
run() {
  for sc in $1; do
    echo "== $sc"
    if ! node "scenarios/$sc.mjs"; then fail=1; fi
  done
}
./browsers.sh >/dev/null || exit 1
run "$FIRST"
./browsers.sh >/dev/null || exit 1
run "$SECOND"
[ "$fail" -eq 0 ] && echo "ALL SCENARIOS PASSED" || echo "FAILURES ABOVE"
exit $fail
