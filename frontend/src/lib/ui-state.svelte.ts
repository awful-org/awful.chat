/**
 * Tiny cross-component UI requests. The settings dialog is owned by
 * SidebarControls; anything else that wants to open it (a profile card's
 * edit button, deep in the chat) writes here and the owner reacts.
 */
export const uiState = $state({
  settingsOpenRequested: false,
  settingsTab: null as string | null,
  /**
   * Somebody asked to be taken back to the call they are in. Only AppView knows
   * how to get there - it owns the active conversation - and the button lives
   * in the sidebar, so the request travels through here.
   */
  returnToCallRequested: false,
});

export function openSettings(tab: string | null = null): void {
  uiState.settingsTab = tab;
  uiState.settingsOpenRequested = true;
}

export function requestReturnToCall(): void {
  uiState.returnToCallRequested = true;
}
