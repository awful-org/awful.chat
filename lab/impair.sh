#!/bin/bash
# Shape one browser's network, from inside its own namespace.
#
#   ./impair.sh lab-browser-2 loss3      # 3% loss, both directions
#   ./impair.sh lab-browser-2 clean      # back to normal
#
# Each profile is a network a real user actually has. The point is never to
# break a call - it is to run the SAME scenario on a good network and a bad
# one, because a finding that appears in both is the code and a finding that
# only appears on the bad one is the network. That comparison is the only
# reliable way to answer "is it my internet or your app", and no amount of
# per-event cleverness substitutes for it.
set -u
CONTAINER="${1:?usage: impair.sh <container> <profile>}"
PROFILE="${2:?usage: impair.sh <container> <profile>}"
IFACE="${LAB_IFACE:-eth0}"

run() {
  docker run --rm --network "container:$CONTAINER" --cap-add=NET_ADMIN \
    lab-netem:latest "$1"
}

# netem shapes egress only. Ingress needs an ifb device, which is more moving
# parts than this needs: two peers each shaped on egress produces a path that
# is degraded in both directions, which is the condition being tested.
case "$PROFILE" in
  clean)
    run "tc qdisc del dev $IFACE root 2>/dev/null; iptables -F OUTPUT 2>/dev/null; true"
    ;;
  loss3)
    # Enough to hurt audio, far short of a disconnect: the shape users
    # describe as "it was breaking up" rather than "the call dropped".
    run "tc qdisc replace dev $IFACE root netem loss 3%"
    ;;
  loss15)
    run "tc qdisc replace dev $IFACE root netem loss 15%"
    ;;
  jitter)
    # Mobile on a good day: latency that moves, which is what actually
    # defeats a jitter buffer.
    run "tc qdisc replace dev $IFACE root netem delay 150ms 60ms distribution normal"
    ;;
  slow)
    run "tc qdisc replace dev $IFACE root netem delay 300ms rate 500kbit"
    ;;
  reorder)
    run "tc qdisc replace dev $IFACE root netem delay 20ms reorder 10% 50%"
    ;;
  udp-block)
    # Everything but DNS. A blanket UDP drop also kills name resolution, which
    # stops the browser reaching the relay at all - that is a broken lab, not a
    # corporate firewall, and it fails so early that nothing about ICE is
    # tested. Real restrictive networks permit 53 and drop the rest, so ICE
    # must fall back to TURN over TCP or fail.
    #
    # `--dport 53` alone is NOT enough, and the way it fails is silent. Docker
    # runs its embedded resolver behind a DNAT in the container's own
    # namespace: 127.0.0.11:53 is rewritten to a high port by nat/OUTPUT,
    # which runs BEFORE filter/OUTPUT, so the rule below never sees port 53
    # and every lookup is dropped. The browser then cannot resolve the relay
    # and the run looks like a connectivity bug in the app. Accepting loopback
    # first is what makes this profile test ICE rather than DNS.
    run "iptables -A OUTPUT -o lo -j ACCEPT; iptables -A OUTPUT -p udp --dport 53 -j ACCEPT; iptables -A OUTPUT -p udp -j DROP"
    ;;
  blackout)
    # Everything except loopback: the tab keeps running, its network is gone.
    # A tunnel, a lift, a wifi handover. The question this profile asks is not
    # whether a call survives the outage - it cannot - but whether it comes
    # back afterwards, which is repair logic rather than setup logic.
    run "iptables -A OUTPUT -o lo -j ACCEPT; iptables -A OUTPUT -j DROP"
    ;;
  *)
    echo "unknown profile: $PROFILE" >&2
    echo "profiles: clean loss3 loss15 jitter slow reorder udp-block blackout" >&2
    exit 2
    ;;
esac
echo "$CONTAINER: $PROFILE"
