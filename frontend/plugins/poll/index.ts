import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import PollCard from "./PollCard.svelte";
import { initialState, parsePollArgs, reduce } from "./logic";

export default definePlugin({
  manifest,
  card: PollCard,
  initialState,
  reduce,
  commands: {
    poll: async (args: string, host: HostApi) => {
      const parsed = parsePollArgs(args);
      if (!parsed) {
        throw new Error("A poll needs a question and at least two options: /poll Lunch? Pizza, Sushi");
      }
      await host.sendCard(parsed);
    },
  },
});
