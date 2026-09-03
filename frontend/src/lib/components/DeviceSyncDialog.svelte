<script lang="ts">
import { tick } from "svelte";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    syncState,
    generateSyncCode,
    connectAsTarget,
    parsePlaintextToken,
    revealShortCode,
    startScanning,
    scannerState,
    switchScanCamera,
    nextScanCameraId,
    toggleScanTorch,
    cancelSync,
    type SyncPayload,
  } from "$lib/transport/sync.svelte";
  import {
    Copy,
    Camera,
    Keyboard,
    Check,
    CircleAlert,
    RefreshCw,
    SwitchCamera,
    Flashlight,
    FlashlightOff,
  } from "@lucide/svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
    onComplete?: () => void;
    flowMode?: "receive" | "generate-qr" | "scan-qr";
  }

  let {
    open = $bindable(),
    onClose,
    onComplete,
    flowMode = "receive",
  }: Props = $props();

  let view = $state<
    | "select"
    | "qr-display"
    | "scan"
    | "manual-input"
    | "mode-select"
    | "password"
    | "progress"
    | "complete"
    | "error"
  >("select");
  let manualToken = $state("");
  let scannerElementId = $state(
    `qr-scanner-${crypto.randomUUID().slice(0, 8)}`
  );
  let scanPermission = $state<boolean | null>(null);
  let syncMode = $state<"add" | "replace">("add");
  let startScanPromise: Promise<void> | null = null;

  // Auto-set initial view based on flowMode
  $effect(() => {
    if (open && view === "select") {
      if (flowMode === "generate-qr") {
        handleGenerateCode();
      }
    }
  });

  // The typed short code carries only the first 8 chars of the sync token, so
  // the source stops honouring the full 128-bit one the moment it is shown -
  // keep it behind a deliberate tap instead of printing it next to every QR.
  let shortCodeShown = $state(false);

  function handleShowShortCode() {
    revealShortCode();
    shortCodeShown = true;
  }

  // The imported identity is unlocked BEFORE the import writes anything, so
  // the at-rest key is armed and every row is sealed on the way in. That is
  // why the password is asked here rather than after the reload.
  let syncPassword = $state("");
  let passwordRetry = $state(false);
  let passwordResolve: ((value: string | null) => void) | null = null;

  function requestSyncPassword(retry: boolean): Promise<string | null> {
    passwordRetry = retry;
    syncPassword = "";
    view = "password";
    return new Promise((resolve) => {
      passwordResolve = resolve;
    });
  }

  function settlePassword(value: string | null) {
    const resolve = passwordResolve;
    passwordResolve = null;
    syncPassword = "";
    if (value !== null) view = "progress";
    resolve?.(value);
  }

  // Reset state when dialog closes
  $effect(() => {
    if (!open) {
      // A prompt left hanging would leave the import awaiting forever;
      // answering null aborts it with nothing written.
      settlePassword(null);
      shortCodeShown = false;
      (async () => {
        // Wait for any in-flight scan start to complete
        if (startScanPromise) {
          try {
            await startScanPromise;
          } catch (e) {
            // Ignore - scan start failed
          }
        }
        await cancelSync();
      })();
      view = "select";
      manualToken = "";
      syncMode = "add";
      pendingPayload = null;
      scanPermission = null;
    }
  });

  // Watch for sync state changes
  $effect(() => {
    if (syncState.qrDataUrl && view === "qr-display") {
      // QR code is ready
    }
    if (syncState.isComplete) {
      view = "complete";
      onComplete?.();
    }
    if (syncState.syncError) {
      view = "error";
    }
  });

  async function handleGenerateCode() {
    view = "qr-display";
    await generateSyncCode();
  }

  let tokenCopied = $state(false);

  async function handleCopyToken() {
    if (!syncState.plaintextToken) return;
    try {
      await navigator.clipboard.writeText(syncState.plaintextToken);
      tokenCopied = true;
      setTimeout(() => (tokenCopied = false), 1500);
    } catch {
      // Clipboard blocked - an insecure origin, or permission refused,
      // which is common on a phone. Say so rather than looking like the
      // button did nothing: the code is on screen and can be typed.
      copyFailed = true;
      setTimeout(() => (copyFailed = false), 3000);
    }
  }

  let copyFailed = $state(false);

