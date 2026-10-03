import { expect, it } from "vitest";
import { around, showOlder, windowRange, type ChatWindow } from "./chat-window";

// Selecting the room that is already open goes through joinRoom
// (AppView.handleSelectRoom: "Always go through the token-claiming join,
// even for the room already on screen"), which empties
// transportState.messages and reloads the newest page. The roomCode prop
// does not change, so ChatView's room reset does not run, and a window held
// far back in history kept cursors to rows that were no longer there: it
// mounted nothing, and the conversation went blank. ChatView now lets go of
// the window when the list empties; whatever window it is handed, a list
// with rows in it mounts some.

function rows(count: number, first = 1) {
  return Array.from({ length: count }, (_, i) => ({
    lamport: first + i,
    id: `m${String(first + i).padStart(6, "0")}`,
  }));
}

it("mounts rows after a jump far back, once the list is reloaded to its newest page", () => {
  const held = rows(2000);
  // A search hit or pinned message 1,900 rows back.
  const window: ChatWindow = around(held, 100);
  const newestPage = rows(50, 1951);
  const r = windowRange(newestPage, window);
  expect(r).toEqual({ from: 0, to: 50 });
});

it("mounts rows after scrolling back past a full window, once the list is reloaded", () => {
  let list = rows(600);
  let window: ChatWindow = null;
  for (let i = 0; i < 6; i++) window = showOlder(list, windowRange(list, window));
  expect(window!.end).not.toBeNull();
  list = rows(50, 551);
  const r = windowRange(list, window);
  expect(r.to - r.from).toBeGreaterThan(0);
});

it("mounts nothing only when there is nothing", () => {
  const window: ChatWindow = around(rows(300), 10);
  expect(windowRange([], window)).toEqual({ from: 0, to: 0 });
});
