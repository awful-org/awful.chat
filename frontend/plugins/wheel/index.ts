import { definePlugin } from "$lib/plugins/api";
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
        console.warn(
          "[wheel] format: /wheel Question? option1, option2 (question optional)"
        );
        return;
      }
      await host.sendCard(parsed);
    },
  },
});
