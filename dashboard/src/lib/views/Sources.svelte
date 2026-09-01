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
      class="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-6
             {hot ? 'border-key bg-raise' : 'border-line bg-surface'}"
      ondragover={(e) => {
        e.preventDefault();
        hot = true;
      }}
      ondragleave={() => (hot = false)}
      ondrop={drop}
    >
      <p class="text-dim">Drop bundles and container logs here.</p>
      <p class="text-center text-[11px] text-faint">
        A bundle is the JSON the Diagnostics pane exports. A log is the output of
        <code>docker logs -t</code> for the relay or the SFU, or pasted browser console text.
      </p>
      <label class="btn">
        Choose files
        <input type="file" multiple class="hidden" onchange={pick} />
      </label>
    </div>

    <!-- Relay -->
    <section class="panel">
      <h2 class="panel-head">relay console</h2>
      <div class="flex flex-col gap-2 p-2.5">
        <label class="flex flex-col gap-1">
          <span class="font-mono text-[10px] tracking-wider text-faint uppercase">relay host</span>
          <input
            class="field"
            placeholder="relay.example.com"
            bind:value={app.relay.apiBase}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="font-mono text-[10px] tracking-wider text-faint uppercase">admin token</span>
          <input
            class="field"
            type="password"
            autocomplete="off"
            placeholder="TELEMETRY_ADMIN_TOKEN"
            bind:value={app.relay.token}
          />
        </label>
        <p class="text-[11px] text-faint">
          The token stays in memory. A reload loses it, and that is deliberate:
          this console reads a production relay.
        </p>
        <button
          class="btn self-start"
          disabled={app.relay.busy}
          onclick={() => void loadFromRelay()}
        >
          {app.relay.busy ? "…" : "List bundles"}
        </button>

        {#if app.relay.message}
          <p
            class="text-[11px]"
            style="color: {app.relay.ok ? 'var(--color-dim)' : 'var(--color-sev-error)'}"
          >
            {app.relay.message}
          </p>
        {/if}

        {#if app.relay.bundles.length > 0}
          <ul class="flex max-h-56 flex-col gap-1 overflow-auto">
            {#each app.relay.bundles as b (b.id)}
              <li class="flex items-center justify-between gap-2 border-b border-line/40 pb-1">
                <span class="min-w-0 font-mono text-[11px]">
                  <span class="text-key">{shortPeer(b.peerId)}</span>
                  <span class="text-faint">{fmtBytes(b.size)}</span>
                </span>
                <button
                  class="btn"
                  disabled={app.relay.busy}
                  onclick={() => void loadRelayBundle(b)}>Load</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </div>

  <!-- Loaded -->
  <section class="panel">
    <h2 class="panel-head">
      loaded
      <span class="text-faint">{app.files.length}</span>
      <button class="btn ml-auto" disabled={app.files.length === 0} onclick={clearAll}>
        Clear all
      </button>
    </h2>

    {#if app.files.length === 0}
      <p class="p-3 text-dim">
        Nothing loaded. Two client bundles plus the relay and SFU logs give the
        console every vantage it can use.
      </p>
    {:else}
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
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each app.files as f (f.id)}
            <tr>
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
                    class="field"
                    value={f.parser}
                    onchange={(e) =>
                      setParser(f.id, (e.currentTarget as HTMLSelectElement).value as LogParser)}
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
                      {f.unmatched} unmatched line(s)
                    </span>
                  {/if}
                  {#each f.warnings as w, i (i)}
                    <span class="block text-[11px]" style="color: var(--color-sev-warn)">{w}</span>
                  {/each}
                {/if}
              </td>
              <td>
                <button class="btn" onclick={() => removeFile(f.id)}>Drop</button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
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
