# Design

## SFU authentication

Use the existing libp2p Ed25519 device/session key, not the account DID key. The server creates a cryptographically random, per-WebSocket challenge and sends it before accepting `join`. The client signs a canonical, domain-separated byte string binding challenge/session, room, and claimed peer ID. The SFU parses the peer ID, uses its embedded Ed25519 public key, verifies the signature, expires/consumes the challenge, and only then installs room state. This follows js-libp2p's documented invariant that Ed25519 peer IDs embed their public key and its key API verifies signatures.

## Frontend boundaries

Keep external-resource policy in a small shared preference/helper and enforce it at render/fetch boundaries. Keep outgoing-text length/conversion logic in a shared helper, then have each composer preserve its own state until the async send result succeeds. Invite parsing and classification live in the invite/room-code utility layer, not click/paste handlers.

## Relay

Use one relay-wide lookup budget ahead of all syntax and store branches so response timing/status cannot be probed without paying admission. Existing per-IP admission remains first-line abuse control.

## Compatibility

SFU protocol changes client and server atomically; reconnect uses the same fresh challenge flow. Six-character legacy room codes are supported only through an explicit user-visible fallback path. Existing full room links and local attachments remain compatible.
