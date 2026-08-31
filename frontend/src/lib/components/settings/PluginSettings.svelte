<script lang="ts">
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { ExternalLink, Settings2, X } from "@lucide/svelte";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { getPlugin, getRegistry } from "$lib/plugins/registry";
  import { pluginPrefs, togglePlugin } from "$lib/plugins/prefs.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import type { PluginComponent } from "$lib/plugins/api";
  import { Tip } from "$lib/components/ui/tooltip";

  const registry = getRegistry();

  // The open settings modal: which plugin, and its loaded component.
  let settingsFor = $state<string | null>(null);
  let settingsComponent = $state<PluginComponent | null>(null);
  async function openPluginSettings(pluginId: string) {
    const plugin = await getPlugin(pluginId);
    if (!plugin?.settings) return;
    settingsComponent = plugin.settings;
    settingsFor = pluginId;
  }
  function closePluginSettings() {
    settingsFor = null;
    settingsComponent = null;
  }

  // Grouped by ORIGIN, because that is the trust boundary the intro above
  // describes: plugins without a repository are built into this instance's
  // own code; the rest are grouped under the repository they were fetched
  // from, so "where did this code come from" is the page's structure. The
  // repository is self-declared in the manifest - a label, not a proof.
  // Deep links (".../tree/main/frontend/plugins/poll") group under their
  // REPOSITORY root - two built-ins pointing into the same repo are one
  // origin, not two. The deep link survives as the row's own source link.
  const repoRoot = (url: string): string => {
    try {
      const u = new URL(url);
      const segs = u.pathname.split("/").filter(Boolean);
      if (
        /(^|\.)(github\.com|gitlab\.com|codeberg\.org)$/.test(u.hostname) &&
        segs.length >= 2
      ) {
        return `${u.origin}/${segs[0]}/${segs[1]}`;
      }
      return (u.origin + u.pathname).replace(/\/$/, "");
    } catch {
      return url;
    }
  };

  const groups = (() => {
    const byRepo = new Map<
      string | null,
      [string, ReturnType<typeof registry.get> & object][]
    >();
    for (const entry of registry.entries()) {
      const repo = entry[1].manifest.repository
        ? repoRoot(entry[1].manifest.repository)
        : null;
      const list = byRepo.get(repo) ?? [];
      list.push(entry);
      byRepo.set(repo, list);
    }
    const system = byRepo.get(null) ?? [];
    byRepo.delete(null);
    return [
      ...(system.length ? [{ repo: null as string | null, items: system }] : []),
      ...[...byRepo.entries()]
        .sort((a, b) => a[0]!.localeCompare(b[0]!))
        .map(([repo, items]) => ({ repo, items })),
    ];
  })();

  const repoLabel = (repo: string) =>
    repo.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
</script>

<div class="flex flex-col gap-6">
  <p class="text-xs font-mono text-muted-foreground leading-relaxed">
    Plugins are chosen by whoever runs this instance, are not vetted, and run
    with the same access as the app - one could read or store data in the
    rooms where it is used, and a heavy one can degrade the whole app's
    performance. Reading their source is advised.
  </p>
  {#if registry.size === 0}
    <div
      class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
    >
      <p class="text-xs font-mono text-muted-foreground">
        No plugins installed on this instance.
      </p>
    </div>
  {:else}
    {#each groups as group (group.repo ?? "__system")}
    <!-- One CONTAINER per origin: the box is the grouping, its header names
         (and links) the source everything inside came from. -->
    <div
      class="flex flex-col divide-y divide-border/50 rounded-lg border border-border/50 bg-muted/30"
    >
      <div class="px-4 py-2">
        {#if group.repo === null}
          <p
            class="select-none text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
          >
            Built into this instance
          </p>
        {:else}
          <a
            href={group.repo}
            target="_blank"
            rel="noopener noreferrer"
            class="select-none inline-flex w-fit items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground hover:text-primary hover:underline"
          >
            {repoLabel(group.repo)}<ExternalLink class="size-3" />
          </a>
        {/if}
      </div>
      {#each group.items as [pluginId, registered] (pluginId)}
        <div class="flex items-center justify-between gap-3 px-4 py-3">
          <div class="flex items-center gap-3 min-w-0">
            <span class="text-lg"><PluginIcon icon={registered.manifest.icon} class="size-5" /></span>
            <div class="min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <span class="text-xs font-mono font-semibold"
                  >{registered.manifest.name}</span
                >
                {#if registered.manifest.version}
                  <!-- The plugin's own version - v{apiVersion} here showed a
                       constant "v1" for everything. -->
                  <span class="text-xs font-mono text-muted-foreground"
                    >v{registered.manifest.version}</span
                  >
                {/if}
                {#if registered.manifest.repository && group.repo !== null && registered.manifest.repository !== group.repo}
                  <!-- The group header links the repo; a DEEPER declared
                       path (the plugin's folder) keeps its own link. -->
                  <a
                    href={registered.manifest.repository}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex items-center gap-0.5 text-xs font-mono text-muted-foreground hover:text-primary hover:underline"
                    >source<ExternalLink class="size-3" /></a
                  >
                {/if}
              </div>
              <p class="text-xs font-mono text-muted-foreground truncate">
                {registered.manifest.description}
              </p>
              {#if registered.manifest.author || registered.manifest.license}
                <p class="text-[10px] font-mono text-muted-foreground/70">
                  {[registered.manifest.author, registered.manifest.license]
                    .filter(Boolean)
                    .join(" - ")}
                </p>
              {/if}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            {#if registered.manifest.hasSettings && !pluginPrefs.disabledPluginIds.includes(pluginId)}
              <Tip text={`${registered.manifest.name} settings`}>
                {#snippet children(props)}
                  <button
                    {...props}
                    type="button"
                    onclick={() => void openPluginSettings(pluginId)}
                    aria-label={`${registered.manifest.name} settings`}
                    class="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <Settings2 class="size-4" />
                  </button>
                {/snippet}
              </Tip>
            {/if}
            <Switch
              checked={!pluginPrefs.disabledPluginIds.includes(pluginId)}
              onCheckedChange={(checked) => togglePlugin(pluginId, checked)}
            />
          </div>
        </div>
      {/each}
    </div>
    {/each}
  {/if}

  <div class="flex flex-wrap justify-end gap-x-4 gap-y-1">
    <a
      href="https://github.com/awful-org/awful.chat/tree/main/frontend/plugins#readme"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
    >
      Develop your own plugin<ExternalLink class="size-3" />
    </a>
    <a
      href="https://github.com/awful-org/awfully-awesome"
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
    >
      Browse curated plugins<ExternalLink class="size-3" />
    </a>
  </div>
</div>

{#if settingsFor && settingsComponent}
  {@const SettingsUi = settingsComponent}
  {@const m = registry.get(settingsFor)?.manifest}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    onclick={closePluginSettings}
  >
    <div
      class="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label={`${m?.name ?? settingsFor} settings`}
      tabindex="-1"
    >
      <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <PluginIcon icon={m?.icon ?? "lucide:unplug"} class="size-4" />
        <span class="font-mono text-sm font-semibold">
          {m?.name ?? settingsFor} settings
        </span>
        <button
          type="button"
          onclick={closePluginSettings}
          aria-label="Close settings"
          class="ml-auto cursor-pointer rounded p-1 text-muted-foreground hover:text-destructive"
        >
          <X class="size-3.5" />
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-4">
        <!-- App-level settings: no card, no room - the host is bound to "" so
             sends are impossible and storage is the plugin's own. -->
        <SettingsUi host={makeHostApi(settingsFor, "")} />
      </div>
    </div>
  </div>
{/if}
