import type { Message } from "./types/message";

/**
 * A DM conversation floating over whatever is on screen.
 *
 * It exists because the in-call "Message" action had nowhere to put a DM. It
 * pointed the whole chat pane at the conversation, which killed the call stage
 * (the stage is gated on the pane showing the call's room) and rendered nothing,
 * because the pane filters messages by the room the VIEW is on and only the
 * transport had been switched. A second conversation surface, owning its own
 * message list, is what that action actually needed.
 *
 * This module is deliberately a leaf: the transport pushes arriving messages in
 * here, so it must not import the transport back. Opening and closing live in
 * dm.svelte.ts, which already knows how to resolve a peer to a conversation.
 */

export interface DmPanelState {
  /** The peer whose conversation is open. Null when the panel is closed. */
  peerId: string | null;
  /** Its DM room code: a hash of the two DIDs, the key every message carries. */
  roomCode: string | null;
  /** Display name for the header. */
  peerName: string;
  /**
   * This panel's own messages. NOT transportState.messages: that array belongs
   * to the pane behind the panel, and sharing it is precisely how the old
   * behaviour ended up rendering one conversation's messages under another
   * conversation's key.
   */
  messages: Message[];
  x: number;
  y: number;
  /** Collapsed to its title bar, so a call stays watchable underneath. */
  minimized: boolean;
  loading: boolean;
}

export const WIDTH = 340;
export const HEIGHT = 420;
export const BAR_HEIGHT = 40;

export const dmPanel = $state<DmPanelState>({
  peerId: null,
  roomCode: null,
  peerName: "",
  messages: [],
  x: 0,
  y: 0,
  minimized: false,
  loading: false,
});

/** Bottom-right, clear of the call controls, and never off screen. */
export function defaultPanelPosition(): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 24, y: 24 };
  return {
    x: Math.max(8, window.innerWidth - WIDTH - 24),
    y: Math.max(8, window.innerHeight - HEIGHT - 96),
  };
}

/**
 * File an arriving or outgoing message into the panel.
 *
 * Keyed on the room code, so a message for any other conversation is ignored -
 * the panel cannot show the wrong thread even while the pane behind it is
 * switching rooms.
 */
export function appendToDmPanel(msg: Message): void {
  if (!dmPanel.roomCode || msg.roomCode !== dmPanel.roomCode) return;
  if (dmPanel.messages.some((m) => m.id === msg.id)) return;
  dmPanel.messages = [...dmPanel.messages, msg].sort((a, b) =>
    a.lamport !== b.lamport
      ? a.lamport - b.lamport
      : a.senderId.localeCompare(b.senderId)
  );
}

/** True when the panel is showing this conversation, so it counts as read. */
export function dmPanelIsShowing(roomCode: string): boolean {
  return (
    !!dmPanel.roomCode && dmPanel.roomCode === roomCode && !dmPanel.minimized
  );
}
