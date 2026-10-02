import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import AppCard from "./AppCard.svelte";
import AppTile from "./AppTile.svelte";
import { initialState, parseAppCommand, presentPlayers, randomToken, reduce, type AppState } from "./logic";

export default definePlugin<AppState>({
  manifest,
  card: AppCard,
  callTile: AppTile,
  initialState,
  reduce,
  callTileActive: (s) => !s.ended && !!s.url,
  callTileViewers: (s) => presentPlayers(s).map((p) => p.name),
  callTileMenu: ({ card, cardState, host }) =>
    host.selfDid() === cardState.starter && !cardState.ended
      ? [
          {
            id: "end",
            label: "End for everyone",
            icon: "lucide:circle-stop",
            danger: true,
            run: () => host.sendUpdate(card.id, { t: "end" }),
          },
        ]
      : [],
  commands: {
    app: async (args: string, host: HostApi) => {
      const parsed = parseAppCommand(args);
      if (!parsed) {
        throw new Error("Use /app https://example.com, then anything the app should get (up to 256 characters).");
      }
      await host.sendCard({
        url: parsed.url.href,
        sessionId: randomToken("s_"),
        salt: randomToken(),
        args: parsed.args,
      });
    },
  },
});
