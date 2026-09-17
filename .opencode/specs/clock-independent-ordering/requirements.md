# Clock-independent conversation ordering

User approved logical conversation ordering after a wrong PC clock broke relay
reservation and scrambled messages. Implement directly, without subagents.

- Order room/DM/floating histories independently of wall-clock timestamps.
- Continue above stored legacy counters; never rewrite signed history or reset
  synchronization/read watermarks.
- Preserve every message at pagination boundaries, including equal counters.
- Warn about observed local clock jumps and the relay's expired-TTL error.
- Keep sender times as display metadata, with honest date-label semantics.
- Verify clock jumps, legacy DM counters, deterministic ties, history pagination,
  storage/read markers and existing package checks.
