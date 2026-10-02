# The awful contract (v1)

How a website runs inside Awful.chat as an **app**: a game, a board, a shared
page, opened by someone in a room with `/app <url>` and shown as a tile in the
call. This is what a site implements to be "awful compatible". It is short on
purpose: one way to be embedded, one handshake, and later one optional proof
of who a player is.

Three parties are named throughout:

- **the host** - Awful.chat, running in each person's browser;
- **the app** - your site, loaded in an iframe inside the host;
- **the instance** - whoever runs the Awful.chat server the host came from.

## 1. What the host promises

The host is built to keep a person's identity out of your hands, and says so
to them before your page loads. It will **never** send an app:

- the person's identity (their `did:key`) or anything that reveals it;
- their recovery phrase, keys or password;
- the room's secret, its invite link or its name;
- messages, files, or anything about other rooms or other apps.

What it **does** send is listed in section 4: display names, a player id that
only means something to you, in this one session, and what the person who
started the app typed after its URL.

Before someone opens an app, the host tells them which site it is, what it
will receive (their name in the call and a player id), what it will not, and
that the site sees their IP address, because it serves the page. They can
choose not to be told again for that site. The site's address stays visible on the
tile for as long as it is open.

## 2. Starting and opening an app

- **Starting:** someone in a room or a DM types `/app <url> [anything]`. The
  URL must be `https:`; a bare host (`je.frav.in`) means `https://`. Whatever
  follows the URL, up to 256 characters, is handed to the app as
  `session.args` - a room code on your side, a game mode, anything you
  define. The host posts a card in the chat; nothing is added to your URL.
- **Opening:** the app opens only in a call, as a tile beside the cameras and
  screen shares. Each person clicks it to open it, so `players` (section 4) is
  the people who actually have it open.
- **Ending:** the person who started it can end it for everyone; anyone can
  leave it. An app is not reopened from history: a new `/app` is a new
  session.

## 3. Being embeddable

An app is a page at an `https:` URL that:

- **allows being framed** by Awful.chat instances: `Content-Security-Policy:
  frame-ancestors *` (or a list of instances you choose), and no
  `X-Frame-Options: DENY` / `SAMEORIGIN`;
