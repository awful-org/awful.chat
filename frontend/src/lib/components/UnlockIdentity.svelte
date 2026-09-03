<script lang="ts">
  import {
    unlock,
    unlockWithBiometrics,
    identityStore,
    startAutoLogin,
  } from "$lib/identity/identity.svelte";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import {
    saveRememberedPassword,
    loadRememberedPassword,
    clearRememberedPassword,
  } from "$lib/identity/remembered-password";
  import { wipeLocalDatabase, deleteWebAuthnRecord } from "$lib/storage";

  let password = $state("");
  let remember = $state(false);
  // Set once the user starts typing, so a slow remembered-password lookup
  // can't clobber what they're entering.
  let userEdited = $state(false);
  let confirmSwitch = $state(false);
  let switching = $state(false);

  /**
   * Swap to another account. A device holds exactly one identity, so this
   * clears the local database and drops back to the setup screen where the
   * user can create, restore or sync one.
   */
  async function handleSwitchAccount() {
    switching = true;
    try {
      await clearRememberedPassword().catch(() => {});
      await deleteWebAuthnRecord().catch(() => {});
      await wipeLocalDatabase();
      window.location.reload();
    } catch (e) {
      switching = false;
      identityStore.error = e instanceof Error ? e.message : String(e);
    }
  }

  const DURATION_KEY = "awful_remember_duration";

  function getRememberDuration(): number {
    const stored = localStorage.getItem(DURATION_KEY);
    if (stored) return parseInt(stored, 10);
    return 15;
  }

  interface Props {
    onRecover?: () => void;
  }
  let { onRecover }: Props = $props();

  const canUnlock = $derived(password.length > 0 && !identityStore.loading);
  const canUseBiometrics = $derived(
    identityStore.hasWebAuthn && !identityStore.loading
  );

  $effect(() => {
    // Do not sign the user back in right after they asked to log out.
    if (identityStore.justLoggedOut) return;
    if (
      !identityStore.isUnlocked &&
      !identityStore.loading &&
      !identityStore.error
    ) {
      loadRememberedPassword().then((stored) => {
        if (!stored || userEdited || password) return;
        password = stored;
        remember = true;
        if (canUseBiometrics) {
          return;
        }
        startAutoLogin(
          unlock(stored)
            .then(() => {
              const resetTimer =
                localStorage.getItem("awful_remember_reset_timer") === "true";
              if (resetTimer) {
                return saveRememberedPassword(stored, getRememberDuration());
              }
            })
            .catch(() => {})
        );
      });
    }
  });

  async function handleUnlock() {
    try {
      identityStore.justLoggedOut = false;
      await unlock(password);
      if (remember) {
        // getRememberDuration() may be -1 ("until logout") - a valid choice
        // that saveRememberedPassword now handles, not a reason to clear.
        await saveRememberedPassword(password, getRememberDuration());
      } else {
        await clearRememberedPassword();
      }
    } catch {
      password = "";
    }
  }

  async function handleBiometrics() {
    try {
      identityStore.justLoggedOut = false;
      await unlockWithBiometrics();
      const resetTimer =
        localStorage.getItem("awful_remember_reset_timer") === "true";
      if (resetTimer) {
        const stored = await loadRememberedPassword();
        if (stored) {
          await saveRememberedPassword(stored, getRememberDuration());
        }
      }
    } catch {
      // error already in identityStore.error
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && canUnlock) handleUnlock();
  }
</script>

<!-- viewportHeight, not just a dvh class: every one of these screens centres a
     card with a text field in it, and dvh does not shrink when the software
     keyboard opens - so on a phone the field being typed into ended up under
     the keyboard. overflow-y-auto because the box is now exactly the visible
     height and a tall card has to be able to scroll inside it. -->
<div
  use:viewportHeight
  class="min-h-dvh overflow-y-auto bg-background text-foreground flex items-center justify-center p-4 font-mono"
>
  <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
    <CardHeader class="pb-4">
      <div class="flex items-center gap-2 mb-1">
        <div class="w-2 h-2 rounded-full bg-muted-foreground"></div>
        <span class="text-xs text-muted-foreground tracking-widest"
          >Awful.chat</span
        >
      </div>
      <CardTitle class="text-lg font-mono font-semibold">Welcome back</CardTitle
      >
      <CardDescription class="text-muted-foreground text-xs font-mono">
        Enter your password to unlock your identity
        {#if identityStore.keypair?.did}
          <span class="block mt-1 text-muted-foreground/60 truncate">
            {identityStore.keypair.did.slice(0, 24)}...
          </span>
        {/if}
      </CardDescription>
    </CardHeader>

    <CardContent class="flex flex-col gap-3">
      {#if canUseBiometrics}
        <Button
          onclick={handleBiometrics}
          disabled={identityStore.loading}
          variant="outline"
          class="w-full font-mono border-dashed"
        >
          {identityStore.loading ? "Unlocking..." : "Use biometrics / device PIN"}
        </Button>
        <div class="flex items-center gap-2 text-muted-foreground/40">
          <div class="flex-1 h-px bg-border"></div>
          <span class="text-xs">or</span>
          <div class="flex-1 h-px bg-border"></div>
        </div>
      {/if}

      <Input
        type="password"
        bind:value={password}
        oninput={() => (userEdited = true)}
        onkeydown={onKeydown}
        placeholder="password"
        autofocus={!canUseBiometrics}
        class="bg-background border-input font-mono focus-visible:ring-ring
          {identityStore.error
          ? 'border-destructive focus-visible:ring-destructive'
          : ''}"
      />

      {#if identityStore.error}
        <p class="text-xs text-destructive font-mono">{identityStore.error}</p>
      {/if}

      <label
        class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer"
      >
        <input type="checkbox" bind:checked={remember} class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer" />
        Remember my password
      </label>
    </CardContent>

    <CardFooter class="flex flex-col gap-2">
      <Button
        onclick={handleUnlock}
        disabled={!canUnlock}
        class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono disabled:opacity-40"
      >
        {identityStore.loading ? "Unlocking..." : "Unlock"}
      </Button>
      <Button variant="outline" class="w-full font-mono" onclick={onRecover}>
        Restore from phrase
      </Button>

      {#if !confirmSwitch}
        <button
          type="button"
          onclick={() => (confirmSwitch = true)}
          class="mt-1 text-xs text-muted-foreground hover:text-foreground font-mono transition-colors"
        >
          Use a different account
        </button>
      {:else}
        <div
          class="mt-1 w-full flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
        >
          <p
            class="text-xs font-mono text-muted-foreground leading-relaxed text-left"
          >
            Only one account lives on a device at a time. Switching erases this
            one from here: its messages, rooms and files go with it, and without
            the 12 word phrase it cannot be recovered.
          </p>
          <div class="flex gap-2">
            <Button
              variant="outline"
              class="flex-1 font-mono text-xs"
              onclick={() => (confirmSwitch = false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              class="flex-1 font-mono text-xs"
              disabled={switching}
              onclick={handleSwitchAccount}
            >
              {switching ? "Erasing..." : "Erase and switch"}
            </Button>
          </div>
        </div>
      {/if}
    </CardFooter>
  </Card>
</div>
