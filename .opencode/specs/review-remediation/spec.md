# Review remediation specification

Implement findings 2–9 and the approved usability/accessibility work from `requirements.md` without changing group-message cryptography (finding 1).

## Contracts

- SFU: a socket receives a fresh server nonce/session identifier, then submits a signature made by the private key behind its claimed libp2p peer ID over a domain-separated payload containing protocol version, nonce/session, room code, and peer ID. No SFU operation is admitted before proof; nonces are single-socket, short-lived, and cannot be replayed on another room/session. Reconnects perform a fresh handshake.
- Numeric environment variables: empty, malformed, non-finite, or out-of-range values use documented safe defaults rather than becoming `NaN`/zero accidentally.
- External media: device-local setting defaults off. HTTP(S) previews, GIFs, and remote avatars do not fetch (including relay preview lookup) until enabled. Local `blob:`/`data:` attachment rendering remains available, with an actionable blocked state.
- Credentials: a biometric-enrolled identity cannot be unlocked through remembered-password prefill/auto-submit. Enrollment clears conflicting remembered credentials; remembered-password and biometric choices remain understandable and independently actionable.
- Short invites: relay-wide admission is consumed before code validation/store lookup for both hits and misses, while preserving per-IP admission. Join parsing is identical for typed, pasted, and linked values. Unknown/expired short aliases produce an explicit error; legacy six-character room fallback is explicit, not silent. Minted aliases retain TTL metadata and are regenerated after expiration.
- Oversized text: validate final serialized text (including mention tokens) at send time. When over the existing wire limit, offer/create a UTF-8 `.txt` attachment rather than raising the limit. All room, DM, reply, and floating send surfaces keep draft text and staged attachments on any failure and show an error.
- First-run/accessibility: shorten the initial explanation while preserving recovery/trust essentials and access to full details. Setup, unlock, and room-entry inputs have persistent labels, autocomplete metadata, accessible names, and associated error descriptions.

## Out of scope

- Group crypto migration or any implementation of finding 1.
- Broad visual redesign based on the separately-owned UI direction audit.
- Mutating or attack-testing a running user deployment.

## Verification

Targeted regression tests plus `pnpm check && pnpm test` in `frontend`, `go test ./...` in `relay`, and `npm test && npm run build` in `sfu`.
