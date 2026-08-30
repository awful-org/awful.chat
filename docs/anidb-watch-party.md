# Why AniDB is not the metadata source for the anime watch party

## The ask

Build an anime watch party for awful.chat, using AniDB as the metadata
source: anime records, AniDB's distinctive episode numbering (specials,
credits, trailers, and parodies as first-class entities), and cover art,
surfaced in a chat card, a call tile, and a sidebar widget, the same way the
existing `waffle-party` plugin does a shared music session.

## The verdict

AniDB cannot be the metadata source for this plugin, in any deployment
shape this project can ship: not called directly from the browser, and not
proxied through this repo's own relay.

## Why

Each blocker below is independent. Any one of them alone is enough to stop
the integration.

### 1. AniDB's HTTP API has no TLS listener, so a browser cannot call it

awful.chat is a WebRTC PWA and therefore always runs in a secure context.
Browsers classify `fetch()` and `XMLHttpRequest` to `http://` as blockable
mixed content and refuse to send them from an HTTPS page. AniDB's HTTP API
answers only on plain HTTP, port 9001; there is no HTTPS listener at all.

> "Blockable content is defined as 'all mixed content that is not
> upgradable'... This includes HTTP requests resulting from the following
> elements... `fetch()` requests... `XMLHttpRequest` requests."
> — https://developer.mozilla.org/en-US/docs/Web/Security/Mixed_content

> "Example: URL: http://api.anidb.net:9001/httpapi?client={str}&clientver={int}&protover=1"
> — https://wiki.anidb.net/HTTP_API_Definition

AniDB does send a permissive CORS header (`Access-Control-Allow-Origin: *`),
so CORS is not the problem. The scheme is. The browser's auto-upgrade path
does not rescue this either: it rewrites `http://` to `https://` for
elements like `<img>`, and AniDB has no HTTPS listener to upgrade to, so the
rewritten request simply fails to connect.

### 2. This repo's own relay proxy rejects non-HTTPS upstreams, by design

Even if a plugin routed the call through the instance's own
`/plugin-proxy`, the proxy refuses it:

> ```go
> pre, err := url.Parse(raw)
> if err != nil || pre.Scheme != "https" {
>     apiError(w, r, "Only https urls", http.StatusBadRequest)
>     return
> }
> ```
> — `relay/pluginproxy.go:415-419`, repeated at `:384` and `:441`

This is a deliberate security property of the relay, applied to every
plugin, not a rule written for AniDB. Weakening it to let AniDB through
would weaken it for every other plugin an operator has allowlisted.

A second, independent problem sits underneath the scheme check: the proxy's
own rate budget cannot express AniDB's. The proxy limits by client IP; AniDB
limits by client id, aggregated across every user who shares that id (see
Blocker 3). A per-IP allowance cannot bound a per-client-id budget.

### 3. AniDB requires a registered client id per deployer, with a strict, shared-fate rate limit

AniDB enforces registration on every request:

> "All users of the HTTP XML API need to be registered and have to provide
> their registered client identifier and version number on each request."
> — https://wiki.anidb.net/HTTP_API_Definition

