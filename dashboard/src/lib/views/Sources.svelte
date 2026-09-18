<!--
  Sources: get data in, and say exactly what happened to every file.

  A file that is not a usable bundle stays in the list with its reason. A silent
  drop would hide the real problem, which is usually a schema version or a
  hand-edited JSON file.
-->
<script lang="ts">
  import {
    LOG_PARSERS,
    app,
    clearAll,
    fmtBytes,
    loadFiles,
    loadFromRelay,
    loadRelayBundle,
    removeFile,
    setParser,
    shortPeer,
    type LogParser,
  } from "$lib/sources.svelte";

  let hot = $state(false);

  function drop(e: DragEvent): void {
    e.preventDefault();
    hot = false;
    const list = e.dataTransfer?.files;
    if (list) void loadFiles([...list]);
  }

  function pick(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    if (input.files) void loadFiles([...input.files]);
    input.value = "";
  }
</script>

<div class="flex flex-col gap-3">
  <div class="grid gap-3 lg:grid-cols-[1fr_22rem]">
    <!-- Drop zone -->
    <div
      role="group"
      aria-label="Load bundles and logs"
      class="flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed p-6 transition-colors
             {hot ? 'border-key bg-raise' : 'border-line bg-surface'}"
      ondragover={(e) => {
        e.preventDefault();
        hot = true;
      }}
      ondragleave={() => (hot = false)}
      ondrop={drop}
    >
      <p class="text-[13px] text-text font-mono tracking-wide">DROP FILES HERE</p>
      <p class="text-center text-[11px] text-faint max-w-sm">
        Bundle: JSON from Diagnostics pane. Log: <code>docker logs -t</code> output (relay, SFU) or browser console.
      </p>
      <label class="btn cursor-pointer">
        Choose files
        <input type="file" multiple class="hidden" onchange={pick} />
      </label>
    </div>

    <!-- Relay -->
    <section class="panel flex flex-col">
      <h2 class="panel-head">relay console</h2>
      <div class="flex flex-col gap-3 p-2.5">
        <label class="flex flex-col gap-1.5">
          <span class="font-mono text-[10px] tracking-wider text-faint uppercase">relay host</span>
          <input
            class="field"
            placeholder="relay.example.com"
            bind:value={app.relay.apiBase}
            aria-label="Relay host"
          />
        </label>
        <label class="flex flex-col gap-1.5">
          <span class="font-mono text-[10px] tracking-wider text-faint uppercase">admin token</span>
          <input
            class="field"
            type="password"
            autocomplete="off"
            placeholder="TELEMETRY_ADMIN_TOKEN"
            bind:value={app.relay.token}
            aria-label="Admin token"
          />
        </label>
        <p class="text-[10px] text-faint leading-relaxed">
          Token stays in memory. Reload loses it (intentional).
        </p>
        <button
          class="btn self-start"
          disabled={app.relay.busy}
          onclick={() => void loadFromRelay()}
          aria-busy={app.relay.busy}
        >
          {app.relay.busy ? "…" : "List bundles"}
        </button>

        {#if app.relay.message}
          <p
            class="text-[11px] px-1"
            role={app.relay.ok ? "status" : "alert"}
            style="color: {app.relay.ok ? 'var(--color-dim)' : 'var(--color-sev-error)'}"
          >
            {app.relay.message}
          </p>
        {/if}

        {#if app.relay.bundles.length > 0}
          <ul class="flex max-h-56 flex-col gap-1 overflow-auto border border-line/30 rounded p-1.5">
            {#each app.relay.bundles as b (b.id)}
              <li class="flex items-center justify-between gap-2 px-2 py-1 rounded hover:bg-raise/50 transition-colors">
                <span class="min-w-0 font-mono text-[11px]">
                  <span class="text-key">{shortPeer(b.peerId)}</span>
                  <span class="text-faint ms-1">{fmtBytes(b.size)}</span>
                </span>
                <button
                  class="btn text-[10px]"
                  disabled={app.relay.busy}
                  onclick={() => void loadRelayBundle(b)}
                  aria-label="Load bundle from {shortPeer(b.peerId)}"
                >
                  Load
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </div>

  <!-- Loaded -->
  <section class="panel">
    <div class="panel-head justify-between">
      <div class="flex items-center gap-2">
        <span>loaded</span>
        <span class="text-faint">({app.files.length})</span>
      </div>
      <button
        class="btn"
        disabled={app.files.length === 0}
        onclick={clearAll}
        aria-label="Remove all loaded files"
      >
        Clear all
      </button>
    </div>

    {#if app.files.length === 0}
      <p class="p-4 text-dim">
        No files loaded. Drag and drop bundles and container logs to start.
      </p>
    {:else}
      <div class="overflow-x-auto">
        <table class="tbl">
          <thead>
            <tr>
              <th>file</th>
              <th>role</th>
              <th>observer</th>
              <th class="text-right">events</th>
              <th class="text-right">size</th>
              <th>parser</th>
              <th>notes</th>
              <th style="width: 3rem"></th>
            </tr>
          </thead>
          <tbody>
            {#each app.files as f (f.id)}
              <tr class="group">
                <td class="max-w-[22rem] truncate" title={f.name}>
                  {f.name}
                  {#if f.fromRelay}<span class="chip ml-1 text-key">relay</span>{/if}
                </td>
                <td>
                  <span
                    class="chip"
                    style="color: {f.role === 'rejected'
                      ? 'var(--color-sev-error)'
                      : f.role === 'bundle'
                        ? 'var(--color-sev-info)'
                        : 'var(--color-dim)'}"
                  >
                    {f.role}
                  </span>
                </td>
                <td class="text-dim" title={f.observer}>{shortPeer(f.observer)}</td>
                <td class="text-right">{f.eventCount}</td>
                <td class="text-right text-faint">{fmtBytes(f.bytes)}</td>
                <td>
                  {#if f.role === "log"}
                    <select
                      class="field text-[11px]"
                      value={f.parser}
                      onchange={(e) =>
                        setParser(f.id, (e.currentTarget as HTMLSelectElement).value as LogParser)}
                      aria-label="Parser for {f.name}"
                    >
                      {#each LOG_PARSERS as p (p.id)}
                        <option value={p.id}>{p.label}</option>
                      {/each}
                    </select>
                  {:else}
                    <span class="text-faint">-</span>
                  {/if}
                </td>
                <td class="max-w-[26rem]">
                  {#if f.error}
                    <span style="color: var(--color-sev-error)">{f.error}</span>
                  {:else}
                    {#if f.unmatched > 0}
                      <span class="chip mr-1" style="color: var(--color-sev-warn)">
                        {f.unmatched} unmatched
                      </span>
                    {/if}
                    {#each f.warnings as w, i (i)}
                      <span class="block text-[11px]" style="color: var(--color-sev-warn)">{w}</span>
                    {/each}
                  {/if}
                </td>
                <td class="text-center">
                  <button
                    class="btn opacity-0 group-hover:opacity-100 transition-opacity"
                    onclick={() => removeFile(f.id)}
                    aria-label="Remove {f.name}"
                    title="Remove file"
                  >
                    Drop
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if app.warnings.length > 0}
    <section class="panel">
      <h2 class="panel-head">workspace warnings</h2>
      <ul class="flex flex-col gap-1 p-2.5">
        {#each app.warnings as w, i (i)}
          <li class="text-[11px]" style="color: var(--color-sev-warn)">{w}</li>
        {/each}
      </ul>
    </section>
  {/if}
</div>
