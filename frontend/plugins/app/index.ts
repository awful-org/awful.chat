import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import AppCard from "./AppCard.svelte";
import AppTile from "./AppTile.svelte";
import { forget, hasAgreed } from "./consent";
import { appUrlProblem, initialState, parseAppCommand, playing, presentPlayers, randomToken, reduce, type AppState } from "./logic";

export default definePlugin<AppState>({
  manifest,
  card: AppCard,
  callTile: AppTile,
  initialState,
  reduce,
  callTileActive: (s) => !s.ended && !!s.url,
  callTileViewers: (s) => presentPlayers(s).map((p) => p.name),
  callTileActivities: (s) =>
    Object.fromEntries(presentPlayers(s).flatMap((p) => (p.game ? [[p.did, playing(p.game)]] : []))),
  callTileMenu: ({ card, cardState, host }) => [
    // The way back from "Don't show again": the notice shows next time.
    ...(cardState.origin && hasAgreed(cardState.origin)
      ? [
          {
            id: "notice",
            label: "Show the notice again",
            icon: "lucide:shield-alert",
            run: () => forget(cardState.origin),
          },
        ]
      : []),
    ...(host.selfDid() === cardState.starter && !cardState.ended
      ? [
          {
            id: "end",
            label: "End for everyone",
            icon: "lucide:circle-stop",
            danger: true,
            run: () => host.sendUpdate(card.id, { t: "end" }),
          },
        ]
      : []),
  ],
  commands: {
    app: async (args: string, host: HostApi) => {
      const parsed = parseAppCommand(args);
      if (!parsed) {
        throw new Error(
          appUrlProblem(args.trim().split(/\s/)[0] ?? "") ??
            "Use /app https://example.com, then anything the app should get (up to 256 characters).",
        );
      }
      const before = await host.cards().catch(() => []);
      await host.sendCard({
        url: parsed.url.href,
        sessionId: randomToken("s_"),
        salt: randomToken(),
        args: parsed.args,
      });
      // One app at a time: the call only shows the newest anyway, so the
      // ones you started end for real instead of lingering as "running".
      // Someone else's can only be ended by them; their card says it was
      // replaced (AppCard).
      const self = host.selfDid();
      for (const c of before) {
        const state = c.state as AppState | undefined;
        if (c.senderDid === self && state && !state.ended) {
          await host.sendUpdate(c.id, { t: "end" }).catch(() => {});
        }
      }
    },
  },
});
