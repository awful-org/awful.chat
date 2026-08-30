export interface LocalPluginCardEntry {
  id: string;
  pluginId: string;
  roomCode: string;
  createdAt: number;
  data: unknown;
}

export const localPluginCards = $state({
  entries: [] as LocalPluginCardEntry[],
});

let nextId = 0;

/** One local surface per plugin and room. Running the command again moves it
 * to the bottom and replaces its local input instead of creating duplicates. */
export function upsertLocalCard(
  pluginId: string,
  roomCode: string,
  data: unknown
): LocalPluginCardEntry {
  const now = Date.now();
  const existing = localPluginCards.entries.find(
    (entry) => entry.pluginId === pluginId && entry.roomCode === roomCode
  );
  const entry: LocalPluginCardEntry = {
    id: existing?.id ?? `local-plugin-${now}-${nextId++}`,
    pluginId,
    roomCode,
    createdAt: now,
    data,
  };
  localPluginCards.entries = [
    ...localPluginCards.entries.filter((candidate) => candidate.id !== entry.id),
    entry,
  ];
  return entry;
}

export function closeLocalCard(id: string): void {
  localPluginCards.entries = localPluginCards.entries.filter(
    (entry) => entry.id !== id
  );
}

export function clearLocalCards(): void {
  localPluginCards.entries = [];
}

export function cardsForRoom(roomCode: string): LocalPluginCardEntry[] {
  return localPluginCards.entries.filter((entry) => entry.roomCode === roomCode);
}
