import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_CLEAR_MS,
  cancelErrorClear,
  describeMediaError,
  describeShareError,
  setErrorWithAutoClear,
  type ErrorSlot,
} from "./call-error";

afterEach(() => {
  cancelErrorClear();
  vi.useRealTimers();
});

describe("describeMediaError", () => {
  // The browser's own wording for a denied permission differs per engine and
  // never says what to do about it. Firefox: "Permission denied by user".
  it("replaces a denied permission with actionable copy, whatever the engine said", () => {
    for (const raw of ["Permission denied by user", "Permission denied"]) {
      const err = new Error(raw);
      err.name = "NotAllowedError";
      const out = describeMediaError(err);
      expect(out).not.toBe(raw);
      expect(out.toLowerCase()).toContain("permission");
      expect(out.toLowerCase()).toContain("settings");
    }
  });

  it("detects a DOMException, which is what browsers actually throw", () => {
    const err = new DOMException("Permission denied by user", "NotAllowedError");
    expect(describeMediaError(err)).toContain("Re-grant permission");
  });

  it("passes any other error through unchanged", () => {
    expect(describeMediaError(new Error("Requested device not found"))).toBe(
      "Requested device not found"
    );
  });

  it("survives a thrown non-Error", () => {
    expect(describeMediaError("something odd")).toBe("something odd");
  });
});

describe("describeShareError", () => {
  it("says nothing when the picker was closed, in any engine's words", () => {
    for (const raw of [
      "Permission denied",
      "Permission denied by user",
      "The request is not allowed by the user agent or the platform in the current context.",
    ]) {
      expect(describeShareError(new DOMException(raw, "NotAllowedError"))).toBeNull();
    }
    expect(describeShareError(new DOMException("aborted", "AbortError"))).toBeNull();
  });

  it("never blames the microphone or camera", () => {
    const out = describeShareError(
      new DOMException("Permission denied by system", "NotAllowedError")
    );
    expect(out).not.toBeNull();
    expect(out!.toLowerCase()).not.toContain("microphone");
    expect(out!.toLowerCase()).toContain("screen recording");
  });

  it("passes a real failure through", () => {
    expect(describeShareError(new Error("SFU unreachable"))).toBe("SFU unreachable");
  });
});

describe("setErrorWithAutoClear", () => {
  it("retires its own message, which is what never happened before", () => {
    vi.useFakeTimers();
    const slot: ErrorSlot = { error: null };
    setErrorWithAutoClear(slot, "camera failed");
    expect(slot.error).toBe("camera failed");
    vi.advanceTimersByTime(ERROR_CLEAR_MS + 1000);
    expect(slot.error).toBeNull();
  });

  // The slot is shared: dm.svelte.ts and transmission.svelte.ts write it too.
  // Clearing unconditionally would wipe a newer, unrelated error that arrived
  // inside the window and cut its display short for no visible reason.
  it("leaves a newer error from somewhere else alone", () => {
    vi.useFakeTimers();
    const slot: ErrorSlot = { error: null };
    setErrorWithAutoClear(slot, "camera failed");
    slot.error = "Cannot send yet: still verifying who this peer is.";
    vi.advanceTimersByTime(ERROR_CLEAR_MS + 1000);
    expect(slot.error).toBe(
      "Cannot send yet: still verifying who this peer is."
    );
  });

  it("does not leave a stale timer able to clear a later message", () => {
    vi.useFakeTimers();
    const slot: ErrorSlot = { error: null };
    setErrorWithAutoClear(slot, "first");
    vi.advanceTimersByTime(ERROR_CLEAR_MS / 2);
    setErrorWithAutoClear(slot, "second");
    // The first timer must not fire and blank the second message early.
    vi.advanceTimersByTime(ERROR_CLEAR_MS / 2 + 100);
    expect(slot.error).toBe("second");
    vi.advanceTimersByTime(ERROR_CLEAR_MS);
    expect(slot.error).toBeNull();
  });

  it("cancelErrorClear stops the pending clear without wiping the message", () => {
    vi.useFakeTimers();
    const slot: ErrorSlot = { error: null };
    setErrorWithAutoClear(slot, "camera failed");
    cancelErrorClear();
    vi.advanceTimersByTime(ERROR_CLEAR_MS * 2);
    expect(slot.error).toBe("camera failed");
  });
});
