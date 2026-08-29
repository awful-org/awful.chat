# Call picture-in-picture

Keep the call in view when the stage is not: in a floating panel when the
user navigates to a DM, another room or settings, and in the browser's own
PiP window when they switch tabs. What the panel shows follows Zoom's rule:
a pinned tile wins, otherwise a screen share being watched, otherwise
whoever is talking.

## What exists today

- The stage (`VoiceVideoCallView.svelte`) is rendered by `ChatView` only
  while the conversation on screen is the call's room
  (`ChatView.svelte:162`). Leaving the room unmounts it; the call itself
  survives (`AppView.returnToCall` is pure navigation).
- Remote media lives in `transportState.participants` (peerId ->
  `{audioTrack, videoTrack, screenTrack, screenAudioTrack}`), written by
  `voice.svelte.ts` and `transmission.svelte.ts`. Cameras are consumed
  automatically; a screen share is consumed only after `watchTransmission`
  (`transportState.watchingTransmissionPeerId`). Both outlive the stage.
- Voice audio plays through Web Audio inside `LibP2PVoice`, not through the
  stage, so leaving the room never mutes anyone.
- Two things die with the stage and must not: speaker detection (the
  `AnalyserNode` loop at `VoiceVideoCallView.svelte:242-370`) and the focus
  (`focusedTileId`, the stage's pin).
- `FloatingDmPanel` + `dm-panel.svelte.ts` is the pattern for a floating
  surface: a leaf `$state` store with `x/y/minimized`, the `draggable`
  action, mounted once in `AppView`.
- `transportState.uiRoomCode` is the room the UI is on; `callRoomCode` is
  the call's. The panel exists exactly when they differ while `inCall`.
- `plugins/media-session.ts` owns `navigator.mediaSession`; any new action
  handler goes through it.

## Spotlight rule

One function, pure, unit-tested, shared by the panel, the browser PiP
video and (later) the stage's own focus default:

```
spotlight(tiles, pin, watching, speakers, previous) -> tileId | null
```

1. `pin` set and still present -> pin. A pin is manual and sticky: it clears
   only when the user unpins or the tile disappears (peer leaves, share
   ends).
2. Else a screen share: the one being watched
   (`watchingTransmissionPeerId`), otherwise any remote `screenTrack`, newest
   first. Never the user's own share.
3. Else the active speaker: the remote peer that has been speaking most
   recently, with hysteresis so the panel does not flicker: a new speaker
   takes over only after 1.5 s of continuous speech, the current one keeps
   the spot for 2 s of silence. Among ties prefer a peer with a camera on.
4. Else `previous` if still present, else the first remote peer with a
   camera, else the first remote peer (avatar tile).
5. Only the user in the call -> the local camera tile.

A spotlight change is a change of `tileId`; the panel swaps the
`srcObject` of ONE `<video>` element rather than remounting, which is what
keeps browser PiP following along.

## Stores (new, leaf modules, no transport imports)

`call-focus.svelte.ts`

```
pinnedTileId: string | null      // moved out of VoiceVideoCallView
```

The stage's focus becomes this store: pin on the stage = pin in the panel
and vice versa, and it survives navigation. The stage's "auto focus"
(`$effect` clearing a vanished focus) moves with it.

`speakers.svelte.ts`

```
speaking: Set<peerId>
lastSpokeAt: Map<peerId, number>
```

The analyser loop extracted from the stage, verbatim, subscribed to
`transportState.participants` audio tracks and run while `inCall`, not
while the stage is mounted. The stage reads `speaking` for its rings; the
spotlight reads `lastSpokeAt`. One `AudioContext`, resumed on visibility
change as today.

`call-pip.svelte.ts`

```
x, y, minimized                  // same shape as dmPanel
browserPip: boolean              // element PiP window is open
```

## In-app panel: `CallPipPanel.svelte`

Mounted once in `AppView` next to `FloatingDmPanel`, rendered when
`transportState.inCall && transportState.uiRoomCode !== transportState.callRoomCode`.

- 280x158 (16:9) plus a 36 px bar; default bottom-left so it never covers
  the DM panel's bottom-right; clamped to the viewport on resize like the DM
  panel; draggable by the bar.
- Body: the spotlight tile. Video when it has a track (`object-fit: cover`
  for cameras, `contain` for shares), otherwise the avatar with the
  speaking ring. Name label bottom-left, "sharing" or "speaking" tag.
- Bar, left to right: name of the call room, then mute, camera, leave
  (reuse the stage's handlers from `call.svelte.ts`), pin (cycles: pin
  current -> unpin; long-press or right-click lists tiles to pin), browser
  PiP button, minimize, and a "Back to call" button that calls
  `requestReturnToCall()`.
- Minimized: the bar alone, speaking ring drawn on the room name.
- Clicking the video goes back to the call.
- Never mounted alongside the stage, so no double rendering of a track.

## Browser PiP (other tab, other window)

Element PiP on a single hidden-when-not-needed `<video>` bound to the
spotlight track, owned by the panel module so it works whether or not the
in-app panel is showing:

- Manual: the PiP button on the panel and on the stage controls call
  `video.requestPictureInPicture()`; exit with `document.exitPictureInPicture()`.
- Automatic on tab switch: register `enterpictureinpicture` through
  `plugins/media-session.ts`. Chromium calls it when the tab is hidden for a
  page that has been using camera/mic (its "video conferencing" heuristic,
  Chrome 120+), which is the only way to open PiP without a gesture. Firefox
  and Safari get the manual button only; Safari's `webkitSetPresentationMode`
  is used where `requestPictureInPicture` is missing.
- Spotlight changes swap `srcObject`; a spotlight with no video track shows
  a canvas frame of the avatar (draw once, `captureStream(0)`), so the PiP
  window never goes black.
- Closing the PiP window (`leavepictureinpicture`) clears `browserPip`;
  leaving the call closes it.
- Not Document Picture-in-Picture: it is Chromium-only, needs a gesture, and
  would mean rendering Svelte into a second window. Element PiP covers the
  three browsers with one video element.

## Stage changes

- `focusedTileId` -> `callFocus.pinnedTileId`. Existing focus UI unchanged.
- Speaker detection block removed, `speakingPeers` read from the store.
- When nothing is pinned the stage keeps its grid; it does NOT adopt the
  spotlight rule (Zoom's gallery view does not either). Optional follow-up:
  a "speaker view" toggle that focuses `spotlight()`.

## Edge cases

- Peer leaves while pinned or spotlighted: rule 1 falls through, the next
  candidate takes over on the same frame; pin cleared.
- Share ends: same; if the user was watching, `watchingTransmissionPeerId`
  is already cleared by `transmission.svelte.ts`.
- Two people talk over each other: hysteresis keeps the current speaker
  until the other has held 1.5 s.
- User navigates back to the call room: panel unmounts, stage mounts with
  the same pin; browser PiP stays open until the tab is visible again
  (Chromium auto-exits on return; we also exit on `visibilitychange` to
  visible).
- DM call (`callRoomCode` starts with `dm-`): identical; the room name is
  the peer's name.
- Mobile: panel width `min(280px, 45vw)`; the drag action already handles
  touch.

## Files

New: `lib/call-focus.svelte.ts`, `lib/speakers.svelte.ts`,
`lib/call-pip.svelte.ts`, `lib/spotlight.ts` (+ `spotlight.test.ts`),
`components/CallPipPanel.svelte`.

Touched: `VoiceVideoCallView.svelte` (remove analyser loop, use stores,
PiP button), `AppView.svelte` (mount panel), `plugins/media-session.ts`
(one more action), `call.svelte.ts` (close browser PiP on leave).

## Out of scope

Multiple simultaneous spotlights, a grid inside the PiP, showing chat
messages in the PiP window, remembering the panel position across reloads.

## Tests

`spotlight.test.ts`: each rule in order, hysteresis timing with fake
timers, pin clearing on disappearance. `speakers` loop stays untested
(needs real audio); the store's add/remove bookkeeping gets one test.
One e2e scenario: join call, open a DM, assert the panel shows the peer,
start a share on the other browser, assert the panel switches to it.
