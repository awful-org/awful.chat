<script lang="ts">
  import {
    unlock,
    unlockWithBiometrics,
    identityStore,
  } from "$lib/identity.svelte";
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

  let password = $state("");
  let remember = $state(false);

  const REMEMBER_KEY = "awful_remembered_password";
  const DURATION_KEY = "awful_remember_duration";
  const ONE_DAY = 24 * 60 * 60 * 1000;

  function getRememberDuration(): number {
    const stored = localStorage.getItem(DURATION_KEY);
    if (stored) return parseInt(stored, 10);
    return 15;
  }

  function saveRememberedPassword(value: string, duration: number) {
    const expires = duration === -1 ? -1 : Date.now() + duration * ONE_DAY;
    localStorage.setItem(
      REMEMBER_KEY,
      JSON.stringify({ value, expires })
    );
  }

  function getRememberedPassword(): { value: string; expires: number } | null {
    const stored = localStorage.getItem(REMEMBER_KEY);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored);
      if (parsed.expires === -1 || Date.now() < parsed.expires) return parsed;
      localStorage.removeItem(REMEMBER_KEY);
    } catch {
      localStorage.removeItem(REMEMBER_KEY);
    }
    return null;
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
    if (!identityStore.isUnlocked && !identityStore.loading && !identityStore.error) {
      const stored = getRememberedPassword();
      if (stored) {
        password = stored.value;
        remember = true;
        if (!canUseBiometrics) {
          unlock(stored.value)
            .then(() => {
              const resetTimer = localStorage.getItem("awful_remember_reset_timer") === "true";
              if (resetTimer) {
                saveRememberedPassword(stored.value, getRememberDuration());
              }
            })
            .catch(() => {
              password = "";
              remember = false;
            });
        }
      }
    }
  });

  async function handleUnlock() {
    try {
      const duration = remember ? getRememberDuration() : 0;
      await unlock(password);
      if (duration > 0) {
        saveRememberedPassword(password, duration);
      } else {
        localStorage.removeItem(REMEMBER_KEY);
      }
    } catch {
      password = "";
    }
  }

  async function handleBiometrics() {
    try {
      await unlockWithBiometrics();
      const resetTimer = localStorage.getItem("awful_remember_reset_timer") === "true";
      if (resetTimer) {
        const stored = getRememberedPassword();
        if (stored) {
          saveRememberedPassword(stored.value, getRememberDuration());
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

<div
  class="min-h-screen bg-background text-foreground flex items-center justify-center p-4 font-mono"
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
            {identityStore.keypair.did.slice(0, 24)}…
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
          {identityStore.loading ? "Unlocking…" : "Use biometrics / device PIN"}
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

      <label class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer">
        <input
          type="checkbox"
          bind:checked={remember}
          class="accent-primary"
        />
        Remember my password
      </label>
    </CardContent>

    <CardFooter class="flex flex-col gap-2">
      <Button
        onclick={handleUnlock}
        disabled={!canUnlock}
        class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono disabled:opacity-40"
      >
        {identityStore.loading ? "Unlocking…" : "Unlock"}
      </Button>
      <Button variant="outline" class="w-full font-mono" onclick={onRecover}>
        Restore from phrase
      </Button>
    </CardFooter>
  </Card>
</div>
