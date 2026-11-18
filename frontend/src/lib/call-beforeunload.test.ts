import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warnBeforeLeavingCall } from "./call-beforeunload";

let target: EventTarget;
let cleanups: Array<() => void>;

beforeEach(() => {
  target = new EventTarget();
  cleanups = [];
  vi.stubGlobal("window", target);
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  vi.unstubAllGlobals();
});

function watch(inCall: boolean): () => void {
  const cleanup = warnBeforeLeavingCall(inCall);
  cleanups.push(cleanup);
  return cleanup;
}

describe("active call unload confirmation", () => {
  it("attaches on join, removes on leave, and attaches again on rejoin", () => {
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    watch(false)();
    expect(add).not.toHaveBeenCalled();

    const leave = watch(true);
    expect(add).toHaveBeenCalledExactlyOnceWith("beforeunload", expect.any(Function));
    leave();
    expect(remove).toHaveBeenCalledExactlyOnceWith("beforeunload", add.mock.calls[0][1]);
    watch(false)();
    expect(add).toHaveBeenCalledTimes(1);
    watch(true);
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("requests the standard confirmation without ending the call", () => {
    watch(true);
    const event = new Event("beforeunload", { cancelable: true });
    const preventDefault = vi.spyOn(event, "preventDefault");
    // EventTarget is enough for the lifecycle tests; model BeforeUnloadEvent's
    // string returnValue separately from Node Event's boolean property.
    Object.defineProperty(event, "returnValue", { value: undefined, writable: true });
    target.dispatchEvent(event);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe("");
    // A cancelled navigation must leave the protection in place.
    const retry = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(retry);
    expect(retry.defaultPrevented).toBe(true);
  });

  it("cleans up on shell destruction, including repeated cleanup", () => {
    const remove = vi.spyOn(target, "removeEventListener");
    const destroy = watch(true);
    destroy();
    destroy();
    expect(remove).toHaveBeenCalledOnce();
    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("shares one listener across overlapping app and quick-call shells", () => {
    const add = vi.spyOn(target, "addEventListener");
    const remove = vi.spyOn(target, "removeEventListener");
    const app = watch(true);
    const quickCall = watch(true);
    expect(add).toHaveBeenCalledOnce();
    app();
    expect(remove).not.toHaveBeenCalled();
    quickCall();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does nothing without a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(() => watch(true)()).not.toThrow();
  });
});
