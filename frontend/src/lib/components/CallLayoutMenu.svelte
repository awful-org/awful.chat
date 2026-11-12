<script lang="ts">
  import { callLayoutPrefs as prefs, setCallLayoutPrefs as set } from "$lib/call-layout-prefs.svelte";
  import { displayPrefs, setCallChatBeside, setCallPip } from "$lib/display-prefs.svelte";
  let { phone = false }: { phone?: boolean } = $props();
</script>

<section aria-label="Layout settings" class="layout-menu font-mono">
  <div class="section">
    <h4>Layout</h4>
    {#each [
      { value: "auto", label: "Auto", description: "Shares and apps go big, cameras in a strip" },
      { value: "spotlight", label: "Spotlight", description: "One big: what you pinned, or who is talking" },
      { value: "grid", label: "Grid", description: "Everyone the same size" },
    ] as const as option}
      <button type="button" class="option" class:active={prefs.layout === option.value} aria-pressed={prefs.layout === option.value} onclick={() => set({ layout: option.value })}>
        <strong>{option.label}</strong><small>{option.description}</small>
      </button>
    {/each}
  </div>
  <div class="section">
    <h4>Camera strip</h4>
    <div class="row"><span>Position</span><div class="segments" role="group" aria-label="Camera strip position">
      {#each ["auto", "side", "bottom", "hidden"] as const as value}
        <button type="button" class:active={prefs.strip === value} aria-pressed={prefs.strip === value} onclick={() => set({ strip: value })}>{value === "auto" ? "Auto" : value === "side" ? "Side" : value === "bottom" ? "Bottom" : "Hidden"}</button>
      {/each}
    </div></div>
    <div class="row"><span>Size</span><div class="segments" role="group" aria-label="Camera strip size">
      {#each ["s", "m", "l"] as const as value}
        <button type="button" class:active={prefs.size === value && prefs.stripPx === null} aria-pressed={prefs.size === value && prefs.stripPx === null} onclick={() => set({ size: value, stripPx: null })}>{value.toUpperCase()}</button>
      {/each}
    </div></div>
  </div>
  <div class="section">
    <h4>Show</h4>
    <div class="row"><span>People</span><div class="segments" role="group" aria-label="Show people">
      {#each [{ value: "all", label: "All" }, { value: "video", label: "With video" }, { value: "none", label: "None" }] as const as option}
        <button type="button" class:active={prefs.people === option.value} aria-pressed={prefs.people === option.value} onclick={() => set({ people: option.value })}>{option.label}</button>
      {/each}
    </div></div>
    {#each [{ key: "screens", label: "Screen shares" }, { key: "apps", label: "Apps" }, { key: "self", label: "Your own camera" }] as const as option}
      <label>{option.label}<input type="checkbox" checked={prefs[option.key]} onchange={(event) => set({ [option.key]: event.currentTarget.checked })} /></label>
    {/each}
  </div>
  <div class="section extras">
    <label>Picture-in-picture<input type="checkbox" checked={displayPrefs.callPip} onchange={(event) => setCallPip(event.currentTarget.checked)} /></label>
    {#if !phone}
      <div class="row"><span>Chat</span><div class="segments" role="group" aria-label="Chat position">
        <button type="button" class:active={!displayPrefs.callChatBeside} aria-pressed={!displayPrefs.callChatBeside} onclick={() => setCallChatBeside(false)}>Below</button>
        <button type="button" class:active={displayPrefs.callChatBeside} aria-pressed={displayPrefs.callChatBeside} onclick={() => setCallChatBeside(true)}>Beside</button>
      </div></div>
    {/if}
  </div>
</section>

<style>
  .layout-menu { display:flex; flex-direction:column; gap:16px; padding:14px; color:#fafafa; background:#18181b; border:1px solid #3f3f46; border-radius:12px; box-shadow:0 16px 40px #0009; }
  .section { display:flex; flex-direction:column; gap:8px; }
  h4 { margin:0; color:#a1a1aa; font-size:12px; font-weight:500; }
  button { font:inherit; color:inherit; cursor:pointer; }
  button:focus-visible, input:focus-visible { outline:2px solid #24f29a; outline-offset:2px; }
  .option { display:flex; flex-direction:column; gap:2px; text-align:left; padding:10px; border:1px solid #27272a; border-radius:10px; background:transparent; font-size:13px; }
  .option.active { border-color:#24f29a; background:#24f29a14; }
  small { font-size:11px; color:#a1a1aa; }
  .row, label { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
  label { min-height:28px; cursor:pointer; }
  .segments { display:flex; gap:2px; padding:2px; border-radius:8px; background:#09090b; }
  .segments button { border:0; border-radius:6px; padding:6px 7px; background:transparent; color:#a1a1aa; font-size:11px; }
  .segments .active { background:#3f3f46; color:#fafafa; }
  input { width:16px; height:16px; margin:0; accent-color:#24f29a; }
  .extras { border-top:1px solid #27272a; padding-top:12px; }
</style>
