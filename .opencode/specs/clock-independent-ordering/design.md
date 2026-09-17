# Design

Reuse the signed lamport field; no wire format or signature migration. Order by
(lamport, message ID), using binary string comparison. Message IDs are globally
unique and remain clear in IndexedDB, whose byRoomLamport index orders equal
keys by primary ID. This gives storage and UI the same total order without a
new index or a rewrite of encrypted records.

Allocate ordinary sends from a serialized per-room logical counter initialized
from stored history and watermarks, not Date.now. Existing large DM counters are
valid baselines and continue increasing by one. Preserve a synchronous observed
counter for teardown plugin sends. Wall-clock validation must not replace DM
logical sequence numbers on receive. Reject invalid/exhausted counters rather
than rewriting signed values or overflowing them.

Remote counters have a fixed bootstrap ceiling of 2^48 (enough for legacy
epoch-millisecond counters far beyond present dates), then at most a 1,000,000
step beyond the observed room floor. This replaces wall-time-dependent bounds
while rejecting near-MAX_SAFE_INTEGER exhaustion claims before persistence.
Honest sequence allocation always checks numeric exhaustion before incrementing.

Pagination uses (lamport, id) cursors; legacy numeric cursor callers retain their
strict-before-lamport meaning. Read/delivery and sync markers remain logical.
Offline concurrent messages have deterministic order, not provable chronology;
old clients still sort by timestamps until upgraded. Legacy histories whose
causal metadata was already lost cannot be perfectly reconstructed.

Existing per-sender sync/read watermarks are retained. Disconnected devices with
the same identity can still allocate the same sequence, and late offline messages
below a read watermark are not newly counted as unread. Solving those existing
limitations requires per-device event tracking or explicit per-message read state,
not a timestamp ordering fix. Independent senders' equal counters are preserved
by the new pagination cursor.

Clock diagnostics compare elapsed wall and monotonic time locally, and recognize
the relay's invalid tag-TTL error. No server is made the ordering authority.
