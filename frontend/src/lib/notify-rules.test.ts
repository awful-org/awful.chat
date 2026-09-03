import { describe, it, expect } from "vitest";
import {
  shouldPlayMessageSound,
  shouldShowNotification,
} from "./notify-rules";

describe("shouldPlayMessageSound", () => {
  it("stays silent while reading the conversation with focus", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: true, focused: true })
    ).toBe(false);
  });

  it("plays when the message lands in another conversation", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: false, focused: true })
    ).toBe(true);
  });

  it("plays when the window is unfocused, even on the open conversation", () => {
    expect(
      shouldPlayMessageSound({ enabled: true, viewingConversation: true, focused: false })
    ).toBe(true);
  });

  it("never plays when switched off", () => {
    expect(
      shouldPlayMessageSound({ enabled: false, viewingConversation: false, focused: false })
    ).toBe(false);
  });
});

describe("shouldShowNotification", () => {
  it("shows whenever the page is hidden", () => {
    expect(
      shouldShowNotification({
        viewingConversation: true,
        focused: true,
        hidden: true,
      })
    ).toBe(true);
  });

  it("shows for another conversation while the app is on screen", () => {
    // The whole point: a phone showing one room while a DM lands in another
    // is not hidden, and used to say nothing at all.
    expect(
      shouldShowNotification({
        viewingConversation: false,
        focused: true,
        hidden: false,
      })
    ).toBe(true);
  });

  it("stays quiet for the conversation being read", () => {
    expect(
      shouldShowNotification({
        viewingConversation: true,
        focused: true,
        hidden: false,
      })
    ).toBe(false);
  });

  it("shows on the open conversation when the window is unfocused", () => {
    expect(
      shouldShowNotification({
        viewingConversation: true,
        focused: false,
        hidden: false,
      })
    ).toBe(true);
  });
});
