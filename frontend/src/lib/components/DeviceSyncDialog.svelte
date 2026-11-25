<script lang="ts">
import { untrack } from "svelte";
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
    cancelSync,
    approveSync,
    denySync,
    type SyncPayload,
  } from "$lib/transport/sync.svelte";
  import { keepScreenAwake } from "$lib/screen-awake";
  import { formatComparisonCode } from "$lib/transport/sync-protocol";
  import {
    Copy,
    Camera,
    Keyboard,
    Check,
    CircleAlert,
    RefreshCw,
  } from "@lucide/svelte";
  import QrScanner from "./QrScanner.svelte";
  import { SCANNER_NOT_LOADED } from "$lib/qr-scanner.svelte";

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
  let scanPermission = $state<boolean | null>(null);
  // A code the camera read that is not a sync code. Not a camera problem:
  // it used to flip the view to "camera access denied".
  let scanHint = $state<string | null>(null);
  let scanUnavailable = $state<string | null>(null);
  let syncMode = $state<"add" | "replace">("add");

  // Auto-set initial view based on flowMode
  $effect(() => {
    if (open && view === "select") {
      if (flowMode === "generate-qr") {
        handleGenerateCode();
      }
    }
  });

  // Manual pairing copies the complete capability and full token, just like
  // scanning the QR. Showing it never weakens source authentication.
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

  // A phone that locks itself pauses the page, and the sync with it. From the
  // code being shown or used until it ended, one way or the other.
  const underWay = $derived(
    open &&
      !syncState.isComplete &&
      !syncState.syncError &&
      (syncState.qrDataUrl !== null ||
        syncState.isConnecting ||
        syncState.isSyncing ||
        syncState.awaitingApproval ||
        syncState.finishing)
  );
  $effect(() => {
    if (underWay) return keepScreenAwake();
  });

  // Reset state when dialog closes
  $effect(() => {
    if (!open) {
      // A prompt left hanging would leave the import awaiting forever;
      // answering null aborts it with nothing written.
      settlePassword(null);
      shortCodeShown = false;
      void cancelSync();
      view = "select";
      manualToken = "";
      syncMode = "add";
      pendingPayload = null;
      scanPermission = null;
      scanHint = null;
    }
  });

  // Watch for sync state changes. Completion wins over an error: a
  // "connection lost" said while the other device was still importing is
  // answered by the success that follows, and checking the error second
  // used to put the failure view over a sync that had finished.
  $effect(() => {
    if (syncState.isComplete) {
      if (untrack(() => view) !== "complete") {
        view = "complete";
        onComplete?.();
      }
    } else if (syncState.syncError) {
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

  // The viewfinder (QrScanner) starts the camera when it mounts and stops it
  // when it goes; this only opens the view.
  function handleStartScanning() {
    scanPermission = null;
    scanHint = null;
    view = "scan";
  }

  function handleScannedText(text: string): boolean {
    let payload: SyncPayload | null;
    try {
      // The same parser as the typed code; a full-form code carries the
      // whole peerId, which is what the target pins the connection to
      // (see connectAsTarget). parsePlaintextToken throws its own message
      // for a code from before pinning existed.
      payload = parsePlaintextToken(text);
    } catch (err) {
      scanHint = err instanceof Error ? err.message : "Invalid QR code";
      return false;
    }
    if (payload?.peerId) {
      void handleScanSuccess(payload);
      return true;
    }
    // The JSON payload the QR carried before this build. A PWA can hold an
    // old build for a while after a deploy.
    scanHint = text.startsWith("{")
      ? "This QR code is from an older version of the app - refresh the other device and generate a new code"
      : "That QR code is not a sync code.";
    return false;
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
      // On the payload, not just the radio: connectAsTarget defaults a
      // payload without a mode to "replace", so the merge this screen
      // promises wiped the device and adopted the other account.
      syncMode = "add";
      pendingPayload.mode = "add";
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
      // See handleSubmitManualToken: the mode has to be on the payload.
      syncMode = "add";
      pendingPayload.mode = "add";
      await startSync();
    } else {
      view = "mode-select";
    }
  }

  async function handleClose() {
    // Nothing to close while an import is finishing (see syncState.finishing):
    // the controls are gone, and this is the one way left.
    if (syncState.finishing) return;
    const reload = view === "complete" && flowMode !== "generate-qr";
    await cancelSync();
    onClose();
    // Closing a finished import is the same as Continue: the app reloads,
    // which is what reads the synced data - and the settings kept outside
    // the database - afresh.
    if (reload) window.location.reload();
  }

  async function handleAllow() {
    await approveSync();
  }

  async function handleDeny() {
    await denySync();
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

<!-- Under whatever a sync is doing. Leaving the app is what stalls one: a
     phone pauses the page, and the other device can only wait. -->
{#snippet stay()}
  <p class="text-xs text-muted-foreground text-center">
    Keep Awful.chat open on both devices.
  </p>
{/snippet}

<Dialog
  bind:open
  onOpenChange={(v) => {
    if (!v) handleClose();
  }}
>
  <!-- An import past its commit point cannot be stopped, so while it
       finishes the dialog cannot be dismissed either: closing it used to
       leave the writes running unseen, with "Create new identity" one click
       away from racing them. -->
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono max-w-md"
    closeClass="top-7"
    showCloseButton={!syncState.finishing}
    escapeKeydownBehavior={syncState.finishing ? "ignore" : "close"}
    interactOutsideBehavior={syncState.finishing ? "ignore" : "close"}
  >
    <DialogHeader>
      <DialogTitle
        class="font-mono text-base font-semibold flex items-center gap-2"
      >
        {#if view === "select"}
          Sync with device
        {:else if view === "qr-display"}
          {syncState.awaitingApproval ? "Allow this device?" : "Scan this code"}
        {:else if view === "scan"}
          Scan QR code
        {:else if view === "manual-input"}
          Enter sync code
        {:else if view === "mode-select"}
          Choose sync mode
        {:else if view === "password"}
          Unlock the incoming account
        {:else if view === "progress"}
          {syncState.awaitingApproval ? "Confirm on your other device" : "Syncing..."}
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
          {#if syncState.awaitingApproval && syncState.pairingCode}
            <!-- Holding the code is what makes a request, and anyone who saw
                 the QR holds it: the person decides, by comparing what both
                 screens show. -->
            <div class="w-full space-y-4 py-2">
              <p class="text-sm text-muted-foreground">
                A device wants to sync with this one. Check that your other
                device shows this code:
              </p>
              <p
                class="text-3xl font-semibold tracking-widest text-center"
                aria-label="Comparison code {syncState.pairingCode.split('').join(' ')}"
              >
                {formatComparisonCode(syncState.pairingCode)}
              </p>
              <p class="text-xs text-muted-foreground">
                If it shows a different code, or none, someone else has your
                sync code. Deny, and generate a new one.
              </p>
              <!-- Keyed on the code: a press that began over one request does not end
                   on the buttons of another that took its place. -->
              {#key syncState.pairingCode}
              <div class="flex gap-2">
                <Button
                  onclick={handleDeny}
                  variant="outline"
                  class="flex-1 font-mono"
                >
                  Deny
                </Button>
                <Button onclick={handleAllow} class="flex-1 font-mono">
                  Allow
                </Button>
              </div>
              {/key}
            </div>
          {:else if syncState.isGenerating}
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

          {#if syncState.awaitingApproval}
            <!-- The code is in use; nothing to copy while it is decided. -->
          {:else if shortCodeShown}
            <div class="w-full space-y-2">
              <p class="text-xs text-muted-foreground text-center">
                Or copy this sync code to your other device:
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
                  Could not reach the clipboard. Select and copy the complete code.
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
              Can't scan? Copy a sync code
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
                {#if syncState.reconnecting}
                  Connection lost. Reconnecting...
                {:else if syncState.phase === "remote-password"}
                  Waiting for the password on the other device...
                {:else if syncState.phase === "importing-remote"}
                  The other device is importing... {syncState.syncProgress}%
                {:else}
                  Transferring data... {syncState.syncProgress}%
                {/if}
              </p>
              {@render stay()}
            </div>
          {/if}
        </div>
      {:else if view === "scan"}
        <div class="flex flex-col items-center gap-4">
          {#if scanPermission === false}
            <div class="text-center space-y-2">
              <CircleAlert class="w-12 h-12 text-destructive mx-auto" />
              <p class="text-sm text-muted-foreground">
                {scanUnavailable ??
                  "Camera access denied. Please allow camera access or use manual entry."}
              </p>
            </div>
            <Button onclick={handleManualInput} class="w-full font-mono">
              <Keyboard class="w-4 h-4 mr-2" />
              Enter code manually
            </Button>
          {:else}
            <QrScanner
              onText={handleScannedText}
              onUnavailable={(message) => {
                console.error("Scan error:", message);
                // Plain http has no camera at all; saying "denied" sent people
                // looking for a permission that was never asked. Nor is a
                // scanner that did not download a camera problem.
                scanUnavailable =
                  /https/i.test(message) || message === SCANNER_NOT_LOADED ? message : null;
                scanPermission = false;
              }}
            />
            {#if scanHint}
              <p role="alert" class="text-xs text-destructive text-center">{scanHint}</p>
            {/if}
            <p class="text-xs text-muted-foreground text-center">
              Point your camera at the QR code on your other device.
            </p>
          {/if}
        </div>
      {:else if view === "manual-input"}
        <div class="space-y-4">
          <p class="text-sm text-muted-foreground">
            Paste the sync code copied from your other device.
          </p>
          <Input
            bind:value={manualToken}
            placeholder="Sync code"
            class="font-mono text-center"
            autocapitalize="off"
            autocorrect="off"
            spellcheck={false}
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
      {:else if view === "progress" && syncState.awaitingApproval && syncState.pairingCode}
        <div class="flex flex-col items-center gap-4 py-4">
          <p class="text-sm text-muted-foreground text-center">
            Confirm this code on your other device:
          </p>
          <p
            class="text-3xl font-semibold tracking-widest"
            aria-label="Comparison code {syncState.pairingCode.split('').join(' ')}"
          >
            {formatComparisonCode(syncState.pairingCode)}
          </p>
          <p class="text-xs text-muted-foreground text-center">
            Nothing is sent until it is allowed there.
          </p>
          {@render stay()}
        </div>

        <Button
          onclick={handleClose}
          variant="outline"
          class="w-full font-mono"
        >
          Cancel
        </Button>
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
              {:else if syncState.reconnecting}
                Connection lost. Reconnecting...
              {:else if syncState.finishing}
                Finishing... {syncState.syncProgress}%
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
            {#if !syncState.finishing}{@render stay()}{/if}
          </div>
        </div>

        {#if syncState.finishing}
          <!-- Past the commit point: Cancel would stop nothing. -->
          <p class="text-xs text-muted-foreground text-center">
            Keep this screen open until the import is done.
          </p>
        {:else}
          <Button
            onclick={handleClose}
            variant="outline"
            class="w-full font-mono"
          >
            Cancel
          </Button>
        {/if}
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

        <Button onclick={handleClose} class="w-full font-mono">
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
