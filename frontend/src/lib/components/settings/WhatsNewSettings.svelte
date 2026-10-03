<script lang="ts">
  /**
   * Settings > What's new: the last pull requests merged into main, newest
   * first, the newest open. Opening the tab is what counts as having seen
   * them, which takes the dot down.
   */
  import { Label } from "$lib/components/ui/label";
  import { renderMessageMarkdown } from "$lib/markdown";
  import { messageBody } from "$lib/actions/message-body";
  import { loadWhatsNew, markWhatsNewSeen, whatsNew } from "$lib/whats-new.svelte";

  $effect(() => {
    void loadWhatsNew().then(markWhatsNewSeen);
  });

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

  /** Every merged pull request into main, from any one of them. */
  const allUrl = $derived.by(() => {
    const url = whatsNew.notes.find((n) => n.url)?.url;
    const repo = url?.match(/^(https:\/\/github\.com\/[^/]+\/[^/]+)\/pull\/\d+$/)?.[1];
    return repo ? `${repo}/pulls?q=is%3Apr+is%3Amerged+base%3Amain` : null;
  });

  // Release notes carry no mentions; a token, if one appears, stays as written
  // (the renderer writes "@" + name, so "[did]" as the name keeps "@[did]").
  const bodies = $derived(
    new Map(whatsNew.notes.map((n) => [n.number, renderMessageMarkdown(n.body, (did) => `[${did}]`)])),
  );
</script>

<div class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50">
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-primary rounded-full"></div>
    <Label class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider">
      What's new
    </Label>
  </div>

  {#if whatsNew.status === "idle" || whatsNew.status === "loading"}
    <p class="text-xs font-mono text-muted-foreground">Loading…</p>
  {:else if whatsNew.status === "none"}
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      Nothing to show. This instance has no release notes yet: they are fetched
      when its server starts, and GitHub did not answer, or it runs somewhere
      they are not published.
    </p>
  {:else}
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      The last releases merged into main.
    </p>
    <div class="flex flex-col gap-2">
      {#each whatsNew.notes as note, i (note.number)}
        <details open={i === 0} class="group rounded-md border border-border/70 bg-background/40">
          <summary class="flex cursor-pointer list-none items-baseline gap-2 px-3 py-2">
            <span class="min-w-0 flex-1 text-xs font-mono font-medium text-foreground">{note.title}</span>
            <span class="shrink-0 text-[11px] font-mono text-muted-foreground">
              {dateFormat.format(new Date(note.mergedAt))}
            </span>
            {#if note.url}
              <a
                href={note.url}
                target="_blank"
                rel="noopener noreferrer"
                class="shrink-0 text-[11px] font-mono text-primary hover:underline"
                onclick={(e) => e.stopPropagation()}>#{note.number}</a
              >
            {:else}
              <span class="shrink-0 text-[11px] font-mono text-muted-foreground">#{note.number}</span>
            {/if}
          </summary>
          {#if note.body.trim()}
            {@const html = bodies.get(note.number) ?? ""}
            <!-- messageBody: code highlighting, copy buttons and spoilers, as in a message. -->
            <div
              class="border-t border-border/60 px-3 py-2 text-xs leading-relaxed text-foreground/90 whitespace-pre-wrap wrap-break-word"
              {@attach messageBody(html)}
            >
              {@html html}
            </div>
          {/if}
        </details>
      {/each}
    </div>
    {#if allUrl}
      <a
        href={allUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="self-start text-xs font-mono text-primary hover:underline">All releases on GitHub</a
      >
    {/if}
  {/if}
</div>
