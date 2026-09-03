<script lang="ts">
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import {
    wipeLocalDatabase,
    getStorageMetrics,
    requestPersistentStorage,
    type StorageMetrics,
  } from "$lib/storage";
  import {
    HardDrive,
    File,
    MessageSquare,
    Users,
    Database,
    Download,
    Upload,
    ShieldCheck,
    ShieldAlert,
  } from "@lucide/svelte";
  import {
    downloadBackup,
    readBackupFile,
    applyBackup,
    summarizeBackup,
    decryptBackup,
    type BackupFile,
    type BackupSummary,
    type EncryptedBackupFile,
  } from "$lib/transport/sync.svelte";
  import { Input } from "$lib/components/ui/input";
  import { roomsStore } from "$lib/rooms.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { resolveDmRoomDisplayName } from "$lib/dm-display-name";

  interface Props {
    activeTab?: string;
  }

  let { activeTab = "data" }: Props = $props();

  let metrics = $state<StorageMetrics | null>(null);
  let metricsError = $state(false);
  let confirmErase = $state(false);

  /**
   * Enhance room names in metrics by resolving DM rooms to their
   * counterparty's display name instead of the raw room code.
   */
  function enhanceMetricsWithDmNames(m: StorageMetrics): StorageMetrics {
    return {
      ...m,
      rooms: m.rooms.map((room) => {
        // Only process if the room name looks like a DM room code.
        if (!room.name.startsWith("dm-")) {
          return room;
        }
        const displayName = resolveDmRoomDisplayName(
          room.name,
          roomsStore.dmRooms,
          roomsStore.phonebook,
          transportState.peerNames
        );
        return {
          ...room,
          name: displayName,
        };
      }),
    };
  }

  $effect(() => {
    if (activeTab === "data" && !metrics && !metricsError) {
      getStorageMetrics()
        .then((m) => {
          // Enhance room names with DM counterparty display names.
          metrics = enhanceMetricsWithDmNames(m);
        })
        .catch((err) => {
          // Failing silently left "Loading metrics..." forever - and with it
          // hid the storage-eviction warning this tab exists to show.
          console.warn("[settings] storage metrics failed:", err);
          metricsError = true;
        });
    }
  });

  function formatBytes(bytes: number | undefined): string {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(k)),
      sizes.length - 1
    );
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  let persistBusy = $state(false);

  let persistDenied = $state(false);

  async function handleRequestPersist() {
    persistBusy = true;
    persistDenied = false;
    try {
      const granted = await requestPersistentStorage();
      if (metrics) metrics = { ...metrics, persisted: granted };
      // Browsers decide this themselves: Chrome grants it once the app is
      // installed or used enough, Firefox asks. Saying nothing made the button
      // look broken, so be explicit when the answer is no.
      persistDenied = !granted;
    } finally {
      persistBusy = false;
    }
  }

  async function handleEraseLocalData() {
    await wipeLocalDatabase();
    window.location.reload();
  }

  // ── Backup / restore ──────────────────────────────────────────────────────
  let fileInput = $state<HTMLInputElement | null>(null);
  let backupBusy = $state(false);
  let backupError = $state<string | null>(null);
  // The parsed backup is deliberately NOT $state: a rune proxy cannot be
  // structured-cloned, so handing it to IndexedDB throws and the import
  // silently does nothing. Only the summary needs to be reactive.
  let pendingBackup: BackupFile | null = null;
  let pendingSummary = $state<BackupSummary | null>(null);
  // The envelope of an encrypted file, held until the passphrase arrives.
  let pendingEnvelope: EncryptedBackupFile | null = null;
  let needsPassphrase = $state(false);
  let filePassphrase = $state("");
  // Replace mode adopts the file's identity, and the password unlocks it
  // BEFORE the import writes anything - see applyBackup's requestPassword.
  let restorePassword = $state("");
  let exportPrompt = $state(false);
  let exportPassphrase = $state("");
  let exportPassphraseConfirm = $state("");

  function resetPending() {
    pendingBackup = null;
    pendingSummary = null;
    pendingEnvelope = null;
    needsPassphrase = false;
    filePassphrase = "";
    restorePassword = "";
  }

  async function handleDownload() {
    backupError = null;
    if (exportPassphrase.length < 8) {
      backupError = "Use a passphrase of at least 8 characters";
      return;
    }
    if (exportPassphrase !== exportPassphraseConfirm) {
      backupError = "The two passphrases do not match";
      return;
    }
    backupBusy = true;
    try {
      await downloadBackup(exportPassphrase);
      exportPrompt = false;
      exportPassphrase = "";
      exportPassphraseConfirm = "";
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  // globalThis.File: the lucide icon import named File shadows the DOM type.
  async function processBackupFile(file: globalThis.File) {
    backupError = null;
    backupBusy = true;
    try {
      const parsed = await readBackupFile(file);
      if (parsed.encrypted) {
        // Nothing is readable until the passphrase arrives, not even the
        // summary - so ask before showing anything about the file.
        pendingEnvelope = parsed.envelope;
        needsPassphrase = true;
      } else {
        pendingBackup = parsed.backup;
        pendingSummary = summarizeBackup(parsed.backup);
      }
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  async function handleUnlockFile() {
    if (!pendingEnvelope) return;
    backupError = null;
    backupBusy = true;
    try {
      const data = await decryptBackup(pendingEnvelope, filePassphrase);
      pendingBackup = data;
      pendingSummary = summarizeBackup(data);
      pendingEnvelope = null;
      needsPassphrase = false;
      filePassphrase = "";
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
    } finally {
      backupBusy = false;
    }
  }

  async function handleFilePicked(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // let the same file be picked again after a cancel
    if (!file) return;
    await processBackupFile(file);
  }

  // A backup the OS launched us with (file_handlers) is waiting in
  // launch-file.ts - treat it exactly like a picked file.
  $effect(() => {
    if (activeTab !== "data") return;
    void import("$lib/launch-file").then(({ takePendingBackupFile }) => {
      const file = takePendingBackupFile();
      if (file) void processBackupFile(file);
    });
  });

  async function handleApply(mode: "add" | "replace") {
    if (!pendingBackup) return;
    backupError = null;
    backupBusy = true;
    try {
      await applyBackup(pendingBackup, mode, {
        // Replace mode adopts the file's identity: unlocking it here arms the
        // at-rest key before the first row is written, so the import seals as
        // it goes instead of landing plaintext. Declining the retry turns a
        // wrong password into an error rather than a second prompt.
        requestPassword: async (retry) => (retry ? null : restorePassword),
      });
      window.location.reload();
    } catch (e) {
      backupError = e instanceof Error ? e.message : String(e);
      backupBusy = false;
    }
  }
</script>

<div class="flex flex-col gap-6">
  <!-- Storage Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-orange-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Storage</Label
      >
    </div>

    {#if metrics}
      <div class="flex flex-col gap-4">
        <!-- Stats Grid -->
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <MessageSquare class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Messages</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalMessages.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Rooms</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalRooms.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Profiles</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalProfiles.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <File class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Files</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalAttachments.toLocaleString()}
            </p>
          </div>
        </div>

        <!-- Eviction protection -->
        <div class="bg-muted/50 rounded-lg p-3 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            {#if metrics.persisted}
              <ShieldCheck class="w-4 h-4 text-primary shrink-0" />
            {:else}
              <ShieldAlert class="w-4 h-4 text-amber-500 shrink-0" />
            {/if}
            <span class="text-xs font-mono">
              {metrics.persisted ? "Storage is protected" : "Storage can be evicted"}
            </span>
          </div>
          <p class="text-xs font-mono text-muted-foreground leading-relaxed">
            {metrics.persisted
              ? "The browser has agreed not to clear this data on its own. Erasing site data or uninstalling still wipes it."
              : "The browser may clear this data when the device runs low on space, and there is no server copy to restore from."}
          </p>
          {#if !metrics.persisted}
            <Button
              variant="outline"
              class="font-mono text-xs"
              disabled={persistBusy}
              onclick={handleRequestPersist}
            >
              {persistBusy ? "Asking..." : "Request persistent storage"}
            </Button>
            {#if persistDenied}
              <p
                class="text-xs font-mono text-muted-foreground leading-relaxed"
              >
                The browser said no. This is its call, not the app's: Chrome
                and Android grant it once the app is installed to your home
                screen or you have used it a few times, Firefox asks for
                permission, and Safari never grants it. Installing the app is
                the most reliable way to get it. Your data is still here either
                way, it just is not protected from automatic cleanup, so keep a
                backup from below.
              </p>
            {/if}
          {/if}
        </div>

        <!-- Storage Size Card -->
        <div class="bg-muted/50 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <HardDrive class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Total Storage</span
              >
            </div>
            <span class="text-lg font-semibold font-mono"
              >{formatBytes(metrics.storedDataSize)}</span
            >
          </div>

          {#if metrics.totalAttachments > 0}
            <div class="space-y-2">
              <div class="flex items-center justify-between text-xs">
                <span class="text-muted-foreground font-mono">
                  Seeding {metrics.seedingAttachments} of {metrics.totalAttachments}
                  files
                </span>
                <span class="font-mono text-green-500">
                  {Math.round(
                    (metrics.seedingAttachments / metrics.totalAttachments) *
                      100
                  )}%
                </span>
              </div>
              <div class="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  class="h-full bg-linear-to-r from-green-500 to-green-400 rounded-full transition-all duration-500"
                  style="width: {(metrics.seedingAttachments /
                    metrics.totalAttachments) *
                    100}%"
                ></div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-muted-foreground font-mono">
              No attachments stored
            </p>
          {/if}
        </div>

        <!-- Top Rooms Bar Chart -->
        {#if metrics.rooms.length > 0}
          <div class="bg-muted/50 rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <Database class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Top Rooms</span
              >
            </div>
            <div class="flex flex-col gap-2">
              {#each metrics.rooms as room, i}
                {@const maxMessages = metrics.rooms[0]?.messageCount || 1}
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-mono w-4 text-muted-foreground"
                    >{i + 1}.</span
                  >
                  <span class="font-mono w-24 truncate text-muted-foreground"
                    >{room.name}</span
                  >
                  <div class="flex-1 h-2 bg-muted rounded overflow-hidden">
                    <div
                      class="h-full bg-primary/60 rounded transition-all duration-500"
                      style="width: {(room.messageCount / maxMessages) * 100}%"
                    ></div>
                  </div>
                  <span class="font-mono w-10 text-right"
                    >{room.messageCount}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else if metricsError}
      <div class="flex flex-col items-center gap-2 py-8">
        <span class="text-xs text-muted-foreground font-mono"
          >Couldn't read storage metrics.</span
        >
        <Button
          variant="outline"
          class="font-mono text-xs"
          onclick={() => (metricsError = false)}
        >
          Try again
        </Button>
      </div>
    {:else}
      <!-- Skeleton layout that reserves the same space as the real metrics to
           prevent layout shift while data loads. Replaces the centered
           "Loading metrics..." message that caused flicker. -->
      <div class="flex flex-col gap-4 animate-pulse">
        <!-- Stats Grid Skeleton -->
        <div class="grid grid-cols-2 gap-3">
          {#each [1, 2, 3, 4] as _}
            <div class="bg-muted/50 rounded-lg p-3">
              <div class="flex items-center gap-2 mb-1">
                <div class="w-3.5 h-3.5 rounded bg-muted/60"></div>
                <div class="h-3 w-16 rounded bg-muted/60"></div>
              </div>
              <div class="h-6 w-20 rounded bg-muted/60"></div>
            </div>
          {/each}
        </div>

        <!-- Eviction Protection Skeleton -->
        <div class="bg-muted/50 rounded-lg p-3 flex flex-col gap-2">
          <div class="flex items-center gap-2">
            <div class="w-4 h-4 rounded bg-muted/60"></div>
            <div class="h-3 w-32 rounded bg-muted/60"></div>
          </div>
          <div class="space-y-1">
            <div class="h-3 w-full rounded bg-muted/60"></div>
            <div class="h-3 w-4/5 rounded bg-muted/60"></div>
          </div>
        </div>

        <!-- Storage Size Card Skeleton -->
        <div class="bg-muted/50 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <div class="w-4 h-4 rounded bg-muted/60"></div>
              <div class="h-3 w-24 rounded bg-muted/60"></div>
            </div>
            <div class="h-6 w-16 rounded bg-muted/60"></div>
          </div>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <div class="h-3 w-32 rounded bg-muted/60"></div>
              <div class="h-3 w-12 rounded bg-muted/60"></div>
            </div>
            <div class="h-2 w-full rounded bg-muted/60"></div>
          </div>
        </div>

        <!-- Top Rooms Skeleton -->
        <div class="bg-muted/50 rounded-lg p-4">
          <div class="flex items-center gap-2 mb-3">
            <div class="w-4 h-4 rounded bg-muted/60"></div>
            <div class="h-3 w-24 rounded bg-muted/60"></div>
          </div>
          <div class="flex flex-col gap-2">
            {#each [1, 2, 3] as _}
              <div class="flex items-center gap-2 text-xs">
                <div class="w-4 h-4 rounded bg-muted/60"></div>
                <div class="w-24 h-3 rounded bg-muted/60"></div>
                <div class="flex-1 h-2 rounded bg-muted/60"></div>
                <div class="w-10 h-3 rounded bg-muted/60"></div>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {/if}
  </div>

  <!-- Backup / Restore -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-cyan-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Backup</Label
      >
    </div>
    <p class="text-xs text-muted-foreground font-mono leading-relaxed">
      Save everything on this device to a file, or restore from one. Same data
      as a QR device sync, without needing both devices online at once. The file
      is encrypted with a passphrase you choose when you export it: anyone who
      has both the file and that passphrase has your whole account, and without
      the passphrase the file cannot be opened at all - not even by you.
    </p>

    {#if backupError}
      <p
        class="text-xs font-mono text-destructive bg-destructive/10 border border-destructive/30 rounded-md p-2"
      >
        {backupError}
      </p>
    {/if}

    {#if needsPassphrase}
      <div class="flex flex-col gap-3 bg-muted/50 rounded-lg p-3">
        <p class="text-xs font-mono text-muted-foreground">
          This backup is encrypted. Type the passphrase that was chosen when it
          was exported.
        </p>
        <Input
          type="password"
          bind:value={filePassphrase}
          placeholder="Backup passphrase"
          class="font-mono text-xs"
        />
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button
            class="flex-1 font-mono text-xs"
            disabled={backupBusy || !filePassphrase}
            onclick={handleUnlockFile}
          >
            Open this backup
          </Button>
          <Button
            variant="ghost"
            class="flex-1 font-mono text-xs text-muted-foreground"
            disabled={backupBusy}
            onclick={resetPending}
          >
            Cancel
          </Button>
        </div>
      </div>
    {:else if pendingSummary}
      {@const s = pendingSummary}
      <div class="flex flex-col gap-3 bg-muted/50 rounded-lg p-3">
        <p class="text-xs font-mono text-muted-foreground">
          {s.messages.toLocaleString()} messages · {s.rooms} rooms · {s.attachments}
          files · {s.profiles} profiles{s.exportedAt
            ? ` · from ${new Date(s.exportedAt).toLocaleDateString()}`
            : ""}
        </p>
        <p class="text-xs font-mono text-muted-foreground">
          {s.hasIdentity
            ? "Includes an identity, so it can replace this device entirely."
            : "No identity in this file, so it can only be merged."}
        </p>
        {#if s.hasIdentity}
          <!-- Asked BEFORE the import runs: it unlocks the identity in the
               file, which arms at-rest encryption so the restored rows are
               sealed as they are written. -->
          <Input
            type="password"
            bind:value={restorePassword}
            placeholder="Account password from this backup"
            class="font-mono text-xs"
          />
        {/if}
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button
            variant="outline"
            class="flex-1 font-mono text-xs"
            disabled={backupBusy}
            onclick={() => handleApply("add")}
          >
            Merge into this device
          </Button>
          <Button
            variant="destructive"
            class="flex-1 font-mono text-xs"
            disabled={backupBusy || !s.hasIdentity || !restorePassword}
            onclick={() => handleApply("replace")}
          >
            Replace everything
          </Button>
        </div>
        <Button
          variant="ghost"
          class="font-mono text-xs text-muted-foreground"
          disabled={backupBusy}
          onclick={resetPending}
        >
          Cancel
        </Button>
      </div>
    {:else if exportPrompt}
      <div class="flex flex-col gap-3 bg-muted/50 rounded-lg p-3">
        <p class="text-xs font-mono text-muted-foreground">
          Choose a passphrase for this file. It is the only thing standing
          between the file and your messages, and there is no way to recover it.
        </p>
        <Input
          type="password"
          bind:value={exportPassphrase}
          placeholder="Passphrase (8 characters or more)"
          class="font-mono text-xs"
        />
        <Input
          type="password"
          bind:value={exportPassphraseConfirm}
          placeholder="Repeat the passphrase"
          class="font-mono text-xs"
        />
        <div class="flex flex-col gap-2 sm:flex-row">
          <Button
            class="flex-1 font-mono text-xs"
            disabled={backupBusy || !exportPassphrase}
            onclick={handleDownload}
          >
            <Download class="w-3.5 h-3.5 mr-2" />
            {backupBusy ? "Encrypting..." : "Download encrypted backup"}
          </Button>
          <Button
            variant="ghost"
            class="flex-1 font-mono text-xs text-muted-foreground"
            disabled={backupBusy}
            onclick={() => {
              exportPrompt = false;
              exportPassphrase = "";
              exportPassphraseConfirm = "";
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    {:else}
      <div class="flex flex-col gap-2 sm:flex-row">
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          disabled={backupBusy}
          onclick={() => {
            backupError = null;
            exportPrompt = true;
          }}
        >
          <Download class="w-3.5 h-3.5 mr-2" />
          Download my data
        </Button>
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          disabled={backupBusy}
          onclick={() => fileInput?.click()}
        >
          <Upload class="w-3.5 h-3.5 mr-2" />
          Restore from file
        </Button>
      </div>
    {/if}
    <input
      bind:this={fileInput}
      type="file"
      accept="application/json,.json,.awfulbackup"
      class="hidden"
      onchange={handleFilePicked}
    />
  </div>

  <!-- Danger Zone -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-red-500 rounded-full"></div>
      <Label class="select-none text-xs font-mono text-destructive uppercase tracking-wider"
        >Danger Zone</Label
      >
    </div>
    <p class="text-xs text-muted-foreground font-mono">
      Erase all local data including identity, messages, and media.
    </p>
    {#if !confirmErase}
      <Button
        variant="destructive"
        class="w-full font-mono text-xs"
        onclick={() => (confirmErase = true)}
      >
        Erase all data
      </Button>
    {:else}
      <div class="flex gap-2">
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          onclick={() => (confirmErase = false)}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          class="flex-1 font-mono text-xs"
          onclick={handleEraseLocalData}
        >
          Erase everything
        </Button>
      </div>
    {/if}
  </div>
</div>