A request with an unregistered id gets the same error as no id at all:
`<error code="302">client version missing or invalid</error>`. Registration
needs a personal AniDB account
(https://anidb.net/perl-bin/animedb.pl?show=client), so a client id belongs
to one person, not to a project. The rate limit is severe and the
enforcement compounds against continued traffic:

> "You should not request more than one page every two seconds."
> "Dropped packets are still taken into account for the packet rate. Meaning
> if you continuously send packets your client will be banned forever."
> — https://wiki.anidb.net/HTTP_API_Definition, https://wiki.anidb.net/UDP_API_Definition

An open-source project has many independent self-hosted instances. If they
shared one client id, AniDB would aggregate the rate limit across every
instance and every user of every instance at once — a load no single
operator can see or throttle. One busy instance can trip a ban that disables
the plugin for every other deployment simultaneously. The only lawful shape
is one registered client id per operator, which turns a zero-configuration
plugin into one that needs every operator to hold a personal AniDB account.

### 4. AniDB's content licence is CC-BY-NC-SA 4.0: no commercial use, ShareAlike on redistribution

> "Content on AniDB is available under the Creative Commons
> Attribution-NonCommercial-ShareAlike 4.0 International License
> (CC-BY-NC-SA). In other words, you cannot use AniDB data as part of a
> for-profit operation: no ads, subscriptions, paid downloads, sale of
> merchandise, or other for-profit revenue streams."
> — https://anidb.net/policy

This binds every deployer of an open-source, self-hosted plugin: any
instance that carries ads, charges for access, or otherwise operates
commercially would breach the licence the moment it used the plugin.
ShareAlike further means that any adapted AniDB dataset a plugin caches and
reships must itself carry CC-BY-NC-SA — an obligation on data, separate from
this project's own MIT/Apache code licence.

### 5. AniDB cover images are hotlink-protected by `Referer`, and AniDB owns no image rights to license anyway

A browser rendering an AniDB cover `<img>` from a chat page sends
`Referer: https://<the instance's domain>/` and is refused with a
misleadingly generic `404`; the same URL with no `Referer`, or with a
`Referer` on `anidb.net` itself, returns `200`. Suppressing the `Referer`
header would make the image load, but doing that on purpose is
circumventing an access control AniDB configured deliberately, against
AniDB's own instruction:

> "'Fair Use'/'Fair Dealing': We do not own the copyright of any images
> displayed on AniDB. Images are displayed under the 'fair use' or 'fair
> dealing' concept... we display images on our Website to educate readers
> on various anime that exist in the world, and we do not charge a fee."
> — https://anidb.net/policy

AniDB's own display rests on a fair-use posture it has not tested for a
third party's re-display, and holds no copyright to grant a licence over in
the first place.

### 6. AniDB hosts and links no video, by its own stated policy

> "AniDB Website and AniDB's IRC channels do not host any files for
> download, and they do not link to any files for download."
> — https://anidb.net/policy

Whatever the plugin needs for actual playback, AniDB is not a source for it.
At most it supplies metadata: anime records, episode lists, artwork
references, and per-user MyList — never a video file or a stream.

### 7. AniDB's `mylistsummary` endpoint sends the user's main account password in a URL, over plain HTTP

> "The user name and password of the desired user. This is their main
> password, not the API password specified in the profile."
> — https://wiki.anidb.net/HTTP_API_Definition

Combined with Blocker 1 — no TLS on port 9001 — this is a plaintext account
password on the wire, sitting in a URL where any intermediate proxy log
would capture it. No feature the plugin might want justifies ever building
on this endpoint.

### 8. The AniDB data dumps are forbidden by AniDB's own current terms and unreachable regardless

AniDB's ToS is unambiguous and current:

> "No scraping: Additionally, you may not scrape the AniDB database, and we
> do not offer database dumps or bulk export access to the database."
> — https://anidb.net/policy (last updated 31.12.2025 21:00)

An older wiki page describing the dumps
(https://wiki.anidb.net/API, last edited 2014) is superseded by that clause.
Even setting the licence question aside, the dump files are plain HTTP
(Blocker 1 again) and sit behind a bot challenge that a server-side fetcher
would have to impersonate a browser to pass — a second circumvention on top
of a terms violation.

## What would have to change for the answer to become yes

| Condition | Who controls it |
| --- | --- |
| AniDB adds a TLS listener to its HTTP API. | AniDB. Outside this project entirely. |
| This repo's relay proxy accepts plain-HTTP upstreams. | This project's maintainers — and doing it weakens a deliberate security property for every plugin, not only this one. |
| The licence question is settled for self-hosters: AniDB states plainly where a non-commercial, potentially donation-funded, open-source self-hosted instance sits relative to the NC clause. | AniDB, as the policy author. |
| AniDB permits, or an operator accepts, a shared client id instead of one per deployer. | AniDB (permission) or each operator (accepting the outage risk of shared fate). Neither is available today. |
| AniDB allows cover images to be displayed with a foreign `Referer`, or grants an explicit image licence. | AniDB. |

Every one of these sits on AniDB's side, or costs this project a security
property it should not give up for one plugin. None of them is something
this project can decide on its own.

## What was built instead

The anime watch party plugin is built on two decisions: **AniList's GraphQL
API for metadata**, and **the Syncplay model for playback** — every
participant opens their own local video file, and the plugin synchronizes
playback position only, never video bytes.

AniList (`https://graphql.anilist.co`) is HTTPS, sends a permissive CORS
header, and needs no API key and no relay configuration — the same
zero-configuration promise `waffle-party` makes for YouTube. It also
returns `streamingEpisodes`, links to legitimate licensed places to watch an
episode, turning "where do I get this" into a feature instead of a
liability.

The Syncplay-model playback and clock-synchronization primitives live in
the shared library `frontend/src/lib/plugins/watch/`, documented in
[frontend/plugins/README.md](../frontend/plugins/README.md). The plugin
itself, `anime-party`, ships from
[awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome):
the library is generic sync machinery for the app, and the plugin is one
consumer of it, like every other plugin in that collection.

## Options considered and rejected

**Metadata sources.**

- **AniDB, direct from the browser.** Rejected: no TLS listener; see
  Blocker 1.
- **AniDB, through a weakened relay proxy.** Rejected: this repo's proxy
  refuses non-HTTPS upstreams by design, and its rate budget cannot express
  AniDB's per-client-id limit anyway; see Blocker 2.
- **AniDB's data dumps.** Rejected: forbidden outright by AniDB's current
  terms, and blocked a second time by plain HTTP and a bot challenge; see
  Blocker 8.
- **Jikan (unofficial MAL API).** Rejected: a MAL scraper that inherits
  MAL's downtime — repeated live probes returned `504` failures for common
  anime ids, with episode data available only when its cache happened to be
  warm.
- **MyAnimeList, official API.** Rejected: no CORS headers at all (a
  browser call fails outright), needs a key or OAuth2, and has no episode
  endpoint of any kind.
- **Kitsu.** Kept as an optional secondary, not the primary: it is HTTPS,
  CORS-open, key-free, and returned complete episode entities in testing,
  but its own rate limits and terms could not be verified from this
  workstation.
- **TMDB.** Rejected: needs an API key, which reintroduces per-deployer
  signup and shared-secret relay configuration exactly like AniDB's
  client-id problem, and its own terms forbid routing many instances
  through one shared key.
- **TheTVDB.** Rejected: needs a key and a login, and models episodes on
  Western TV numbering rather than anime-native numbering.
- **Shikimori.** Rejected: unreachable to verify from this workstation, and
  its documented OAuth and `User-Agent` requirements make it unlikely to
  beat AniList on the key-free axis anyway.

**Playback substrates.**

- **Each participant's own local file, position sync only (Syncplay
  model).** Chosen: no copyrighted bytes ever leave a participant's own
  machine, and sub-second synchronization is achievable by copying
  Syncplay's published control law.
- **One participant seeds the file over WebTorrent, others stream.**
  Rejected: MKV (the dominant anime release container) and Hi10P (a common
  anime video profile) have poor or no in-browser support even where
  WebTorrent's own streaming layer applies; browsers cannot join the public
  BitTorrent swarm as leechers, only as WebRTC peers of an explicit seeder;
  and the seeding participant would be distributing a copyrighted file
  through infrastructure the instance operator built and shipped.
- **A shared external URL or HLS stream.** Rejected as a primary mechanism:
  a URL field participants fill in becomes a pirate-stream distribution
  channel the operator hosts with actual knowledge of its purpose, and
  licensed hosts forbid embedding and enforce DRM. Kept only as a link-out:
  AniList's `streamingEpisodes` entries render as outbound links to
  licensed services, and participants who use one sync their position in
  the plugin exactly as local-file participants do.

## Unverified

These claims could not be confirmed from this workstation and are carried
as open risk on the recommendation, not on AniDB:

- **AniList's formal terms of use and image licence.** `anilist.co` did not
  resolve from the research workstation; only `graphql.anilist.co` and
  `docs.anilist.co` did. AniList's technical behavior (CORS, no key needed)
  is measured; its written terms of use are not read. This is the most
  important open item, because AniList is the recommended source.
- **Kitsu's rate limits and terms of use.** Its documentation host timed
  out during research; only the API endpoint itself was probed.
- **Shikimori, entirely.** Produced no response from the research
  workstation.
- **AniDB's client-registration approval time.** Registration needs a login
  the research had no access to; the conclusion that it is self-service and
  effectively instant is an inference from the public client list.
- **AniDB's exact ban duration for HTTP API violations**, beyond the UDP
  API's documented "usually lasts 30 minutes" for a short-term violation.
- **Real-world browser playback rate for typical anime video files**
  (Hi10P MKV and similar) under the chosen local-file substrate. Reasoned
  from MDN's codec and container tables, not measured by opening an actual
  file in a browser.
- **AniList's episode-list completeness across a broad sample of older,
  obscure, and OVA-type entries.** Verified only for one series.
