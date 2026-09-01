import { describe, it, expect } from "vitest";
import {
  DIAG_KIND_COUNT,
  DIAG_SCHEMA_VERSION,
  KIND_BUDGET,
  KIND_SEV,
  type DiagKind,
} from "./schema";

describe("KIND_SEV", () => {
  it("has an entry for every DiagKind", () => {
    // `satisfies Record<DiagKind, DiagSeverity>` in the source catches a
    // MISSING entry at compile time. This catches the other half: a kind added
    // to the union AND to the table but never counted, which would let the two
    // drift apart silently in a schema mirror.
    expect(Object.keys(KIND_SEV)).toHaveLength(DIAG_KIND_COUNT);
  });

  it("never yields an undefined severity", () => {
    for (const kind of Object.keys(KIND_SEV) as DiagKind[]) {
      expect(["debug", "info", "warn", "error"]).toContain(KIND_SEV[kind]);
    }
  });

  it("rates every named failure kind as an error", () => {
    const failures: DiagKind[] = [
      "relay.dial.fail",
      "relay.reservation.timeout",
      "relay.reconnect.fail",
      "rv.open.fail",
      "rv.send.fail",
      "rv.frame.oversize",
      "peer.dial.fail",
      "peer.upgrade.fail",
      "peer.drop.liveness",
      "stream.open.fail",
      "stream.confirm.fail",
      "stream.write.fail",
      "app.msg.reject",
      "app.profile.reject",
      "app.sync.drop",
      "dm.mailbox.drop",
      "ice.turn.fail",
      "ice.turn.unavailable",
      "voice.signal.invalid",
      "voice.failed",
      "sfu.transport.timeout",
      "sfu.consume.failed",
      "sfu.error",
      "sfu.ws.error",
      "file.fail",
      "storage.locked",
      "storage.drop",
    ];
    for (const kind of failures) expect(KIND_SEV[kind]).toBe("error");
  });

  it("rates the high-rate samples as debug so a trim sacrifices them first", () => {
    const samples: DiagKind[] = [
      "peer.rtt",
      "peer.clock",
      "counters",
      "sfu.diag",
      "voice.ice.state",
    ];
    for (const kind of samples) expect(KIND_SEV[kind]).toBe("debug");
  });
});

describe("KIND_BUDGET", () => {
  it("throttles only the kinds that can storm", () => {
    expect(KIND_BUDGET).toEqual({
      "runtime.error": 5,
      "runtime.resources": 2,
      "app.msg.in": 5,
      "app.msg.out": 5,
      "file.progress": 2,
      "voice.ice.state": 5,
      "peer.rtt": 2,
    });
  });
});

describe("DIAG_SCHEMA_VERSION", () => {
  it("is 1 until a field changes shape", () => {
    // A bump here is a reminder to bump the two mirrors: the dashboard's
    // schema.ts and sfu/telemetry.ts's SFU_DIAG_SCHEMA_VERSION.
    expect(DIAG_SCHEMA_VERSION).toBe(1);
  });
});
