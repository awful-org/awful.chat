<script lang="ts">
import { Label } from "$lib/components/ui/label";
import { Input } from "$lib/components/ui/input";
import { Button } from "$lib/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "$lib/components/ui/select";
import { Switch } from "$lib/components/ui/switch";
import { QrCode, Camera } from "@lucide/svelte";
import {
  enroll,
  identityStore,
  removeWebAuthn,
} from "$lib/identity/identity.svelte";
import { unlockIdentity } from "$lib/identity/identity";
import {
  clearDuressPassword,
  hasDuressPassword,
  setDuressPassword,
} from "$lib/duress";
import {
  mailboxPrefs,
  setMailboxEnabled,
} from "$lib/transport/mailbox.svelte";

interface Props {
  isMobile?: boolean;
  onClose?: () => void;
  // Opening the sync dialog is delegated UP to a component that outlives the
  // settings dialog - otherwise closing settings (on mobile) unmounts the sync
  // dialog the same instant it opens.
  onOpenSync?: (mode: "generate-qr" | "scan-qr") => void;
}

let { isMobile = false, onClose, onOpenSync }: Props = $props();

  let rememberDuration = $state(
    parseInt(localStorage.getItem("awful_remember_duration") ?? "15", 10)
  );
  let rememberResetTimer = $state(
    localStorage.getItem("awful_remember_reset_timer") === "true"
  );

  let biometricPassword = $state("");
  let biometricLoading = $state(false);
  let biometricError = $state<string | null>(null);
  let biometricSuccess = $state(false);
  let confirmRemoveBiometric = $state(false);

  let duressEnabled = $state(false);
  // Async: telling an armed record from its decoy needs the session's key.
  $effect(() => {
    void hasDuressPassword().then((armed) => (duressEnabled = armed));
  });
  let duressPassword = $state("");
  let duressError = $state<string | null>(null);
  let duressLoading = $state(false);

  async function saveDuress() {
    duressError = null;
    duressLoading = true;
    try {
      // The duress password must differ from the real one, or the user
      // wipes their device on a normal unlock. The only way to know is to
      // try it against the mnemonic: success means "same password", reject.
      let matchesReal = false;
      try {
        await unlockIdentity(duressPassword);
        matchesReal = true; // re-unlocked with the same identity: harmless
      } catch {
        matchesReal = false;
      }
      if (matchesReal) {
        duressError = "That is your unlock password - pick a different one.";
        return;
      }
      if (duressPassword.length < 4) {
        duressError = "Too short - it has to survive being typed under stress.";
        return;
      }
      await setDuressPassword(duressPassword);
      duressPassword = "";
      duressEnabled = true;
    } finally {
      duressLoading = false;
    }
  }

  const canEnrollBiometrics = $derived(
    !identityStore.hasWebAuthn &&
      (identityStore.webAuthnCapabilities?.canEnroll ?? false)
  );
</script>