- **works in a sandboxed iframe.** The host loads it with
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` and no
  referrer, on its own origin. It cannot reach the host's page, storage or
  keys, and the host cannot reach yours. It is delegated no camera,
  microphone or fullscreen;
- **sizes itself to the tile.** The tile is the iframe's viewport and changes
  size (focus, fullscreen, pop-out, phones). Do not assume a minimum.

Any `https:` URL a room member opens is allowed, with the notice in section 1.

## 4. Messages

Everything between the host and the app is `window.postMessage`. Every
message is a plain object with the protocol version and a type:

```js
{ awful: 1, type: "ready" }
```

- **The app sends** to `window.parent`, with target origin `"*"`: it cannot
  know which instance it is embedded in, and nothing it sends is secret.
- **The app accepts** a message only when `event.source === window.parent`
  and `event.data.awful === 1`. Do not check `event.origin` against a fixed
  list: every instance has its own.
- **The host sends** only to the app's own origin, and **accepts** a message
  only from the iframe it created, from that origin, at most 20 a second and
  16 KB each.
- Unknown types are ignored on both sides, so either side can add types in a
  later version without breaking the other.

### `ready` (app → host)

Send it once your page can receive messages:

```js
window.parent.postMessage({ awful: 1, type: "ready" }, "*");
```

### `hello` (host → app)

The host answers `ready` with everything the app needs to start:

```js
{
  awful: 1,
  type: "hello",
  session: {
    id: "s_4f9c2a7e1b8dQx0m",   // the app's room - see below
    startedAt: 1790812376000,   // ms since the epoch
    args: "ROOM42",             // what the starter typed after the URL; "" if nothing
  },
  self: { id: "p_9d1e7c3aKx2bLm0Q", name: "Ana", color: null },
  players: [
    { id: "p_9d1e7c3aKx2bLm0Q", name: "Ana", color: null },
    { id: "p_2b6f0e4dWq8nZr5T", name: "Bo", color: null },
  ],
  theme: "dark",                // "dark" | "light"
  locale: "pt-BR",
}
```

- **`session.id` is your room.** Everyone who opens the same card in the same
  Awful.chat room or DM gets the same `session.id`; a new card is a new
  session, even with the same URL. Create or join your game, board or lobby
  under it. The host makes it from random bytes when the app is started, and
  only members of that room receive it.
- **`session.args`** is the starter's own text, unchanged. Use it to point the
  session at something that already exists on your side - a room that has
  been running for a week, say - or ignore it.
- **`self` and `players`.** `players` is everyone who has the app open now,
  `self` included. A player's `id` is stable for that person in this session,
  the same in every player's copy, and means nothing outside it: the same
  person has a different id in another session or on another site. Use it
  for seats and scores within the session.
- **`name`** is what the person shows in Awful.chat, chosen by them, and
  **`color`** is reserved (`null` for now). They are labels, not proof: two
  people can share a name.

### `players` (host → app)

Sent whenever someone opens or leaves the app, with the full list, the same
shape as in `hello`. Someone whose host closes without saying so drops out
within about 45 seconds.

```js
{ awful: 1, type: "players", players: [ ... ] }
```

### `theme` (host → app)

```js
{ awful: 1, type: "theme", theme: "light" }
```

### `activity` (app → host)

Advertise what this player is doing, shown under their name in the room's
user list while they are in the call with the app open:

```js
{ awful: 1, type: "activity", name: "Jeopardy" }   // "Playing Jeopardy"
{ awful: 1, type: "activity", name: null }         // clears it
```

- `name` is plain text: the host makes it one line, turns control and
  formatting characters into spaces and keeps the first 32 characters. Keep it to the
  game's name; the host adds "Playing".
- It is per player and per page: every `ready` starts with none, so a page
  that loads into a game says so again.
- Everyone in the room sees it, so it reaches people who have not opened the
  app. Only the game, then - never a player's score, hand or answer.

### `close` (app → host)

The app can close itself for this person, for example when the game is over:

```js
{ awful: 1, type: "close" }
```

The host also closes it whenever the person leaves the tile or the call, or
the starter ends it. There is no goodbye message: treat a player leaving
`players`, or your page unloading, as leaving.

## 5. Proving who a player is (planned)

Not in Awful.chat yet; a host that predates it ignores `attest`. Written here
so sites can plan for it.

A site with its own server that keeps scores or accounts across sessions will
be able to ask the host to prove a player is the same person as last time,
without learning who they are:

```js
{ awful: 1, type: "attest", challenge: "nonce-from-your-server" }
```

The first time a site asks, the host asks the person in its own UI
("**je.frav.in** wants to recognize you across rooms. It will not learn who
you are."). On agreement it answers:

```js
{
  awful: 1,
  type: "attestation",
  challenge: "nonce-from-your-server",
  key: "did:key:z6Mk...",          // this person's key FOR YOUR SITE
  signature: "base64url...",       // ed25519 over the string below
}
```

over this exact UTF-8 string, lines joined with `\n`:

```
awful-attest/1
<your origin, e.g. https://je.frav.in>
<session.id>
<challenge>
```

`key` is derived from the person's identity and your origin: the same person
always gives your site the same key, in every room, so it can be an account;
another site gets a different key, so sites cannot match people up, and none
gets the person's real identity. A decline comes back as `{ awful: 1, type:
"error", for: "attest", reason: "declined" }`.

## 6. Security notes for apps

- **Names are labels, not proof.** Until attestations exist, anything a
  player claims about themselves is a claim.
- **`session.id` is a bearer value.** Anyone who has it can claim to be in the
  session. The host only gives it to the room's members, but treat it like a
  room password, not an identity.
- **Do not ask people for their recovery phrase, password or anything from
  Awful.chat.** Nothing in this contract needs it, and the host tells people
  never to type it into an app.

## 7. Versioning

Every message carries `awful: 1`. A new major version changes the number, and
a host speaks every version it supports; an app answers with the highest
version it knows. New message types within a version are additive and may be
ignored.
