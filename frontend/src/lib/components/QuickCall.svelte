<script lang="ts">
  /**
   * /qc - the whole page. A setup screen, then the app's own call view.
   *
   * The call UI is deliberately NOT reimplemented: VoiceVideoCallView reads
   * the same global stores here as it does inside a room, so a quick call
   * gets camera, screen share, mute, deafen, spotlight, picture-in-picture,
   * per-tile menus and plugin call tiles for nothing.
   */
  import { onDestroy, onMount } from "svelte";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { Check, Copy, Link2, PhoneOff } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import VoiceVideoCallView from "$lib/components/VoiceVideoCallView.svelte";
  import { profileStore } from "$lib/profile.svelte";
  import { formatRoomCode } from "$lib/room-code";
  import {
    endQuickCall,
    prepareQuickCall,
    quickCall,
    rememberQuickProfile,
    setQuickCallCode,
    startQuickCall,
    teardownQuickCall,
  } from "$lib/quick/quick-call.svelte";

  let name = $state(quickCall.profile.name);
  let avatarUrl = $state(quickCall.profile.avatarUrl);
  let remember = $state(quickCall.remembered);
  let pickerOpen = $state(false);
  let copied = $state(false);
  // The avatar picker's GIF search is a svelte-query consumer, and this page
  // is not inside AppView's provider. Without one it throws while mounting,
  // which in Svelte 5 leaves the PREVIOUS route on screen - the page simply
  // did not appear.
  const queryClient = new QueryClient();

  const link = $derived(
    quickCall.code ? `${window.location.origin}/qc#${quickCall.code}` : ""
  );
  /** True when this page minted the code rather than following a link. */
  let isHost = $state(false);

  onMount(() => {
    const fromLink = window.location.hash.slice(1);
    isHost = !fromLink;
    setQuickCallCode(fromLink || undefined);
    // The identity has to be live before the avatar picker can write
    // anything - see prepareQuickCall.
    void prepareQuickCall();
    // The code IS the secret, so it lives in the fragment and never in the
    // path - same reasoning as room invites, see App.svelte.
    if (isHost) {
      history.replaceState(history.state, "", `/qc#${quickCall.code}`);
    }
    // pagehide, not beforeunload: it is the one that fires on mobile when the
    // tab is discarded, and dropping the database is the whole promise here.
    const bye = () => teardownQuickCall();
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  });

  onDestroy(teardownQuickCall);

  async function join() {
    // The picker writes straight to the profile store, so what it set wins
    // over the value this page started with.
    const picked = profileStore.avatarUrl ?? avatarUrl;
    rememberQuickProfile(remember ? { name, avatarUrl: picked } : null);
    await startQuickCall({ name, avatarUrl: picked });
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard denied: the address bar holds the same link.
    }
  }
</script>

<QueryClientProvider client={queryClient}>
  {#if quickCall.stage === "in-call"}
    <div class="flex h-screen flex-col bg-background text-foreground">
      <header
        class="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2"
      >
        <div class="flex min-w-0 items-center gap-2">
          <Link2 class="size-4 shrink-0 text-muted-foreground" />
          <code class="truncate font-mono text-sm">
            {formatRoomCode(quickCall.code)}
          </code>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onclick={copyLink}>
            {#if copied}
              <Check class="size-4" /> Copied
            {:else}
              <Copy class="size-4" /> Copy link
            {/if}
          </Button>
          <Button variant="destructive" size="sm" onclick={endQuickCall}>
            <PhoneOff class="size-4" /> Leave
          </Button>
        </div>
      </header>
      <div class="flex min-h-0 flex-1 flex-col">
        <VoiceVideoCallView beside={false} />
      </div>
    </div>
  {:else}
    <div class="flex min-h-screen justify-center bg-background text-foreground p-4">
      <div class="w-full max-w-md space-y-6 py-10">
        <header class="space-y-1">
          <h1 class="text-2xl font-semibold">Quick call</h1>
          <p class="text-sm text-muted-foreground">
            {#if isHost}
              Start a call and send the link to whoever should join. No account,
              and nothing about it is kept once you close the tab.
            {:else}
              You have been invited to a call. Pick a name and join - no account
              needed.
            {/if}
          </p>
        </header>

        <div class="space-y-3 rounded-lg border border-border p-4">
          <button
            type="button"
            class="flex items-center gap-3 text-left"
            onclick={() => (pickerOpen = true)}
          >
            {#if profileStore.avatarUrl ?? avatarUrl}
              <img
                src={profileStore.avatarUrl ?? avatarUrl}
                alt=""
                class="size-12 rounded-full object-cover"
              />
            {:else}
              <span
                class="flex size-12 items-center justify-center rounded-full bg-muted text-lg"
              >
                {name.trim().charAt(0).toUpperCase() || "?"}
              </span>
            {/if}
            <span class="text-sm text-muted-foreground underline-offset-2 hover:underline">
              {profileStore.avatarUrl ?? avatarUrl ? "Change picture" : "Add a picture"}
            </span>
          </button>

          <label class="block space-y-1.5">
            <span class="text-sm font-medium">Your name</span>
            <Input bind:value={name} maxlength={64} placeholder="Your name" />
          </label>

          <label class="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" bind:checked={remember} class="size-4" />
            Remember this for next time
          </label>
        </div>

        {#if quickCall.stage === "failed"}
          <p class="text-sm text-destructive">
            {quickCall.error ?? "Could not join the call."}
          </p>
        {/if}

        <Button
          class="w-full"
          disabled={quickCall.stage === "joining" ||
            quickCall.stage === "preparing"}
          onclick={join}
        >
          {quickCall.stage === "joining" ? "Joining..." : "Join call"}
        </Button>

        {#if quickCall.code}
          <div class="space-y-2 rounded-lg border border-border p-4">
            <div class="flex items-center justify-between gap-3">
              <code class="font-mono tracking-wide">
                {formatRoomCode(quickCall.code)}
              </code>
              <Button variant="outline" size="sm" onclick={copyLink}>
                {#if copied}
                  <Check class="size-4" /> Copied
                {:else}
                  <Copy class="size-4" /> Copy link
                {/if}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              Anyone holding this link can join the call, so send it to the
              people you mean to talk to.
            </p>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <AvatarPickerDialog open={pickerOpen} onClose={() => (pickerOpen = false)} />
</QueryClientProvider>
