import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import AnimePartyCard from "./AnimePartyCard.svelte";
import AnimePartyCallTile from "./AnimePartyCallTile.svelte";
import { initialState, reduce, type AnimePartyState } from "./logic";
import { searchAnime } from "./anilist";

export default definePlugin({
  manifest,
  card: AnimePartyCard,
  callTile: AnimePartyCallTile,
  // A party is worth showing in the call grid once it has a real host and
  // has not been closed - members joining a call is a separate, later step
  // (the tile is click-to-join, like a screen share).
  callTileActive: (cardState: unknown) => {
    const state = cardState as AnimePartyState | undefined;
    return !!state && !state.closed && state.ownerDid !== "";
  },
  callTileViewers: (cardState: unknown) => {
    const state = cardState as AnimePartyState | undefined;
    return state ? [...state.members.values()] : [];
  },
  initialState,
  reduce,
  commands: {
    "anime-party": async (args: string, host: HostApi) => {
      const title = args.trim();
      if (!title) {
        console.warn("[anime-party] format: /anime-party <anime title>");
        return;
      }
      // A best-effort lookup, never a gate: AniList timing out, having no
      // match, or erroring all collapse to the same outcome as never
      // asking - a card with the typed title and no metadata.
      const match = await searchAnime(title).catch(() => null);
      await host.sendCard({
        ownerDid: host.selfDid(),
        title: match?.title ?? title,
        anilistId: match?.id ?? null,
        coverImageUrl: match?.coverImageUrl ?? null,
        episodeCount: match?.episodeCount ?? null,
      });
    },
  },
});
