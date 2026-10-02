<script lang="ts">
  /**
   * An app in the call. The host mounts this once the person joins the tile;
   * the disclosure comes first, unless they turned it off for this site, then
   * the site in a sandboxed iframe that speaks the awful contract
   * (docs/awful-contract.md) through this component and nothing else.
   *
   * What the site gets is decided here: the session, what the starter typed
   * after the URL, display names, per-session player ids. Never a DID, the
   * room, its secret or its name.
   */
  import { onDestroy } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import { Maximize2, Minimize2 } from "@lucide/svelte";
  import type { CallTileProps } from "$lib/plugins/api";
  import { HEARTBEAT_MS, playerId, presentPlayers, type AppState } from "./logic";
  import { helloMessage, PROTOCOL, rateLimiter, readAppMessage, type Player } from "./bridge";
  import { agree, hasAgreed } from "./consent";

  let { card, cardState, host, chromeVisible, focused, setFocused }: CallTileProps<AppState> = $props();

  const app = $derived(cardState);
  const site = $derived(app.url ? new URL(app.url).host : "");
  const selfDid = host.selfDid();
  const mine = $derived(selfDid === app.starter);

  // Mounted = joined. "closed" is the app having closed itself; leaving the
  // tile is the host's own Leave, which unmounts this.
  let phase = $state<"disclose" | "open" | "closed">(
    cardState.origin && hasAgreed(cardState.origin) ? "open" : "disclose",
  );
  let frame = $state<HTMLIFrameElement | null>(null);
  /** "Don't show again for this site" - off unless the person turns it on. */
  let remember = $state(false);
  /**
   * How many times the app has said `ready` since it opened; 0 until then.
   * A count, not a flag: a page that reloads or navigates inside the frame
   * says it again, and every `ready` is answered with a fresh `hello`.
   */
  let ready = $state(0);
  let now = $state(Date.now());
  /** Player ids by DID, computed as people appear. */
  let ids = $state<Record<string, string>>({});
  /** DIDs whose id is being computed, so a re-run does not start another. */
  const pending = new Set<string>();

  const others = $derived(presentPlayers(app, now).filter((p) => p.did !== selfDid));
  const everyone = $derived(
    phase === "open" ? [{ did: selfDid, name: host.selfName() }, ...others] : others,
  );

  $effect(() => {
    for (const { did } of everyone) {
      if (ids[did] || pending.has(did)) continue;
      pending.add(did);
      void playerId(app.salt, app.sessionId, did)
        .then((id) => {
          ids = { ...ids, [did]: id };
        })
        .finally(() => pending.delete(did));
    }
  });

  function asPlayer(p: { did: string; name: string }): Player | null {
    const id = ids[p.did];
    return id ? { id, name: p.name, color: null } : null;
  }
  const players = $derived(everyone.map(asPlayer).filter((p): p is Player => !!p));
  const self = $derived(asPlayer({ did: selfDid, name: host.selfName() }));

  function theme(): "dark" | "light" {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
  }

  /** To the app, and only ever to its own origin. */
  function post(message: unknown): void {
    frame?.contentWindow?.postMessage(message, app.origin);
  }

  function presence(t: "join" | "here" | "leave"): void {
    void host.sendUpdate(card.id, { t }, { ephemeral: true }).catch(() => {});
  }

  function agreeAndOpen(): void {
    if (remember) agree(app.origin);
    phase = "open";
  }

  function close(): void {
    if (phase === "open") presence("leave");
    phase = "closed";
    ready = 0;
  }

  // Open: say so, keep saying so, and listen to the app.
  $effect(() => {
    if (phase !== "open") return;
    presence("join");
    const beat = setInterval(() => presence("here"), HEARTBEAT_MS);
    const tick = setInterval(() => (now = Date.now()), 5_000);
    const allow = rateLimiter();
    const onMessage = (event: MessageEvent) => {
      // Every message from the frame counts against its rate, junk included,
      // and before readAppMessage serializes it to measure its size.
      if (!frame?.contentWindow || event.source !== frame.contentWindow || !allow()) return;
      const message = readAppMessage(event, frame.contentWindow, app.origin);
      if (!message) return;
      if (message.type === "ready") ready += 1;
      else if (message.type === "close") close();
    };
    window.addEventListener("message", onMessage);
    // The page's theme can change while the app is open.
    const observer = new MutationObserver(() => {
      if (ready) post({ awful: PROTOCOL, type: "theme", theme: theme() });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      clearInterval(beat);
      clearInterval(tick);
      window.removeEventListener("message", onMessage);
      observer.disconnect();
    };
  });

  // Someone new opened it: answer at once, so they list us without waiting
  // out a heartbeat.
  let known = new Set<string>();
  $effect(() => {
    const dids = new Set(others.map((p) => p.did));
    const arrived = [...dids].some((did) => !known.has(did));
    known = dids;
    if (phase === "open" && arrived) presence("here");
  });

  // `hello` for each `ready`, once we know our own id; `players` after.
  let helloFor = 0;
  let lastPlayers = "";
  $effect(() => {
    if (!ready || !self) {
      if (!ready) helloFor = 0;
      return;
    }
    const list = JSON.stringify(players);
    if (helloFor !== ready) {
      helloFor = ready;
      lastPlayers = list;
      post(
        helloMessage({
          sessionId: app.sessionId,
          startedAt: card.timestamp,
          args: app.args,
          self,
          players,
          theme: theme(),
          locale: navigator.language || "en",
        }),
      );
    } else if (list !== lastPlayers) {
      lastPlayers = list;
      post({ awful: PROTOCOL, type: "players", players });
    }
  });

  function end(): void {
    void host.sendUpdate(card.id, { t: "end" }).catch(() => {});
  }

  onDestroy(() => {
    if (phase === "open") presence("leave");
  });
</script>

<!-- The host's layer ignores the pointer; only what takes input opts back
     in. The header stays pointer-transparent so hovering it shows the call's
     chrome, clicking it focuses the tile and right-clicking it opens the tile
     menu - none of which reaches the host from inside a cross-origin iframe. -->
<div class="flex h-full w-full flex-col overflow-hidden bg-black font-mono text-white">
  <!-- The site's address, always, outside anything the site draws: an app
       must never pass for the host. Left room for the host's Leave button,
       right room for its audience chip. -->
  <div class="flex h-10 shrink-0 items-center gap-2 border-b border-white/10 pl-12 pr-14 text-[11px]">
    <span class="truncate text-white/90" title={app.url}>{site}</span>
    <!-- Said out loud: the app's own page takes every click inside it, so
         "click the tile to focus it" only works on this header. -->
    <button
      type="button"
      onclick={(event) => {
        event.stopPropagation();
        setFocused(!focused);
      }}
      class="pointer-events-auto ml-auto flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-white/10 px-2 py-0.5 text-white/90 hover:bg-white/20"
    >
      {#if focused}<Minimize2 class="size-3" />Unfocus{:else}<Maximize2 class="size-3" />Focus{/if}
    </button>
    {#if mine && chromeVisible && phase !== "disclose"}
      <button
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          end();
        }}
        class="pointer-events-auto shrink-0 cursor-pointer rounded-md bg-white/10 px-2 py-0.5 text-red-300 hover:bg-white/20">End for everyone</button
      >
    {/if}
  </div>
  <div class="relative min-h-0 flex-1">
    {#if phase === "open"}
      <iframe
        bind:this={frame}
        src={app.url}
        title={`${site} app`}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        referrerpolicy="no-referrer"
        class="pointer-events-auto absolute inset-0 h-full w-full border-0 bg-white"
      ></iframe>
    {:else if phase === "disclose"}
      <!-- Scrolls in a small tile, so it takes the pointer; m-auto rather than
           centering the scroller, which would clip the top when it overflows. -->
      <div class="pointer-events-auto flex h-full w-full overflow-y-auto p-3">
        <div class="m-auto max-w-sm space-y-2 text-xs leading-relaxed">
          <p class="text-sm font-semibold">Open <span class="text-primary">{site}</span>?</p>
          <p><span class="text-white/60">It gets:</span> your name in this call and a player id that only means something here.</p>
          <p><span class="text-white/60">Not:</span> who you are, this conversation's name or messages, or other rooms.</p>
          <p class="text-amber-300">It sees your IP address. Never type your recovery words or password into an app.</p>
          <label class="flex cursor-pointer items-center gap-2 text-white/80">
            <Switch aria-label="Don't show again for {site}" bind:checked={remember} />
            <span>Don't show again for {site}</span>
          </label>
          <Button size="sm" class="w-full font-mono text-xs cursor-pointer" onclick={agreeAndOpen}>Open app</Button>
        </div>
      </div>
    {:else}
      <div class="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-xs">
        <p class="text-white/60">The app closed.</p>
        {#if others.length}
          <p class="text-[11px] text-white/60">{others.map((p) => p.name).join(", ")} {others.length === 1 ? "is" : "are"} still in.</p>
        {/if}
        <button
          type="button"
          onclick={(event) => {
            event.stopPropagation();
            phase = "open";
          }}
          class="pointer-events-auto cursor-pointer rounded-md bg-white/10 px-2 py-1 hover:bg-white/20">Open again</button
        >
      </div>
    {/if}
  </div>
</div>
