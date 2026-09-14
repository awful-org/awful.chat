import { describe, expect, it } from "vitest";
import { prepareOutgoingText } from "./outgoing-text";
import { MAX_CHAT_CONTENT_LENGTH, MAX_MESSAGE_FILES } from "./verify-incoming";

describe("long-message attachment fallback", () => {
  it("keeps text at the accepted wire limit as text", () => {
    const text = "x".repeat(MAX_CHAT_CONTENT_LENGTH);
    expect(prepareOutgoingText(text)).toEqual({ text, files: [] });
  });
  it("preserves every UTF-8 character in a .txt file and keeps existing attachments", async () => {
    const text = "hello 👋\n".repeat(3000);
    const image = new File(["image"], "photo.png", { type: "image/png" });
    const prepared = prepareOutgoingText(text, [image]);
    expect(prepared.files[0]).toBe(image);
    expect(prepared.text.length).toBeLessThan(MAX_CHAT_CONTENT_LENGTH);
    expect(prepared.files[1].name).toBe("message.txt");
    expect(await prepared.files[1].text()).toBe(text);
  });
  it("refuses to exceed the receiver's file limit without dropping a user's attachment", () => {
    const files = Array.from({ length: MAX_MESSAGE_FILES }, (_, i) => new File(["x"], `${i}.txt`));
    expect(() => prepareOutgoingText("x".repeat(MAX_CHAT_CONTENT_LENGTH + 1), files)).toThrow("attachment slot");
    expect(files).toHaveLength(MAX_MESSAGE_FILES);
  });
});
