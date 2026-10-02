import { definePlugin, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import WheelCard from "./WheelCard.svelte";
import { initialState, parseWheelArgs, reduce } from "./logic";

export default definePlugin({
  manifest,
  card: WheelCard,
  initialState,
  reduce,
  commands: {
    wheel: async (args: string, host: HostApi) => {
      const parsed = parseWheelArgs(args);
      if (!parsed) {
        throw new Error("The wheel needs at least two options: /wheel Who pays? Ana, Bo (the question is optional)");
      }
      await host.sendCard(parsed);
    },
  },
});
