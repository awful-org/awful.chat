# Review remediation

User approved implementation of review findings 2–9 and usability improvements, with file-disjoint parallel agents and an independent frontend UI-direction audit. Finding 1 is explanation/design only, pending user decision.

Execution update: user subsequently requested direct implementation with no
subagents. Remaining implementation and review were performed by the parent;
there is no independent post-implementation review verdict.

Follow-up override: external media defaults ON; a saved explicit OFF preference
must remain respected. User also requested repair of stale watching controls
after SFU reconnection.

## Required outcomes

2. Authenticate SFU joins with fresh proof of ownership of the claimed libp2p peer ID, binding room and SFU session; replay-resistant. Preserve normal reconnects and reject forged IDs.
3. Fix empty/invalid numeric environment parsing and explicit production defaults, particularly SFU_REJOIN_PROBE_MS and SFU_DIAG_MIN_INTERVAL_MS.
4. Add App Settings privacy control for external previews/media. Default off; avoid automatic disclosure of private-message URLs to relay and remote image hosts until enabled. Preserve local/blob/data attachments. Clearly explain disclosure and provide useful blocked-media UX. Cover core remote avatars/GIFs/preview surfaces, report any remaining exclusions explicitly.
5. Make remembered-password access and biometric-protected access distinct. No remembered-password prefill bypass when biometric protection is enrolled. Clean up existing remembered credentials when appropriate and communicate behavior clearly.
6. Enforce global short-invite guessing admission before lookup, independent of hit/miss; preserve per-IP limits and update misleading tests/docs.
7. Improve oversized-text UX using .txt attachment fallback rather than increasing the accepted wire-text limit. Apply shared send-time validation after mention serialization, preserve user text/drafts on failure, and give clear feedback. Audit room/DM/reply/floating panel paths; do not silently lose content.
8. Parse room links/codes uniformly on Join regardless of paste method, reusing shared parser; reject invalid input.
9. Track short-invite TTL, regenerate expired aliases, and surface expired/unknown codes instead of silently joining unrelated rooms. Keep legacy support explicit when ambiguous.

## Usability

- Reduce first-run information overload while keeping essential recovery and trust facts prominent and the full explanation accessible.
- Add persistent labels, suitable autocomplete attributes, associated errors and accessible names to setup/unlock/room entry controls.
- Preserve drafts and staged attachments on failed sends with visible error feedback.

## Constraints

- Preserve existing user work: docs/hosting.md and untracked fetched plugins (anime-party, soundboard, steam-roulette, waffle-party and .fetched.json).
- Exact file-disjoint implementation scopes; coupled changes serialize into waves. No concurrent ownership of same file.
- Read repository docs and authoritative API/crypto docs before designing SFU authentication. Prefer existing device-key/signature primitives.
- No production network mutation or attack tests against running user services. Use isolated test processes.
- Meaningful regression tests for auth/replay, environment parsing, invite oracle, message conversion/failure recovery and privacy behavior. Run full frontend check/tests, relay tests, SFU tests/build and relevant dashboard checks if touched.
- Independent correctness/security review and fix loop before completion.
- Separate read-only frontend UI-direction audit produces ui-direction-review.md; do not treat audit suggestions as permission for a broad redesign.

## Parent-owned artifacts

This requirements.md and ui-direction-review.md are reserved for the parent/UI auditor. Implementation coordinator owns other artifacts within this spec directory.
