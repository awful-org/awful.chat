# Encrypted files implementation handoff

Status: ACTIVE. Exclusive ownership per security-v2-coordination.md; no commits.

Scope: ciphertext-only torrent seed/download/reseed, protected descriptors,
storage/backup and attachment presentation. Existing changes preserved.

Checkpoint 1: read coordination and protocol status, inspected git status and
files.svelte.ts. Existing torrent callers still seed plaintext. Investigating
crypto staging and torrent lifecycle before integration.

Checkpoint 2 (after server interruptions): implemented seedEncryptedFiles,
persistableCiphertext, restoreEncryptedFile; authenticated download publication;
OPFS ciphertext persistence and disk-backed torrent chunk store; encryption
descriptor types and canonical signature binding helper. files.svelte.ts now
restores ciphertext and skips legacy inline/reseed for protected rooms/DMs.
IN PROGRESS, not validated yet: storage discovery of OPFS-only attachments,
backup validation, tests and lifecycle race fixes. Existing metadata/signature
and sendFiles cross-owner requests below remain mandatory.

Tests: not yet run. Docker dependency inspection confirms installed WebTorrent
supports createReadStream, store/storeCacheSlots and callback chunk-store API.

## Cross-owner requests (API contract, implementing now)

DM/core owner: `FileDescriptor` in transport/types.ts needs optional
`encryption?: import('../room-security/file-crypto').EncryptedFileDescriptor`.
`sendFiles` MUST use `_fileTransport.seedEncryptedFiles([file])` for protected
rooms/DMs (safe to use for all new sends after cutover), skip fileFingerprint
whole-file hashing/dedup for these sends, NEVER inline original bytes for these
descriptors, and persist `encryption: seededFile.encryption` on Attachment.
For encrypted attachments `data` must be ciphertext, obtained with
`await _fileTransport.persistableCiphertext(infoHash, MAX_PERSISTED_ATTACHMENT_BYTES)`;
large ciphertext remains in OPFS and restores by infoHash. Receiver attachment
creation and every manual descriptor reconstruction must copy `encryption`.
Do not seed a downloaded plaintext Blob: encrypted transport retains the same
ciphertext torrent and emits only authenticated plaintext through `downloaded`.
Incoming protected file messages MUST reject entries lacking `encryption`.

Coordinator: messaging.ts signatures must bind encryption descriptor via
`fileSignatureBinding(file)` exported from room-security/file-descriptor.ts;
use it instead of both existing `${infoHash}:${size}:${mimeType}:${filename}`
expressions (helper preserves legacy bytes when encryption is absent).
Plugin/quick-send descriptor reconstructions must retain encryption and quick
send must adopt seedEncryptedFiles, no plaintext reseed of downloaded Blobs.
No dependency changes needed. ChatView/AppView APIs need no direct changes.
