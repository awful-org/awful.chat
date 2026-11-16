import { describe, expect, it } from "vitest";
import { isLivenessFrame } from "./sync-transport";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("which frames the pairing transport leaves on the direct stream", () => {
  it("is the link's own pings and pongs", () => {
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__ping", n: 7 })))).toBe(true);
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__pong", n: 7, w: 1_794_000_000_000 })))).toBe(true);
  });

  it("is never a sync frame, however it starts", () => {
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "sync_export_ack", v: 2, payload: { seq: 1 } })))).toBe(false);
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__ping", n: 7, data: "x".repeat(80) })))).toBe(false);
    expect(isLivenessFrame(bytes('{"type":"sync_export_data"}'))).toBe(false);
  });
});
