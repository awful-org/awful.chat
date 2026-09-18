<!--
  AI: the prompt pack.

  A finding names what and where. A model is good at why, but only when it gets
  the contract before the data, which is what `buildPromptPack` assembles. The
  pack carries opaque room refs and no DID, so it is safe to paste anywhere.

  The endpoint and the key stay in memory, exactly like the relay admin token.
-->
<script lang="ts">
  import { app, goTo, sendPromptPack } from "$lib/sources.svelte";

  let copied = $state(false);
  let showKey = $state(false);

  const pack = $derived(app.promptPack);

  async function copy(): Promise<void> {
    if (!pack) return;
    try {
      await navigator.clipboard.writeText(pack.markdown);
      copied = true;
      setTimeout(() => (copied = false), 2500);
    } catch {
      copied = false;
    }
  }

  function download(): void {
    if (!pack || !app.capture) return;
    const blob = new Blob([pack.markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // A capture id embeds its source file name, which can hold a slash (a relay
    // bundle id is `<peerId>/<file>`). A slash in `download` breaks the save.
    a.download = `awful-capture-${app.capture.id.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
    // The anchor must be in the document, and the URL must outlive the click:
    // an immediate revoke cancels the transfer before the browser reads it.
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
</script>

{#if !pack}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn {copied ? 'btn-on' : ''}" onclick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <button class="btn" onclick={download}>Download .md</button>
      <span class="chip text-dim">≈{pack.tokensEstimate} tokens</span>
      <label class="flex items-center gap-1">
        <span class="font-mono text-[10px] tracking-wider text-faint uppercase">events</span>
        <input
          class="field w-20"
          type="number"
          min="50"
          max="4000"
          step="50"
          bind:value={app.ai.maxEvents}
        />
      </label>
      <span class="font-mono text-[10px] text-faint">
        centred on the first blocking finding
      </span>
    </div>

    <section class="panel">
      <h2 class="panel-head">send to endpoint (optional)</h2>
      <div class="flex flex-col gap-2 p-2">
        <div>
          <label class="flex flex-col gap-0.5 mb-1">
            <span class="font-mono text-[10px] tracking-wider text-faint uppercase">endpoint url</span>
            <input
              class="field"
              type="text"
              placeholder="https://api.example.com/v1/chat/completions"
              bind:value={app.ai.endpoint}
              title="OpenAI-compatible endpoint URL"
            />
          </label>
        </div>
        <div class="grid gap-2 grid-cols-[1fr_auto]">
          <div>
            <label class="flex flex-col gap-0.5 mb-1">
              <span class="font-mono text-[10px] tracking-wider text-faint uppercase">api key</span>
              <input
                class="field"
                type={showKey ? "text" : "password"}
                autocomplete="off"
                placeholder="optional, sent as Bearer token"
                bind:value={app.ai.key}
                title="Bearer token for authorization"
              />
            </label>
          </div>
          <div class="flex items-end pb-1">
            <button
              class="btn text-[10px] px-2"
              onclick={() => (showKey = !showKey)}
              title={showKey ? "Hide" : "Show"}
            >
              {showKey ? "hide" : "show"}
            </button>
          </div>
        </div>
        <div>
          <label class="flex flex-col gap-0.5 mb-1">
            <span class="font-mono text-[10px] tracking-wider text-faint uppercase">model (optional)</span>
            <input
              class="field"
              type="text"
              placeholder="e.g., claude-3-5-sonnet-20241022"
              bind:value={app.ai.model}
              title="Model name, omitted if blank"
            />
          </label>
        </div>
        <button
          class="btn w-full font-bold"
          disabled={app.ai.busy || app.ai.endpoint.trim() === ""}
          onclick={() => void sendPromptPack()}
          title="Send the prompt pack to the endpoint. Response appears below."
        >
          {app.ai.busy ? "sending…" : "Send"}
        </button>
      </div>
      <p class="px-2 pb-2 text-[11px] text-faint">
        Sends an OpenAI-shaped request with the pack as one user message. Endpoint and key stay in memory;
        reload loses both.
      </p>
      {#if app.ai.error}
        <p class="px-2 pb-2 text-[11px]" style="color: var(--color-sev-error)">{app.ai.error}</p>
      {/if}
    </section>

    {#if app.ai.response}
      <section class="panel">
        <div class="flex items-center justify-between panel-head">
          <h2 style="color: var(--color-key)">answer</h2>
          <button
            class="btn text-[10px] px-2"
            onclick={() => (app.ai.response = "")}
            title="Clear this response"
          >
            clear
          </button>
        </div>
        <pre class="max-h-96 overflow-auto p-2 text-[11px] whitespace-pre-wrap">{app.ai.response}</pre>
      </section>
    {/if}

    <section class="panel">
      <h2 class="panel-head">prompt pack</h2>
      <pre
        class="max-h-[36rem] overflow-auto p-2 text-[11px] leading-snug whitespace-pre-wrap">{pack.markdown}</pre>
    </section>
  </div>
{/if}
