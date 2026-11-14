<script lang="ts">
  import { callLayoutPrefs as prefs, setCallLayoutPrefs as set } from "$lib/call-layout-prefs.svelte";
  import { displayPrefs, setCallChatBeside, setCallPip } from "$lib/display-prefs.svelte";
  let { phone = false }: { phone?: boolean } = $props();
</script>

<section aria-label="Layout settings" class="layout-menu font-mono">
  <!-- Pictures, not sentences: each layout and strip position is drawn as
       it looks. Its description is the title: the tooltip, and the
       accessible description screen readers announce after the name. -->
  <div class="section">
    <h4>Layout</h4>
    <div class="cards">
      {#each [
        { value: "auto", label: "Auto", description: "Shares and apps go big, cameras in a strip" },
        { value: "spotlight", label: "Spotlight", description: "One big: what you pinned, or who is talking" },
        { value: "grid", label: "Grid", description: "Everyone the same size" },
      ] as const as option}
        <button type="button" class="card" class:active={prefs.layout === option.value} aria-pressed={prefs.layout === option.value} title={option.description} onclick={() => set({ layout: option.value })}>
          <svg viewBox="0 0 60 38" aria-hidden="true">
            {#if option.value === "auto"}
              <rect x="1" y="1" width="42" height="36" rx="3" class="big" />
              <rect x="8" y="9" width="28" height="3" rx="1" class="ink" /><rect x="8" y="15" width="22" height="2" rx="1" class="ink" /><rect x="8" y="20" width="25" height="2" rx="1" class="ink" />
              <rect x="46" y="1" width="13" height="10.7" rx="2" class="small" /><rect x="46" y="13.7" width="13" height="10.7" rx="2" class="small" /><rect x="46" y="26.3" width="13" height="10.7" rx="2" class="small" />
            {:else if option.value === "spotlight"}
              <rect x="1" y="1" width="58" height="24" rx="3" class="big" />
              <circle cx="30" cy="10" r="4" class="ink" /><path d="M22 25c0-5 3.6-8 8-8s8 3 8 8z" class="ink" />
              <rect x="1" y="28" width="13" height="9" rx="2" class="small" /><rect x="16" y="28" width="13" height="9" rx="2" class="small" /><rect x="31" y="28" width="13" height="9" rx="2" class="small" /><rect x="46" y="28" width="13" height="9" rx="2" class="small" />
            {:else}
              <rect x="1" y="1" width="28" height="17" rx="2.5" class="big" /><rect x="31" y="1" width="28" height="17" rx="2.5" class="big" />
              <rect x="1" y="20" width="28" height="17" rx="2.5" class="big" /><rect x="31" y="20" width="28" height="17" rx="2.5" class="big" />
            {/if}
          </svg>
          <span>{option.label}</span>
        </button>
      {/each}
    </div>
  </div>
  <div class="section">
    <h4>Camera strip</h4>
    <div class="row"><span>Position</span><div class="segments" role="group" aria-label="Camera strip position">
      {#each [
        { value: "auto", label: "Auto: beside when wide, below when narrow" },
        { value: "side", label: "Beside" },
        { value: "top", label: "Above" },
        { value: "bottom", label: "Below" },
        { value: "hidden", label: "Hidden" },
      ] as const as option}
        <button type="button" class:active={prefs.strip === option.value} aria-pressed={prefs.strip === option.value} aria-label={option.label} title={option.label} onclick={() => set({ strip: option.value })}>
          {#if option.value === "auto"}
            Auto
          {:else}
            <svg viewBox="0 0 22 16" class="strip-icon" aria-hidden="true">
              <rect x="1" y="1" width="20" height="14" rx="2" class="frame" />
              {#if option.value === "side"}<rect x="15" y="3.5" width="4" height="9" rx="1" class="bar" />{/if}
              {#if option.value === "top"}<rect x="3.5" y="3" width="15" height="3.5" rx="1" class="bar" />{/if}
              {#if option.value === "bottom"}<rect x="3.5" y="9.5" width="15" height="3.5" rx="1" class="bar" />{/if}
              {#if option.value === "hidden"}<path d="M4 13L18 3" class="frame" />{/if}
            </svg>
          {/if}
        </button>
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
  .cards { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:8px; }
  .card { display:flex; flex-direction:column; align-items:center; gap:6px; padding:10px 6px 8px; border:1px solid #27272a; border-radius:10px; background:transparent; font-size:12px; color:#a1a1aa; }
  .card svg { width:100%; max-width:72px; height:auto; }
  .card .big { fill:currentColor; opacity:.45; }
  .card .small { fill:currentColor; opacity:.3; }
  .card .ink { fill:#18181b; }
  .card.active { border-color:#24f29a; background:#24f29a14; color:#24f29a; }
  .card.active span { color:#fafafa; }
  .strip-icon { display:block; width:22px; height:16px; }
  .strip-icon .frame { fill:none; stroke:currentColor; stroke-width:1.5; }
  .strip-icon .bar { fill:currentColor; }
  .row, label { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:12px; }
  label { min-height:28px; cursor:pointer; }
  .segments { display:flex; gap:2px; padding:2px; border-radius:8px; background:#09090b; }
  .segments button { display:flex; align-items:center; justify-content:center; min-height:28px; border:0; border-radius:6px; padding:4px 7px; background:transparent; color:#a1a1aa; font-size:11px; }
  .segments .active { background:#3f3f46; color:#fafafa; }
  input { width:16px; height:16px; margin:0; accent-color:#24f29a; }
  .extras { border-top:1px solid #27272a; padding-top:12px; }
</style>
