import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSendOrReply } from "$lib/chat-send-helper";

describe("chat send helper", () => {
  let sendMessage: (content: string) => void;
  let sendReply: (content: string, target: { id: string }) => void;
  let sendOrReply: ReturnType<typeof createSendOrReply>;

  beforeEach(() => {
    sendMessage = vi.fn();
    sendReply = vi.fn();
    sendOrReply = createSendOrReply(
      sendMessage as any,
      sendReply as any
    );
  });

  it("sends a message when no reply target is set", () => {
    sendOrReply("Hello", null);

    expect(sendMessage).toHaveBeenCalledWith("Hello");
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("sends a reply when a reply target is set", () => {
    const replyTarget = { id: "msg-123" };
    sendOrReply("Reply text", replyTarget);

    expect(sendReply).toHaveBeenCalledWith("Reply text", replyTarget);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("differentiates based on presence of reply target", () => {
    // Without reply target
    sendOrReply("Text1", null);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendReply).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // With reply target
    const replyTarget = { id: "msg-456" };
    sendOrReply("Text2", replyTarget);
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("works with GIF URLs preserving reply context", () => {
    const replyTarget = { id: "msg-gif-reply" };
    const gifUrl = "https://example.com/cat.gif";

    // Simulate GIF selection with reply target - ensures the bug is fixed
    sendOrReply(gifUrl, replyTarget);

    expect(sendReply).toHaveBeenCalledWith(gifUrl, replyTarget);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("works with GIF URLs without reply context", () => {
    const gifUrl = "https://example.com/dog.gif";

    sendOrReply(gifUrl, null);

    expect(sendMessage).toHaveBeenCalledWith(gifUrl);
    expect(sendReply).not.toHaveBeenCalled();
  });
});
