/**
 * When does an incoming message make a sound?
 *
 * Pure so it can be tested: the focus axis cannot be driven in a headless
 * browser, which always reports itself focused.
 */
export function shouldPlayMessageSound(input: {
  /** The user has message sounds switched on. */
  enabled: boolean;
  /** The conversation this message belongs to is the one on screen. */
  viewingConversation: boolean;
  /** The window has focus. */
  focused: boolean;
}): boolean {
  if (!input.enabled) return false;
  // Reading the conversation as the message lands: the sound would only
  // announce what the eyes already saw. Every other combination plays -
  // including viewing-but-unfocused, where "on screen" means nothing.
  return !(input.viewingConversation && input.focused);
}

/**
 * When does an incoming message raise a NOTIFICATION?
 *
 * The same rule as the sound, and for the same reason. It used to be
 * `document.hidden` alone, which is wrong on exactly the device this matters
 * most on: a phone showing one room while a DM arrives in another is not
 * hidden, so the DM went unannounced until the user thought to look. What the
 * reader can already see is the conversation ON SCREEN, not the app.
 */
export function shouldShowNotification(input: {
  /** The conversation this message belongs to is the one on screen. */
  viewingConversation: boolean;
  /** The window has focus. */
  focused: boolean;
  /** The page is not being rendered at all (another tab, minimised). */
  hidden: boolean;
}): boolean {
  if (input.hidden) return true;
  return !(input.viewingConversation && input.focused);
}