async function handleStartScanning() {
  view = "scan";
  await tick();
  try {
    startScanPromise = startScanning(
        scannerElementId,
        async (payload) => {
          await handleScanSuccess(payload);
        },
        (error) => {
          console.error("Scan error:", error);
          scanPermission = false;
        }
      );
    await startScanPromise;
    // startScanning catches its own failures and reports them through
    // onError, so it RESOLVES either way - reading the error it recorded is
    // the only way to tell a running camera from a refused one. Setting this
    // true unconditionally is why the "camera access denied" panel could
    // never appear: onError set it false and the next line set it back.
    scanPermission = !syncState.scanError;
    } catch (err) {
      scanPermission = false;
      console.error("Failed to start scanner:", err);
    } finally {
      startScanPromise = null;
    }
  }

  async function handleSwitchCamera() {
    const next = nextScanCameraId();
    if (!next) return;
    await switchScanCamera(
      next,
      scannerElementId,
      async (payload) => {
        await handleScanSuccess(payload);
      },
      (error) => {
        console.error("Scan error:", error);
        scanPermission = false;
      }
    );
    scanPermission = !syncState.scanError;
  }

  function handleManualInput() {
    view = "manual-input";
  }

  async function handleSubmitManualToken() {
    let payload: SyncPayload | null;
    try {
      // Throws (rather than returning null) for a code from before peerId
      // pinning existed, with a message telling the user to update both
      // devices - that's distinct from a plain typo/garbage input.
      payload = parsePlaintextToken(manualToken.trim());
    } catch (err) {
      syncState.syncError =
        err instanceof Error ? err.message : "Invalid sync code format";
      view = "error";
      return;
    }
    if (!payload) {
      syncState.syncError = "Invalid sync code format";
      view = "error";
      return;
    }
    if (payload.expires < Date.now()) {
      syncState.syncError = "Sync code has expired";
      view = "error";
      return;
    }
    // Store payload
    pendingPayload = payload;

    // Auto-set mode based on flow
    if (flowMode === "receive") {
      syncMode = "replace";
      pendingPayload.mode = "replace";
      await startSync();
    } else if (flowMode === "scan-qr") {
      syncMode = "add";
      await startSync();
    } else {
      view = "mode-select";
    }
  }

  async function handleScanSuccess(payload: SyncPayload) {
    pendingPayload = payload;

    if (flowMode === "receive") {
      syncMode = "replace";
      pendingPayload.mode = "replace";
      await startSync();
    } else if (flowMode === "scan-qr") {
      syncMode = "add";
      await startSync();
    } else {
      view = "mode-select";
    }
  }

  async function handleClose() {
    await cancelSync();
    onClose();
  }

  async function handleRetry() {
    settlePassword(null);
    shortCodeShown = false;
    await cancelSync();
    if (flowMode === "generate-qr") {
      view = "qr-display";
      generateSyncCode();
    } else {
      view = "select";
    }
  }

  let pendingPayload: SyncPayload | null = null;

  async function handleSelectMode() {
    if (!pendingPayload) return;

    pendingPayload.mode = syncMode;
    await startSync();
  }

  async function startSync() {
    if (!pendingPayload) return;

    view = "progress";
    try {
      await connectAsTarget(pendingPayload, {
        requestPassword: requestSyncPassword,
      });
    } catch (err) {
      syncState.syncError =
        err instanceof Error ? err.message : "Failed to connect";
      view = "error";
    }
  }
</script>

<Dialog
  bind:open
  onOpenChange={(v) => {
    if (!v) handleClose();
  }}
