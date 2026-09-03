#!/bin/bash
# Run every e2e scenario, with fresh browsers before each one.
#
# Restarting per group was not enough: scenarios that pass in isolation failed
# partway through a long run - rooms never entering, peers never coming back,
# and eventually "Maximum number of active sessions" - which reads as an app
# bug and is not one. A restart costs about thirteen seconds; a false failure
# costs a great deal more than that.
set -u
cd "$(dirname "$0")"
SCENARIOS="dm-extras sync-recovers dm-removal title-and-sound dtln-gain clock-skew
room-removal reconnect-churn audio-prefs peer-volume background-sync rapid-switch
drag-drop room-clock backfill-below-window call-status call-roster-ttl
call-late-join call-join-speed call-without-sfu relay-upgrade history-pull mobile-shell
device-sync"
fail=0
failed=""
for sc in $SCENARIOS; do
  ./browsers.sh >/dev/null || exit 1
  echo "== $sc"
  if ! node "scenarios/$sc.mjs"; then
    fail=1
    failed="$failed $sc"
  fi
done
if [ "$fail" -eq 0 ]; then
  echo "ALL SCENARIOS PASSED"
else
  echo "FAILED:$failed"
fi
exit $fail
