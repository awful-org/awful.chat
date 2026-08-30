# Anime Party

Watch an episode together. Start one with:

```
/anime-party One Piece
```

## What it does

Everyone who joins opens **their own** video file from their own computer.
The plugin never reads, uploads, or relays that file - it only keeps
everyone's player at the same position and paused/playing state, the same
way Syncplay does. The host drives playback: pause, play, seek, and moving
to the next episode all happen from the host's controls and reach everyone
else within about a second. A viewer opening the party after playback has
already started gets a one-time sync instead of waiting for the next
heartbeat.

The party appears as a chat card, and as a click-to-join tile in a call -
like a screen share, nothing plays until a member opts in.

## Metadata

`/anime-party <title>` looks the title up on
[AniList](https://anilist.co) for a proper title, episode count, and cover
art. This is called directly from your browser - no server, no API key,
nothing for the operator to configure. If AniList has no match, is slow, or
is unreachable, the party still opens with exactly the title you typed and
no cover image. Metadata never blocks or delays playback.

## Files and playback

Pick your own copy of the current episode with the file picker in the
player. Browsers cannot play the **Matroska (.mkv) container** at all - the
dominant anime-release format - so an .mkv file is refused outright with an
explanation instead of being tried and silently failing. A filename hinting
at HEVC, H.265, or 10-bit color gets a softer warning, since only the
browser's own attempt to decode it can say for certain whether it works. Any
other decode failure is reported in one sentence read from the browser's own
error.

Subtitles that are baked into a video container (as most anime releases do)
are **not exposed to a browser at all** - there is no way around this. Pick
a separate subtitle file instead, and it must be **WebVTT (.vtt)**: that is
the only subtitle format a browser's native `<track>` element understands.
An .srt or .ass file will not show anything.

Each participant's volume is their own, remembered on their device under
`awful:plugin:anime-party:volume`. It is never sent to the room.

## Moving to the next episode

The host advances the party with the next-episode control. Every
participant then needs to open their own file for that episode - nothing
carries forward automatically, because nobody's file for episode N+1 is
known to anyone but them.

## If the host disconnects

Other members wait 15 seconds for the host's connection to come back (a
call renegotiation can briefly drop and restore a peer connection on its
own) before the party closes. If the host reconnects inside that window,
nothing happens.

## Honest limits

- Sync is close, not frame-accurate. Two different releases of the same
  episode - different cuts, different pre-roll - can sit seconds apart, and
  nothing detects or warns about that mismatch.
- Only the host controls transport (play, pause, seek, next episode).
  Everyone else watches and picks their own file and subtitle track.
- No search-as-you-type against AniList: a lookup only happens once, when
  the party is created, to stay well inside AniList's rate limit.
- No audio extraction, no picture-in-picture beyond what the browser already
  gives a `<video>` element, and no attempt to verify that two participants
  opened the same actual release.

## Install

Built in. No `PLUGIN_SOURCES` entry needed.

## Requirements

None. AniList needs no API key and no relay configuration, and every video
plays from a file already on the viewer's own device.

Privacy note: an AniList lookup sends the typed title to AniList from the
searching participant's own browser, the same way loading a cover image
does. No file, filename, or playback position is ever sent anywhere but the
room's own members.
