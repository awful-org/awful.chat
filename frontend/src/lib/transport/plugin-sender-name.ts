/**
 * Teardown updates cannot await profile storage. Keep the last real local
 * nickname and otherwise use a stable identity-derived label, never the
 * misleading literal "Anonymous".
 */
export function cachePluginSenderName(
  current: string,
  nickname: string | null | undefined
): string {
  const candidate = nickname?.trim();
  return candidate && candidate !== "Anonymous" ? candidate : current;
}

export function immediatePluginSenderName(
  cachedName: string,
  did: string | null | undefined,
  peerId: string
): string {
  return cachedName || did?.slice(0, 12) || peerId.slice(0, 12) || "Unknown";
}
