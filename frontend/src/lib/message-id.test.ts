import { describe, expect, it } from "vitest";
import { messageIdAllowedFor, newMessageId } from "./message-id";

const ALICE = "did:key:z6MkAlice";
const MALLORY = "did:key:z6MkMallory";

describe("message ids bound to their sender", () => {
  it("accepts an id from the sender it was made for", () => {
    const id = newMessageId(ALICE);
    expect(id).toMatch(/^m[0-9a-f]{24}-[0-9a-f-]{36}$/);
    expect(messageIdAllowedFor(id, ALICE)).toBe(true);
  });

  it("refuses someone else's id", () => {
    expect(messageIdAllowedFor(newMessageId(ALICE), MALLORY)).toBe(false);
  });

  it("is fresh each time for the same sender", () => {
    expect(newMessageId(ALICE)).not.toBe(newMessageId(ALICE));
  });

  it("still accepts unbound ids written before the binding", () => {
    const legacy = crypto.randomUUID();
    expect(messageIdAllowedFor(legacy, ALICE)).toBe(true);
    expect(messageIdAllowedFor(legacy, MALLORY)).toBe(true);
  });

  it("refuses the empty id, which the held-id checks skip", () => {
    expect(messageIdAllowedFor("", ALICE)).toBe(false);
  });

  it("refuses non-string input", () => {
    expect(messageIdAllowedFor(undefined as unknown as string, ALICE)).toBe(false);
    expect(messageIdAllowedFor(newMessageId(ALICE), 7 as unknown as string)).toBe(false);
  });
});
