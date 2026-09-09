<script lang="ts">
  /**
   * /qc - the whole page.
   *
   * Nothing about the call is reimplemented. Once the identity and the
   * throwaway database are in place this hands over to ChatView, which is the
   * same component a room uses: it brings the message list, the composer, the
   * plugin slash commands and VoiceVideoCallView with it. A quick call is a
   * room nobody keeps, so it should look and work like one.
   */
  import { onDestroy, onMount } from "svelte";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { Check, Copy, LogIn, UserRound } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { Input } from "$lib/components/ui/input/index.js";
  import * as Card from "$lib/components/ui/card/index.js";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import UnlockIdentity from "$lib/components/UnlockIdentity.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { profileStore } from "$lib/profile.svelte";
  import { formatQuickCode } from "$lib/room-code";
  import {
    adoptAccount,
    chooseAccount,
    endQuickCall,
    hasAccount,
    prepareAsGuest,
    quickCall,
    quickCallLink,
    rememberQuickProfile,
    setQuickCallCode,
    startQuickCall,
    teardownQuickCall,
  } from "$lib/quick/quick-call.svelte";

  let name = $state(quickCall.profile.name);
  let remember = $state(quickCall.remembered);
  let pickerOpen = $state(false);
  let copied = $state(false);
  /** True when this page minted the code rather than following a link. */
  let isHost = $state(false);

  // The avatar picker writes straight through to the profile store, so that
  // is the live value once an identity exists; before it does, the remembered
  // one is all there is.
  const avatar = $derived(
    profileStore.avatarUrl ?? quickCall.profile.avatarUrl
  );
  const initial = $derived(name.trim().charAt(0).toUpperCase() || "?");
  const link = $derived(quickCall.code ? quickCallLink(quickCall.code) : "");

  // ChatView's GIF search is a svelte-query consumer and this page is not
  // inside AppView's provider. Without one it throws while mounting, which in
  // Svelte 5 leaves the PREVIOUS route on screen - the page simply does not
  // appear.
  const queryClient = new QueryClient();

  onMount(() => {
    const fromLink = window.location.hash.slice(1);
    isHost = !fromLink;
    setQuickCallCode(fromLink || undefined);
    // The code IS the secret, so it lives in the fragment and never in the
    // path - same reasoning as room invites, see App.svelte.
    if (isHost) {
      history.replaceState(history.state, "", `/qc#${quickCall.code}`);
    }
    // With no account on this device there is nothing to choose between.
    if (!hasAccount()) void prepareAsGuest();
    // pagehide, not beforeunload: it is the one that fires on mobile when the
    // tab is discarded, and dropping the database is the whole promise here.
    const bye = () => teardownQuickCall();
    window.addEventListener("pagehide", bye);
    return () => window.removeEventListener("pagehide", bye);
  });

  onDestroy(teardownQuickCall);

  // UnlockIdentity runs the whole unlock itself, remembered password and all,
  // so the only thing left here is to notice that it landed.
  $effect(() => {
    if (quickCall.stage !== "unlocking") return;
    if (!identityStore.isUnlocked) return;
    void adoptAccount();
  });

  // Take the name the account (or the remembered profile) turned out to have,
  // unless the person has already typed over it.
  let nameTouched = $state(false);
  $effect(() => {
    if (quickCall.stage !== "setup" || nameTouched) return;
    name = quickCall.profile.name;
  });

  async function join() {
    // Only a guest's name is worth remembering: an account already has one.
    rememberQuickProfile(
      remember && quickCall.identity === "guest"
        ? { name, avatarUrl: avatar }
        : null
    );
    await startQuickCall({ name, avatarUrl: avatar });
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
    <div class="min-h-dvh bg-background text-foreground font-mono flex">
      <div class="flex min-h-dvh min-w-0 flex-1 flex-col">
        <ChatView
          roomCode={quickCall.code}
          roomName="Quick call"
          selfId={identityStore.did ?? ""}
          onLeave={endQuickCall}
        />
      </div>
    </div>
  {:else if quickCall.stage === "unlocking"}
    <UnlockIdentity />
  {:else}
    <div
      class="min-h-dvh overflow-y-auto bg-background text-foreground flex items-center justify-center p-4 font-mono"
    >
      <Card.Root
        class="w-full max-w-sm bg-card border-border text-card-foreground"
      >
        <Card.Header class="pb-4">
          <div class="flex items-center gap-2 mb-1">
            <div class="w-2 h-2 rounded-full bg-primary"></div>
            <Card.Title class="text-lg font-mono font-semibold">
              Quick call
            </Card.Title>
          </div>
          <Card.Description class="text-muted-foreground text-xs font-mono">
            {#if quickCall.stage === "choosing"}
              No account needed · nothing is kept when you close the tab
            {:else if isHost}
              Send the link · nothing is kept when you close the tab
            {:else}
              You have been invited · nothing is kept when you close the tab
            {/if}
          </Card.Description>
        </Card.Header>

        {#if quickCall.stage === "choosing"}
          <Card.Content class="flex flex-col gap-2">
            <Button onclick={() => void prepareAsGuest()} class="w-full font-mono">
              <UserRound class="size-4" /> Join as a guest
            </Button>
            <Button
              variant="outline"
              onclick={chooseAccount}
              class="w-full font-mono"
            >
              <LogIn class="size-4" /> Use my account
            </Button>
            <p class="text-xs text-muted-foreground font-mono leading-relaxed">
              Either way the call is disposable: it never joins your saved
              rooms, and its chat goes when the tab does.
            </p>
          </Card.Content>
        {:else}
          <Card.Content class="flex flex-col items-center gap-4">
            <button
              type="button"
              onclick={() => (pickerOpen = true)}
              aria-label="Pick profile picture"
              class="relative group flex size-24 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer focus:outline-none focus:ring-primary"
            >
              {#if avatar}
                <img src={avatar} alt="" class="size-full object-cover" />
              {:else}
                <span
                  class="text-3xl font-semibold text-primary font-mono select-none"
                  >{initial}</span
                >
              {/if}
              <div
                class="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <span class="text-white text-xs font-mono">Change</span>
              </div>
            </button>

            <Input
              bind:value={name}
              oninput={() => (nameTouched = true)}
              maxlength={64}
              placeholder="Your display name"
              class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono text-center focus-visible:ring-ring"
            />

            {#if quickCall.identity === "account"}
              <p class="text-xs text-muted-foreground font-mono text-center">
                Calling as your account · the call itself is still disposable
              </p>
            {:else}
              <label
                class="flex items-start gap-2.5 cursor-pointer group self-start"
              >
                <input
                  type="checkbox"
                  bind:checked={remember}
                  class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer"
                />
                <span
                  class="text-xs text-muted-foreground group-hover:text-foreground transition-colors font-mono leading-relaxed"
                >
                  Remember this name and picture for next time
                </span>
              </label>
            {/if}

            {#if quickCall.stage === "failed"}
              <p class="text-xs text-destructive font-mono text-center">
                {quickCall.error ?? "Could not join the call."}
              </p>
            {/if}
          </Card.Content>

          <Card.Footer class="flex-col gap-3">
            <Button
              onclick={join}
              disabled={quickCall.stage === "joining"}
              class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
            >
              {quickCall.stage === "joining" ? "Joining..." : "Join call"}
            </Button>

            <div class="w-full space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <code class="text-sm font-mono tracking-wide text-foreground">
                  {formatQuickCode(quickCall.code)}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={copyLink}
                  class="font-mono text-xs"
                >
                  {#if copied}
                    <Check class="size-3.5" /> Copied
                  {:else}
                    <Copy class="size-3.5" /> Copy link
                  {/if}
                </Button>
              </div>
              <p class="text-xs text-muted-foreground font-mono leading-relaxed">
                Anyone with this link can join, so send it to the people you
                mean to talk to.
              </p>
            </div>
          </Card.Footer>
        {/if}
      </Card.Root>
    </div>
  {/if}

  <AvatarPickerDialog open={pickerOpen} onClose={() => (pickerOpen = false)} />
</QueryClientProvider>
