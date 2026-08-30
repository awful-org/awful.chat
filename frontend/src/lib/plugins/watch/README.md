# watch: shared sync library for video watch-party plugins

## What this is for

A watch-party plugin does not send video. Every participant opens their
own local file. This library answers the one hard problem that design
creates: given a snapshot of where the other person's player is, how do
you keep your own player in step with theirs, over a network with
variable delay, without the correction itself being visible or audible.

This module is pure and synchronous. No DOM element, no `setTimeout`, no
network call lives here. It reads a `WatchTick` and clock samples and
returns numbers and an action name. The caller — the plugin — owns the
`<video>` element, the round-trip ping, and the timer loop that calls
this library on an interval.

## Why a bare `{playing, position}` snapshot cannot hold video in sync

The comparable plugin already in this repo, `waffle-party`, models its
shared state as `MusicState { playing: boolean; position: number }` — an
absolute position with no timestamp and no rate. That is fine for a music
plugin where being a couple of seconds off just means one person's chorus
lands a beat late. It fails for video.

The reason is that a bare position number starts going stale the instant
it is written. Every reader applies it at a different wall-clock moment,
so two clients that receive the exact same update land at two different
positions, and nothing in the shape ever corrects the gap afterward.
waffle-party is honest about this in its own README: it does not "promise
frame-accurate synchronization." For video, a gap of even one or two
seconds means one participant sees a reaction shot, a joke, or a spoiler
before the other has seen the frame that causes it.

The fix is to never send a bare position. Send an anchor: a position, the
sender's wall-clock time when that position was true, and the rate
playback was running at. A reader with an anchor and its own estimate of
clock offset can compute "where should playback be right now" at any
later instant, not just at the instant the update was sent. That anchor
is `WatchTick`, and computing "where should it be now" from it is
`projectPosition`.

## The clock problem

`WatchTick.atMs` is a timestamp on the sender's clock, not the reader's.
Two computers rarely agree on wall-clock time to better than a few
hundred milliseconds, and skew drifts over a session. Before a
`WatchTick` is useful, the reader needs an estimate of the offset between
the two clocks.

`estimateClock` takes NTP-style round-trip samples (`t0` you send, `t1`
they receive, `t2` they reply, `t3` you receive the reply) and returns
the classic NTP offset and round-trip-time estimate. It takes the
**median** across samples, not the mean, because one slow, reordered, or
NAT-mangled packet skews a mean but cannot move a median as long as it
stays a minority of the batch. `samples` in the result is the count of
samples that went in, so a caller can decide not to act on an estimate
built from only one or two of them.

## The control law

This is Syncplay's three-band controller, copied because it is a decade
of production tuning against exactly this problem, not because the exact
numbers are sacred. Source: `syncplay/constants.py`, quoted verbatim in
the anime feasibility research (finding 10). Every constant below is that
source, or is derived from a line of that source's own prose — the
comments in `sync.ts` say which for each one.

| band | Syncplay source | this module |
| --- | --- | --- |
| dead band: drift is small, do nothing | `SEEK_THRESHOLD = 1`, kick-in `DEFAULT_SLOWDOWN_KICKIN_THRESHOLD = 1.5` | `rateThresholdMs = 1500` |
| rate band: drift is medium, nudge the rate | `SLOWDOWN_RATE = 0.95` ahead; 5% change described as inaudible either direction | `slowRate = 0.95`, `fastRate = 1.05` |
| rate band exit: keep correcting until drift is almost gone | `SLOWDOWN_RESET_THRESHOLD = 0.1` | `maxRateCorrectionMs = 100` |
| seek band: drift is large, jump | `DEFAULT_REWIND_THRESHOLD = 4` | `seekThresholdMs = 4000` |

Syncplay splits "ahead of the group" and "behind the group" into
slightly different thresholds (1.5 s vs 1.75 s to start a rate
correction, 4 s vs 5 s to seek). This module uses one number per band,
the stricter (smaller) of Syncplay's two, so a correction in either
direction never waits longer than Syncplay's own most aggressive case.

`fastRate = 1.05` is the one number here that is not a literal Syncplay
constant name. Syncplay names no symmetric speed-up rate for the behind
case; its own text describes the general mechanism as "a 5% rate change
is neither [visible nor audible]." `1.05` mirrors `SLOWDOWN_RATE = 0.95`
under that same description.

Why rate correction at all, instead of just seeking every time drift is
non-zero: a seek is a visible jump and an audible pop. A 5% rate change
is neither. Small, steady drift gets absorbed quietly; only drift too
large to close quietly gets a seek.

`decideCorrection` also handles the case a pure position controller
cannot: `local.paused !== tick.paused`. If the two disagree on whether
playback is running at all, that is corrected first, alone, with
`"pause"` or `"resume"` — there is no point computing a rate correction
for a player that is about to stop or start.

## Honest limits

- This is close sync, not frame-accurate sync. The seek band alone is 4
  seconds wide; two players can legitimately differ by up to that much
  before either corrects.
- Every participant needs their own copy of the same release of the same
  episode. Different cuts, different framerates, or different pre-roll
  put positions offset by seconds that this library reads as ordinary
  drift and cannot tell apart from network skew.
- Clock offset estimation needs several round-trip samples to be
  trustworthy. `estimateClock` reports `samples` back for exactly this
  reason: check it before trusting a one-sample estimate.
- Nothing here checks that two files actually contain the same video.
  That check, if a plugin wants one, belongs in the plugin, not here.