<div class="flex flex-col gap-6">
  <!-- Session Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-yellow-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Session</Label
      >
    </div>
    <Select
      type="single"
      value={rememberDuration.toString()}
      onValueChange={(v: string) => {
        const val = parseInt(v, 10);
        rememberDuration = val;
        localStorage.setItem("awful_remember_duration", v);
      }}
    >
      <SelectTrigger class="w-full font-mono">
        <span class="text-xs">
          {rememberDuration === -1
            ? "Until I log out"
            : `${rememberDuration} days`}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="5">5 days</SelectItem>
        <SelectItem value="15">15 days</SelectItem>
        <SelectItem value="30">30 days</SelectItem>
        <SelectItem value="60">60 days</SelectItem>
        <SelectItem value="-1">Until I log out</SelectItem>
      </SelectContent>
    </Select>

    <div class="flex items-center gap-4">
      <Switch
        bind:checked={rememberResetTimer}
        onCheckedChange={(checked) => {
          rememberResetTimer = checked;
          localStorage.setItem("awful_remember_reset_timer", String(checked));
        }}
      />
      <span class="text-xs text-muted-foreground font-mono"
        >Reset timer on login</span
      >
    </div>
  </div>

  <!-- Security Section -->
  {#if canEnrollBiometrics || identityStore.hasWebAuthn}
    <div
      class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
    >
      <div class="flex items-center gap-2">
        <div class="w-1 h-4 bg-red-500 rounded-full"></div>
        <Label
          class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Security</Label
        >
      </div>

      {#if identityStore.hasWebAuthn}
        <p class="text-xs text-muted-foreground font-mono">
          Biometric unlock is enabled
        </p>
        {#if !confirmRemoveBiometric}
          <Button
            variant="outline"
            class="w-full font-mono text-xs"
            onclick={() => (confirmRemoveBiometric = true)}
          >
            Remove biometric
          </Button>
        {:else}
          <div class="flex gap-2">
            <Button
              variant="outline"
              class="flex-1 font-mono text-xs"
              onclick={() => (confirmRemoveBiometric = false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              class="flex-1 font-mono text-xs"
              onclick={async () => {
                await removeWebAuthn();
                confirmRemoveBiometric = false;
              }}
            >
              Remove
            </Button>
          </div>
        {/if}
      {:else}
        <p class="text-xs text-muted-foreground font-mono">
          Use a fingerprint or a security key (YubiKey) to unlock without
          your password.
        </p>
        <Input
          type="password"
          bind:value={biometricPassword}
          placeholder="Password to enroll"
          class="bg-background border-input font-mono focus-visible:ring-ring text-sm {biometricError
            ? 'border-destructive'
            : ''}"
        />
        {#if biometricError}
          <p class="text-xs text-destructive font-mono">{biometricError}</p>
        {/if}
        {#if biometricSuccess}
          <p class="text-xs text-green-500 font-mono">
            Biometric unlock is enabled
          </p>
        {/if}
        <Button
          variant="outline"
          class="w-full font-mono text-xs"
          disabled={biometricPassword.length === 0 || biometricLoading}
          onclick={async () => {
            biometricError = null;
            biometricSuccess = false;
            biometricLoading = true;
            try {
              await enroll(biometricPassword);
              biometricPassword = "";
              biometricSuccess = true;
            } catch (e) {
              biometricError = e instanceof Error ? e.message : String(e);
            } finally {
              biometricLoading = false;
            }
          }}
        >
          {biometricLoading ? "Waiting for device..." : "Enable biometric unlock"}
        </Button>
      {/if}
    </div>
  {/if}

<!-- Offline inbox Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-violet-500 rounded-full"></div>
    <Label
      class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Offline inbox</Label
    >
  </div>
  <div class="flex items-start justify-between gap-3">
    <p class="text-xs text-muted-foreground font-mono">
      When a DM can't reach an offline contact, leave an encrypted copy at
      the relay for up to 48 hours - they collect it next time they open the
      app, no need to be online together. The relay only ever sees
      ciphertext and delivery times, never content or who sent it. On by
      default; turned off, DMs queue until you are both online together.
    </p>
    <Switch
      checked={mailboxPrefs.enabled}
      onCheckedChange={(on) => setMailboxEnabled(on)}
    />
  </div>
</div>

<!-- Duress Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-orange-500 rounded-full"></div>
    <Label
      class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Duress password</Label
    >
  </div>
  <p class="text-xs text-muted-foreground font-mono">
    Entering this password at the unlock screen instead of your real one
    silently and permanently erases this device's data - messages, files,
    identity - and shows the fresh-install screen. Your account survives on
    other devices and through your recovery phrase. Setting it clears any
    remembered password on this device (auto-unlock would skip the screen
    where you would type it).
  </p>
  {#if duressEnabled}
    <p class="text-xs text-green-500 font-mono">A duress password is set</p>
    <Button
      variant="outline"
      class="w-full font-mono text-xs"
      onclick={() => {
        clearDuressPassword();
        duressEnabled = false;
      }}
    >
      Remove duress password
    </Button>
  {:else}
    <Input
      type="password"
      bind:value={duressPassword}
      placeholder="Duress password"
      class="bg-background border-input font-mono focus-visible:ring-ring text-sm {duressError
        ? 'border-destructive'
        : ''}"
    />
    {#if duressError}
      <p class="text-xs text-destructive font-mono">{duressError}</p>
    {/if}
    <Button
      variant="outline"
      class="w-full font-mono text-xs"
      disabled={duressPassword.length === 0 || duressLoading}
      onclick={saveDuress}
    >
      {duressLoading ? "Setting..." : "Set duress password"}
    </Button>
  {/if}
</div>

<!-- Sync Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-cyan-500 rounded-full"></div>
    <Label
      class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Sync</Label
    >
  </div>
  <div class="grid grid-cols-2 gap-2">
    <Button
      variant="outline"
      class="font-mono flex-col h-auto py-3 gap-2"
      onclick={() => {
        onOpenSync?.("generate-qr");
        if (isMobile) onClose?.();
      }}
    >
      <QrCode class="w-5 h-5" />
      <span class="text-xs">Generate QR code</span>
    </Button>
    <Button
      variant="outline"
      class="font-mono flex-col h-auto py-3 gap-2"
      onclick={() => {
        onOpenSync?.("scan-qr");
        if (isMobile) onClose?.();
      }}
    >
      <Camera class="w-5 h-5" />
      <span class="text-xs">Scan QR code</span>
    </Button>
  </div>
</div>
</div>
