# Decisions

- 2026-09-11: Finding 1 remains design-only; no group-crypto migration is implemented.
- 2026-09-11: SFU identity proof uses the libp2p device/session key because the claimed identifier is a libp2p peer ID; an account DID signature would not prove ownership of that peer ID.
- 2026-09-11: The SFU challenge is server-generated per socket and binds room plus server session, so replay on reconnect, another room, or another socket fails.
- 2026-09-11: External HTTP(S) media/previews are opt-in and device-local, default off; local `blob:` and safe raster `data:` content are not blocked.
- 2026-09-11: Oversized text becomes a UTF-8 `.txt` attachment without increasing the signed/wire text ceiling.
- 2026-09-11: Unknown short aliases do not silently become room codes. Legacy six-character rooms require an explicit fallback action.

## Sources consulted

- Local signing and identity contracts: `frontend/src/lib/transport/libp2p/transport.ts`, `frontend/src/lib/messaging.ts`, `frontend/src/lib/transport/device-key.ts`, `frontend/src/lib/quick/session-key.ts`.
- Official js-libp2p API docs: Ed25519 peer IDs embed their public key; `@libp2p/crypto/keys` supports Ed25519 signing/verification; `@libp2p/peer-id` derives peer IDs from keys.
