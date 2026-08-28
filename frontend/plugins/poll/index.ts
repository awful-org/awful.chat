import { definePlugin } from "$lib/plugins/api";
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
        console.warn("[poll] format: /poll Question? Option1, Option2, ...");
        return;
      }
      await host.sendCard(parsed);
    },
  },
});
