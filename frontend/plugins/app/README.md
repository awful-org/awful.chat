# Apps

Opens a website made for Awful.chat - a game, a board, a shared page - as a
tile in the call.

```
/app je.frav.in ROOM42
```

Everything after the address, up to 256 characters, goes to the site as
`session.args`: a room code on its side, a game mode, whatever it defines.
How a site becomes "awful compatible" is in
[the awful contract](../../../docs/awful-contract.md).

## Why an iframe and not a plugin

A plugin is compiled into Awful.chat: changing a game means a release. An app
lives on its own server, so whoever runs it ships when they like, keeps their
own state, and can let the same game run outside Awful.chat too. The host's
part is small and fixed: frame the page, introduce the players, get out of
the way.

## What the site learns

Only what the contract lists: the session, what the starter typed, the names
of the people who have it open, and a player id per person.

The player id is an HMAC of the person's DID, keyed by a random salt that
lives in the card. The card travels encrypted to the room's members and the
salt never leaves the host, so everyone in the session computes the same id
for the same person, and the site cannot turn it back into a DID or match it
with the same person's id in another session. No host secret is involved, so
nothing new needs protecting.

The site does learn the IP address of everyone who opens it, because it
serves the page. That is what the one-time disclosure per site is for; it is
remembered per browser, not per account.

## The tile

Each person opens the app themselves. Presence is ephemeral updates: `join`
on open, `here` every 15 seconds, `leave` on close. Someone not heard from in
45 seconds is gone, which covers a closed tab. An ephemeral update is never
stored, so presence never outlives the call and history replays only the
card and the end.

Ending is a stored update, accepted only from the starter. Anyone can leave.

The iframe is sandboxed (`allow-scripts allow-same-origin allow-forms
allow-popups`) with no referrer and no delegated features. `allow-same-origin`
is the site's own origin, which it needs for its own storage and cookies; it
can never be ours, because the site is cross-origin by definition. The
site's address stays on the tile for as long as it is open, so an app cannot
pass for the host.
