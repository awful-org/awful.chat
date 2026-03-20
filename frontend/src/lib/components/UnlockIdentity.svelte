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

  interface Props {
    onRecover?: () => void;
  }
  let { onRecover }: Props = $props();

  const canUnlock = $derived(password.length > 0 && !identityStore.loading);
  const canUseBiometrics = $derived(
    identityStore.hasWebAuthn && !identityStore.loading
  );

  async function handleUnlock() {
    try {
      await unlock(password);
    } catch {
      password = "";
    }
  }

  async function handleBiometrics() {
    try {
      await unlockWithBiometrics();
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