>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono max-w-md"
  >
    <DialogHeader>
      <DialogTitle
        class="font-mono text-base font-semibold flex items-center gap-2"
      >
        {#if view === "select"}
          Sync with device
        {:else if view === "qr-display"}
          Scan this code
        {:else if view === "scan"}
          Scan QR code
        {:else if view === "manual-input"}
          Enter sync code
        {:else if view === "mode-select"}
          Choose sync mode
        {:else if view === "password"}
          Unlock the incoming account
        {:else if view === "progress"}
          Syncing...
        {:else if view === "complete"}
          Sync complete
        {:else if view === "error"}
          Sync failed
        {/if}
      </DialogTitle>
    </DialogHeader>

    <div class="flex flex-col gap-4">
      {#if view === "select"}
        {#if flowMode === "generate-qr"}
          <!-- Auto-generates QR code, this branch shouldn't show -->
        {:else if flowMode === "receive" || flowMode === "scan-qr"}
          <p class="text-sm text-muted-foreground">
            {#if flowMode === "receive"}
              Sync from another device. This will replace all data on this
              device.
            {:else}
              Scan QR code from another device to merge data.
            {/if}
          </p>
          <div class="grid grid-cols-2 gap-3">
            <Button
              onclick={handleStartScanning}
              variant="outline"
              class="font-mono flex-col h-24 gap-2"
            >
              <Camera class="w-6 h-6" />
              <span class="text-xs">Scan QR code</span>
            </Button>
            <Button
              onclick={handleManualInput}
              variant="outline"
              class="font-mono flex-col h-24 gap-2"
            >
              <Keyboard class="w-6 h-6" />
              <span class="text-xs">Enter code manually</span>
            </Button>
          </div>
        {/if}
      {:else if view === "qr-display"}
        <div class="flex flex-col items-center gap-4">
          {#if syncState.isGenerating}
            <div
              class="w-64 h-64 flex items-center justify-center bg-muted rounded-lg"
            >
              <RefreshCw class="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          {:else if syncState.qrDataUrl}
            <img
              src={syncState.qrDataUrl}
              alt="Sync QR Code"
              class="w-64 h-64 rounded-lg"
            />
          {:else}
            <div
              class="w-64 h-64 bg-muted rounded-lg flex items-center justify-center"
            >
              <CircleAlert class="w-8 h-8 text-destructive" />
            </div>
          {/if}

          {#if shortCodeShown}
            <div class="w-full space-y-2">
              <p class="text-xs text-muted-foreground text-center">
                Or enter this code manually:
              </p>
              <div class="flex gap-2">
                <Input
                  value={syncState.plaintextToken ?? ""}
                  readonly
                  class="font-mono text-center text-sm bg-muted"
                />
                <Button
                  onclick={handleCopyToken}
                  variant="outline"
                  size="icon"
                  class="shrink-0"
                  aria-label={tokenCopied ? "Copied" : "Copy sync code"}
                >
                  {#if tokenCopied}
                    <Check class="w-4 h-4 text-primary" />
                  {:else}
                    <Copy class="w-4 h-4" />
                  {/if}
                </Button>
              </div>
              {#if copyFailed}
                <p class="text-xs text-muted-foreground">
                  Could not reach the clipboard. Type the code instead.
                </p>
              {/if}
            </div>
          {:else}
            <Button
              onclick={handleShowShortCode}
              variant="ghost"
              class="w-full font-mono text-xs text-muted-foreground"
            >
              <Keyboard class="w-3.5 h-3.5 mr-2" />
              Can't scan? Show a code to type
            </Button>
          {/if}

          {#if syncState.isConnecting}
            <p class="text-xs text-muted-foreground">Waiting for device...</p>
          {:else if syncState.isSyncing}
            <div class="w-full space-y-2">
              <div class="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  class="h-full bg-primary transition-all duration-300"
                  style="width: {syncState.syncProgress}%"
                ></div>
              </div>
              <p class="text-xs text-muted-foreground text-center">
                Transferring data... {syncState.syncProgress}%
              </p>
            </div>
          {/if}
        </div>
      {:else if view === "scan"}
        <div class="flex flex-col items-center gap-4">
          {#if scanPermission === false}
            <div class="text-center space-y-2">
              <CircleAlert class="w-12 h-12 text-destructive mx-auto" />
              <p class="text-sm text-muted-foreground">
                Camera access denied. Please allow camera access or use manual
                entry.
              </p>
            </div>
            <Button onclick={handleManualInput} class="w-full font-mono">
              <Keyboard class="w-4 h-4 mr-2" />
              Enter code manually
            </Button>
          {:else}
            <div class="relative w-full">
              <div
                id={scannerElementId}
                class="w-full aspect-square bg-black rounded-lg overflow-hidden"
              ></div>
              <!-- Over the viewfinder, because that is where the user is
                   looking while they hold two phones up to each other. -->
              <div class="absolute right-2 top-2 flex flex-col gap-2">
                {#if scannerState.cameras.length > 1}
                  <button
                    type="button"
                    onclick={handleSwitchCamera}
                    aria-label="Switch camera"
                    class="inline-flex size-11 items-center justify-center rounded-lg bg-black/60 text-white backdrop-blur hover:bg-black/80"
                  >
                    <SwitchCamera class="size-5" />
                  </button>
                {/if}
                {#if scannerState.torchAvailable}
                  <button
                    type="button"
                    onclick={() => void toggleScanTorch()}
                    aria-pressed={scannerState.torchOn}
                    aria-label={scannerState.torchOn
                      ? "Turn off torch"
                      : "Turn on torch"}
                    class="inline-flex size-11 items-center justify-center rounded-lg backdrop-blur {scannerState.torchOn
                      ? 'bg-white text-black'
                      : 'bg-black/60 text-white hover:bg-black/80'}"
                  >
                    {#if scannerState.torchOn}
                      <Flashlight class="size-5" />
                    {:else}
                      <FlashlightOff class="size-5" />
                    {/if}
                  </button>
                {/if}
              </div>
              {#if scannerState.awaitingPermission}
                <!-- The prompt is open and unanswered. Without this the view
                     was a black square for however long the user took to
                     read it, which reads as a scanner that does not work. -->
                <div
                  class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/80 p-4 text-center"
                >
                  <Camera class="size-8 text-white/80" />
                  <p class="text-xs text-white/80">
                    Waiting for camera permission - answer your browser's
                    prompt to start scanning.
                  </p>
                </div>
              {/if}
            </div>
            <p class="text-xs text-muted-foreground text-center">
              Point your camera at the QR code on your other device.
            </p>
          {/if}
        </div>
      {:else if view === "manual-input"}
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            Enter the sync code shown on your other device (three groups of
            eight characters, separated by dashes).
          </p>
          <Input
            bind:value={manualToken}
            placeholder="abcd1234-abcd1234-abcd1234"
            class="font-mono text-center uppercase"
            onkeydown={(e) => {
              if (e.key === "Enter" && manualToken.trim()) {
                // preventDefault: otherwise the keypress bubbles into the
                // dialog and closes it mid-submit, aborting the sync
                e.preventDefault();
                e.stopPropagation();
                handleSubmitManualToken();
              }
            }}
          />
          <Button
            onclick={handleSubmitManualToken}
            disabled={!manualToken.trim()}
            class="w-full font-mono"
          >
            Connect
          </Button>
        </div>
      {:else if view === "mode-select"}
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            Choose how to sync data from the other device.
          </p>

          <div class="space-y-3">
            <button
              onclick={() => {
                syncMode = "add";
              }}
              class="w-full p-4 border rounded-lg text-left transition-colors hover:bg-muted/50 {syncMode ===
              'add'
                ? 'border-primary bg-primary/5'
                : 'border-border'}"
            >
              <div class="flex items-start gap-3">
                <div
                  class="w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center {syncMode ===
                  'add'
                    ? 'border-primary'
                    : 'border-muted-foreground'}"
                >
                  {#if syncMode === "add"}
                    <div class="w-2.5 h-2.5 rounded-full bg-primary"></div>
                  {/if}
                </div>
                <div class="flex-1">
                  <p class="font-medium text-sm">Merge into this device</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    Combines data from both devices. Rooms and messages from the
                    other device will be added to this one.
                  </p>
                </div>
              </div>
            </button>

            <button
              onclick={() => {
                syncMode = "replace";
              }}
              class="w-full p-4 border rounded-lg text-left transition-colors hover:bg-muted/50 {syncMode ===
              'replace'
                ? 'border-primary bg-primary/5'
                : 'border-border'}"
            >
              <div class="flex items-start gap-3">
                <div
                  class="w-5 h-5 rounded-full border-2 mt-0.5 flex items-center justify-center {syncMode ===
                  'replace'
                    ? 'border-primary'
                    : 'border-muted-foreground'}"
                >
                  {#if syncMode === "replace"}
                    <div class="w-2.5 h-2.5 rounded-full bg-primary"></div>
                  {/if}
                </div>
                <div class="flex-1">
                  <p class="font-medium text-sm">Replace everything</p>
                  <p class="text-xs text-muted-foreground mt-1">
                    Replaces all data on this device with data from the other
                    device. Current data will be overwritten.
                  </p>
                </div>
              </div>
            </button>
          </div>

          <Button onclick={handleSelectMode} class="w-full font-mono">
            Continue
          </Button>
        </div>
      {:else if view === "password"}
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            {passwordRetry
              ? "That password did not unlock the account from the other device. Try again."
              : "Type the password of the account coming from the other device. Nothing is written until it unlocks."}
          </p>
          <Input
            type="password"
            bind:value={syncPassword}
            placeholder="Account password"
            class="font-mono"
            onkeydown={(e) => {
              if (e.key === "Enter" && syncPassword) {
                // Same reason as the manual-code input: the keypress would
                // otherwise bubble up and close the dialog mid-import.
                e.preventDefault();
                e.stopPropagation();
                settlePassword(syncPassword);
              }
            }}
          />
          <Button
            onclick={() => settlePassword(syncPassword)}
            disabled={!syncPassword}
            class="w-full font-mono"
          >
            Unlock and import
          </Button>
          <Button
            onclick={() => {
              // Settle first: the import is awaiting this promise, and only a
              // null answer makes it abort without writing.
              settlePassword(null);
              handleClose();
            }}
            variant="outline"
            class="w-full font-mono"
          >
            Cancel
          </Button>
        </div>
      {:else if view === "progress"}
        <div class="flex flex-col items-center gap-4 py-4">
          <RefreshCw class="w-8 h-8 animate-spin text-primary" />
          <div class="w-full space-y-2">
            <div class="h-2 bg-muted rounded-full overflow-hidden">
              <div
                class="h-full bg-primary transition-all duration-300"
                style="width: {syncState.syncProgress}%"
              ></div>
            </div>
            <p class="text-sm text-center">
              {#if syncState.isConnecting}
                Connecting to device...
              {:else if syncState.phase === "importing"}
                Importing on this device... {syncState.syncProgress}%
              {:else if syncState.phase === "importing-remote"}
                The other device is importing... {syncState.syncProgress}%
              {:else if syncState.isSyncing}
                Syncing data... {syncState.syncProgress}%
              {:else}
                Finishing up...
              {/if}
            </p>
          </div>
        </div>

        <Button
          onclick={handleClose}
          variant="outline"
          class="w-full font-mono"
        >
          Cancel
        </Button>
      {:else if view === "complete"}
        <div class="flex flex-col items-center gap-4 py-4">
          <div
            class="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center"
          >
            <Check class="w-8 h-8 text-green-500" />
          </div>
          <div class="text-center space-y-1">
            <p class="font-semibold">Sync complete</p>
            <p class="text-sm text-muted-foreground">
              Your data has been successfully transferred.
            </p>
          </div>
        </div>

        <Button
          onclick={() => {
            handleClose();
            if (flowMode !== "generate-qr") {
              window.location.reload();
            }
          }}
          class="w-full font-mono"
        >
          Continue
        </Button>
      {:else if view === "error"}
        <div class="flex flex-col items-center gap-4 py-4">
          <div
            class="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center"
          >
            <CircleAlert class="w-8 h-8 text-destructive" />
          </div>
          <div class="text-center space-y-1">
            <p class="font-semibold">Sync failed</p>
            <p class="text-sm text-muted-foreground">
              {syncState.syncError || "An error occurred during sync"}
            </p>
          </div>
        </div>

        <div class="flex gap-2">
          <Button
            onclick={handleClose}
            variant="outline"
            class="flex-1 font-mono"
          >
            Cancel
          </Button>
          <Button onclick={handleRetry} class="flex-1 font-mono">
            <RefreshCw class="w-4 h-4 mr-2" />
            Retry
          </Button>
        </div>
      {/if}
    </div>
  </DialogContent>
</Dialog>
