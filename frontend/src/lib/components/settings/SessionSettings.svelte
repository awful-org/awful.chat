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
  import { enroll, identityStore, removeWebAuthn } from "$lib/identity.svelte";

  interface Props {
    isMobile?: boolean;
    onClose?: () => void;
  }

  let { isMobile = false, onClose }: Props = $props();

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
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
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
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
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
          Use biometrics to unlock without password
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
            Biometric unlock enabled
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
          {biometricLoading ? "Please wait..." : "Enable biometric unlock"}
        </Button>
      {/if}
    </div>
  {/if}

  <!-- Sync Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-cyan-500 rounded-full"></div>
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Sync</Label
      >
    </div>
    <div class="grid grid-cols-2 gap-2">
      <Button
        variant="outline"
        class="font-mono flex-col h-auto py-3 gap-2"
        onclick={() => {
          if (isMobile) onClose?.();
        }}
      >
        <QrCode class="w-5 h-5" />
        <span class="text-xs">Generate QR</span>
      </Button>
      <Button
        variant="outline"
        class="font-mono flex-col h-auto py-3 gap-2"
        onclick={() => {
          if (isMobile) onClose?.();
        }}
      >
        <Camera class="w-5 h-5" />
        <span class="text-xs">Scan QR</span>
      </Button>
    </div>
  </div>
</div>
