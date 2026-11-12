import { describe, expect, it } from "vitest";
import { formatTimeLeft, formatTransferRate } from "./transfer-format";

describe("formatTransferRate", () => {
  it("uses a readable unit instead of 1019.6 KB/s", () => {
    expect(formatTransferRate(1019.6 * 1024)).toBe("1 MB/s");
  });

  it("keeps ordinary byte, KB and GB rates compact", () => {
    expect(formatTransferRate(800)).toBe("800 B/s");
    expect(formatTransferRate(400 * 1024)).toBe("400 KB/s");
    expect(formatTransferRate(12.5 * 1024 * 1024)).toBe("12.5 MB/s");
    expect(formatTransferRate(2 * 1024 ** 3)).toBe("2 GB/s");
  });

  it("handles invalid and negative rates without a misleading ETA input", () => {
    expect(formatTransferRate(Number.NaN)).toBe("0 B/s");
    expect(formatTransferRate(-100)).toBe("0 B/s");
  });
});

describe("formatTimeLeft", () => {
  it("formats 152 minutes as hours and minutes", () => {
    expect(formatTimeLeft(152 * 60)).toBe("~2h 32m left");
  });

  it("uses seconds, minutes, hours and days as appropriate", () => {
    expect(formatTimeLeft(0)).toBe("~1s left");
    expect(formatTimeLeft(42)).toBe("~42s left");
    expect(formatTimeLeft(61)).toBe("~2m left");
    expect(formatTimeLeft(60 * 60)).toBe("~1h left");
    expect(formatTimeLeft(49 * 60 * 60)).toBe("~2d 1h left");
  });
});
