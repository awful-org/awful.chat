<script lang="ts">
  import { restore, identityStore } from "$lib/identity/identity.svelte";
  import { createIdentity } from "$lib/identity/identity";
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
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import { profileStore, loadProfile, saveName } from "$lib/profile.svelte";
  import type { KeypairRecord } from "$lib/identity/identity";
  import { enroll } from "$lib/identity/identity.svelte";
  import { ArrowLeft, Smartphone, Info } from "@lucide/svelte";
  import { saveRememberedPassword } from "$lib/identity/remembered-password";
  import { requestPersistentStorage } from "$lib/storage";
  import DeviceSyncDialog from "$lib/components/DeviceSyncDialog.svelte";
  import QuirksNotice from "$lib/components/QuirksNotice.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";

  type Step =
    | "entry"
    | "create-password"
    | "mnemonic"
    | "profile"
    | "biometric"
    | "restore";

  interface Props {
    initialStep?: Step;
    onCancelToUnlock?: () => void;
  }

  let { initialStep = "entry", onCancelToUnlock }: Props = $props();

  let step = $state<Step>("entry");
  let _stepInitialized = $state(false);

  let password = $state("");
  let passwordConfirm = $state("");
  let mnemonic = $state<string | null>(null);
  let pendingKeypair = $state<KeypairRecord | null>(null);
  let mnemonicConfirmed = $state(false);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let avatarDialogOpen = $state(false);

  let restoreMnemonic = $state("");
  let restorePassword = $state("");
  let restorePasswordConfirm = $state("");

  let syncDialogOpen = $state(false);

  // First-run "how this app behaves" notice. Shown before any credential step,
  // once per browser; always reachable again from Settings > Quirks.
  const QUIRKS_SEEN_KEY = "awful:quirks-seen:v1";
  let quirksOpen = $state(false);
  // Only a real open -> close counts as "seen". The dialog primitive can emit
  // onOpenChange(false) while mounting, and persisting on that would silently
  // burn the notice for someone who merely reloaded the page.
  let quirksWasOpened = false;

  function openQuirks(): void {
    quirksWasOpened = true;
    quirksOpen = true;
  }

  function markQuirksSeen(): void {
    if (!quirksWasOpened) return;
    try {
      localStorage.setItem(QUIRKS_SEEN_KEY, "1");
    } catch {}
  }

  $effect(() => {
    if (step !== "entry") return;
    let seen = false;
    try {
      seen = localStorage.getItem(QUIRKS_SEEN_KEY) === "1";
    } catch {}
    if (!seen) openQuirks();
  });

  let createdPassword = $state(""); // hold password through steps for enrollment
  let biometricLoading = $state(false);
  let biometricError = $state<string | null>(null);
  let remember = $state(true);

  const DURATION_KEY = "awful_remember_duration";

  function getRememberDuration(): number {
    const stored = localStorage.getItem(DURATION_KEY);
    if (stored) return parseInt(stored, 10);
    return 15;
  }

  const passwordMismatch = $derived(
    passwordConfirm.length > 0 && password !== passwordConfirm
  );
  const canCreate = $derived(
    password.length >= 8 && password === passwordConfirm && !loading
  );

  const restorePasswordMismatch = $derived(
    restorePasswordConfirm.length > 0 &&
      restorePassword !== restorePasswordConfirm
  );
  const canRestore = $derived(
    restoreMnemonic.trim().split(/\s+/).length === 12 &&
      restorePassword.length >= 8 &&
      restorePassword === restorePasswordConfirm &&
      !identityStore.loading
  );

  const mnemonicWords = $derived(mnemonic ? mnemonic.split(" ") : []);

  async function handleCreate() {
    loading = true;
    error = null;
    try {
      const result = await createIdentity(password);
      mnemonic = result.mnemonic;
      pendingKeypair = result.keypair;
      createdPassword = password; // keep for biometric enrollment
      password = "";
      passwordConfirm = "";
      step = "mnemonic";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  function handleConfirmed() {
    if (!pendingKeypair || !mnemonicConfirmed) return;
    step = "profile";
  }

  function handleFinish() {
    // The profile row is keyed by did, and identityStore.did is not set until
    // finalizeSession(), so pass it explicitly - otherwise the row lands under
    // an empty key and the name looks like it was never saved.
    saveName(profileStore.nickname, pendingKeypair?.did).catch(() => {});
    if (
      identityStore.webAuthnCapabilities?.supported &&
      identityStore.webAuthnCapabilities?.canEnroll
    ) {
      step = "biometric";
    } else {
      finalizeSession();
    }
  }

  async function finalizeSession() {
    if (!pendingKeypair) return;
    // New identity: nothing is stored anywhere else, so ask for persistence.
    requestPersistentStorage().catch(() => {});
    identityStore.isUnlocked = true;
    identityStore.did = pendingKeypair.did;
    identityStore.publicKey = pendingKeypair.publicKey;
    identityStore.keypair = pendingKeypair;
    identityStore.error = null;
    if (remember) {
      saveRememberedPassword(createdPassword, getRememberDuration());
    }
    createdPassword = "";
    mnemonic = null;
  }

  async function handleRestore() {
    await restore(restoreMnemonic.trim(), restorePassword);
    if (remember) {
      saveRememberedPassword(restorePassword, getRememberDuration());
    }
  }

  function copyMnemonic() {
    if (mnemonic) navigator.clipboard.writeText(mnemonic);
  }

  $effect(() => {
    if (step === "profile") loadProfile();
  });

  const profileInitial = $derived(
    (profileStore.nickname || "?").charAt(0).toUpperCase()
  );

  $effect(() => {
    if (_stepInitialized) return;
    step = initialStep;
    _stepInitialized = true;
  });
</script>

<div
  class="min-h-screen bg-background text-foreground flex items-center justify-center p-4 font-mono"
>
  {#if step === "entry"}
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <div class="flex items-center gap-2 mb-1">
          <div class="w-2 h-2 rounded-full bg-muted-foreground"></div>
          <span class="text-xs text-muted-foreground tracking-widest"
            >Awful.chat</span
          >
        </div>
        <CardTitle class="text-lg font-mono font-semibold">
          No identity found
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          Create a new identity, restore from a recovery phrase, or sync from
          another device
        </CardDescription>
      </CardHeader>
      <CardFooter class="flex flex-col gap-2 pt-0">
        <Button
          onclick={() => (step = "create-password")}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        >
          Create new identity
        </Button>
        <Button
          onclick={() => (step = "restore")}
          variant="outline"
          class="w-full font-mono"
        >
          Restore from phrase
        </Button>
        <Button
          onclick={() => {
            syncDialogOpen = true;
          }}
          variant="outline"
          class="w-full font-mono"
        >
          <Smartphone class="w-4 h-4 mr-2" />
          Sync from another device
        </Button>
        <button
          type="button"
          onclick={openQuirks}
          class="mt-1 inline-flex items-center gap-1.5 text-xs leading-none text-muted-foreground hover:text-foreground font-mono transition-colors"
        >
          <Info class="size-3.5 shrink-0" />
          <span class="leading-none">How this app works</span>
        </button>
      </CardFooter>
    </Card>
  {:else if step === "create-password"}
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <button
          onclick={() => {
            step = "entry";
            password = "";
            passwordConfirm = "";
          }}
          class="text-muted-foreground hover:text-foreground font-mono mb-2 text-left transition-colors"
        >
          <ArrowLeft class="size-4" />
        </button>
        <CardTitle class="text-lg font-mono font-semibold">
          Choose a password
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          Encrypts your recovery phrase on this device - min 8 characters
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <Input
          type="password"
          bind:value={password}
          placeholder="password"
          onkeydown={(e) => {
            if (e.key === "Enter" && canCreate) handleCreate();
          }}
          class="bg-background border-input font-mono focus-visible:ring-ring"
        />
        <div class="flex flex-col gap-1">
          <Input
            type="password"
            bind:value={passwordConfirm}
            placeholder="confirm password"
            onkeydown={(e) => {
              if (e.key === "Enter" && canCreate) handleCreate();
            }}
            class="bg-background border-input font-mono focus-visible:ring-ring
						{passwordMismatch ? 'border-destructive focus-visible:ring-destructive' : ''}"
          />
          {#if passwordMismatch}
            <p class="text-xs text-destructive font-mono">
              Passwords do not match
            </p>
          {/if}
        </div>
        {#if error}
          <p class="text-xs text-destructive font-mono">{error}</p>
        {/if}

        <label
          class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer"
        >
          <input
            type="checkbox"
            bind:checked={remember}
            class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer"
          />
          Remember my password
        </label>
      </CardContent>
      <CardFooter>
        <Button
          onclick={handleCreate}
          disabled={!canCreate}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono disabled:opacity-40"
        >
          {loading ? "Creating..." : "Create identity"}
        </Button>
      </CardFooter>
    </Card>
  {:else if step === "mnemonic"}
    <Card class="w-full max-w-md bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <CardTitle class="text-lg font-mono font-semibold">
          Write down your recovery phrase
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          These 12 words are the only way to recover your identity · store them
          somewhere safe · they will not be shown again
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col gap-4">
        <div class="grid grid-cols-3 gap-2">
          {#each mnemonicWords as word, i}
            <div
              class="flex items-center gap-1.5 bg-background border border-border rounded px-2 py-1.5"
            >
              <span
                class="text-muted-foreground text-xs w-4 text-right shrink-0"
                >{i + 1}</span
              >
              <span class="text-foreground text-sm font-mono">{word}</span>
            </div>
          {/each}
        </div>

        <Button
          onclick={copyMnemonic}
          variant="outline"
          size="sm"
          class="font-mono text-xs"
        >
          Copy to clipboard
        </Button>

        <label class="flex items-start gap-2.5 cursor-pointer group">
          <input
            type="checkbox"
            bind:checked={mnemonicConfirmed}
            class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer"
          />
          <span
            class="text-xs text-muted-foreground group-hover:text-foreground transition-colors font-mono leading-relaxed"
          >
            I have written down my recovery phrase and stored it safely
          </span>
        </label>
      </CardContent>
      <CardFooter>
        <Button
          onclick={handleConfirmed}
          disabled={!mnemonicConfirmed}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono disabled:opacity-40"
        >
          I'm ready
        </Button>
      </CardFooter>
    </Card>
  {:else if step === "profile"}
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <CardTitle class="text-lg font-mono font-semibold">
          Set your profile
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          Optional · you can change this any time from the sidebar
        </CardDescription>
      </CardHeader>
      <CardContent class="flex flex-col items-center gap-4">
        <button
          type="button"
          onclick={() => {
            avatarDialogOpen = true;
          }}
          aria-label="Pick profile picture"
          class="relative group flex size-24 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer focus:outline-none focus:ring-primary"
        >
          {#if profileStore.avatarUrl}
            <img
              src={profileStore.avatarUrl}
              alt="Avatar preview"
              class="size-full object-cover"
            />
          {:else}
            <span
              class="text-3xl font-semibold text-primary font-mono select-none"
              >{profileInitial}</span
            >
          {/if}
          <div
            class="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <span class="text-white text-xs font-mono">Change</span>
          </div>
        </button>
        <p class="text-xs text-muted-foreground font-mono text-center">
          Click to upload, pick a GIF, or enter an image URL
        </p>
        <Input
          value={profileStore.nickname}
          oninput={(e) => {
            profileStore.nickname = (e.target as HTMLInputElement).value;
          }}
          onkeydown={(e) => {
            if (e.key === "Enter") handleFinish();
          }}
          placeholder="Your display name"
          class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono text-center focus-visible:ring-ring"
        />
      </CardContent>
      <CardFooter>
        <Button
          onclick={handleFinish}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        >
          {profileStore.nickname.trim() || profileStore.avatarUrl
            ? "Done"
            : "Skip for now"}
        </Button>
      </CardFooter>
    </Card>
    <AvatarPickerDialog
      open={avatarDialogOpen}
      onClose={() => {
        avatarDialogOpen = false;
      }}
    />
  {:else if step === "biometric"}
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <CardTitle class="text-lg font-mono font-semibold">
          Enable biometric unlock?
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          Use your device fingerprint, face, or PIN to unlock without typing
          your password. You can enable this later in Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {#if biometricError}
          <p class="text-xs text-destructive font-mono">{biometricError}</p>
        {/if}
      </CardContent>
      <CardFooter class="flex flex-col gap-2">
        <Button
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
          disabled={biometricLoading}
          onclick={async () => {
            biometricError = null;
            biometricLoading = true;
            try {
              await enroll(createdPassword);
              await finalizeSession();
            } catch (e) {
              biometricError = e instanceof Error ? e.message : String(e);
              biometricLoading = false;
            }
          }}
        >
          {biometricLoading ? "Waiting for device..." : "Enable biometric unlock"}
        </Button>
        <Button
          variant="outline"
          class="w-full font-mono"
          onclick={finalizeSession}
        >
          Skip for now
        </Button>
      </CardFooter>
    </Card>
  {:else if step === "restore"}
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader class="pb-4">
        <button
          onclick={() => {
            if (onCancelToUnlock) {
              onCancelToUnlock();
            } else {
              step = "entry";
              restoreMnemonic = "";
              restorePassword = "";
              restorePasswordConfirm = "";
            }
          }}
          class="text-muted-foreground hover:text-foreground font-mono mb-2 text-left transition-colors"
        >
          <ArrowLeft class="size-4" />
        </button>
        <CardTitle class="text-lg font-mono font-semibold">
          Restore identity
        </CardTitle>
        <CardDescription class="text-muted-foreground text-xs font-mono">
          Enter your 12-word recovery phrase and choose a new password
        </CardDescription>
        <p
          class="text-muted-foreground text-xs font-mono leading-relaxed mt-2"
        >
          This brings back who you are, not what you have. Your rooms and
          messages live only on the device that already has them, so this
          browser starts empty. To carry them over, use
          <button
            type="button"
            onclick={() => {
              syncDialogOpen = true;
            }}
            class="underline underline-offset-2 hover:text-foreground transition-colors"
            >sync from another device</button
          > on the device that has your history.
        </p>
      </CardHeader>
      <CardContent class="flex flex-col gap-3">
        <textarea
          bind:value={restoreMnemonic}
          placeholder="word1 word2 word3 ..."
          rows={3}
          class="w-full bg-background border border-input rounded-md px-3 py-2 text-foreground placeholder:text-muted-foreground font-mono text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        ></textarea>
        <Input
          type="password"
          bind:value={restorePassword}
          placeholder="new password"
          onkeydown={(e) => {
            if (e.key === "Enter" && canRestore) handleRestore();
          }}
          class="bg-background border-input font-mono focus-visible:ring-ring"
        />
        <div class="flex flex-col gap-1">
          <Input
            type="password"
            bind:value={restorePasswordConfirm}
            placeholder="confirm password"
            onkeydown={(e) => {
              if (e.key === "Enter" && canRestore) handleRestore();
            }}
            class="bg-background border-input font-mono focus-visible:ring-ring
						{restorePasswordMismatch
              ? 'border-destructive focus-visible:ring-destructive'
              : ''}"
          />
          {#if restorePasswordMismatch}
            <p class="text-xs text-destructive font-mono">
              Passwords do not match
            </p>
          {/if}
        </div>
        {#if identityStore.error}
          <p class="text-xs text-destructive font-mono">
            {identityStore.error}
          </p>
        {/if}

        <label
          class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer"
        >
          <input
            type="checkbox"
            bind:checked={remember}
            class="mt-0.5 w-4 h-4 rounded border-input bg-background accent-primary cursor-pointer"
          />
          Remember my password
        </label>
      </CardContent>
      <CardFooter>
        <Button
          onclick={handleRestore}
          disabled={!canRestore}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono disabled:opacity-40"
        >
          {identityStore.loading ? "Restoring..." : "Restore identity"}
        </Button>
      </CardFooter>
    </Card>
  {/if}

  <Dialog
    bind:open={quirksOpen}
    onOpenChange={(v: boolean) => {
      if (!v) markQuirksSeen();
    }}
  >
    <DialogContent
      class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-lg flex flex-col max-h-[85vh] p-0"
    >
      <DialogHeader class="px-5 pt-5 pb-3 border-b border-border shrink-0">
        <DialogTitle class="font-mono text-base font-semibold">
          Read this first
        </DialogTitle>
        <DialogDescription
          class="text-muted-foreground text-xs font-mono leading-relaxed"
        >
          Awful.chat is peer-to-peer: there are no accounts on a server and no
          copy of your data anywhere but your own devices. That buys you
          privacy, and it makes a few things behave differently from apps like
          WhatsApp or Discord.
        </DialogDescription>
      </DialogHeader>
      <div class="overflow-y-auto px-5 py-4 min-h-0">
        <QuirksNotice />
      </div>
      <DialogFooter class="px-5 pb-5 pt-3 border-t border-border shrink-0">
        <Button
          onclick={() => {
            markQuirksSeen();
            quirksOpen = false;
          }}
          class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        >
          Got it
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DeviceSyncDialog
    bind:open={syncDialogOpen}
    onClose={() => {
      syncDialogOpen = false;
    }}
    onComplete={() => {
      // Reload to unlock the synced identity
      window.location.reload();
    }}
    flowMode="receive"
  />
</div>
