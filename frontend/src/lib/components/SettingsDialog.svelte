<script lang="ts">
  import { openPalette, uiState } from "$lib/ui-state.svelte";
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
  let visibleHeight = $state(typeof window === "undefined" ? 800 : window.innerHeight);
  let viewportTop = $state(0);
  let viewportBottom = $state(0);
  $effect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      visibleHeight = viewport?.height ?? window.innerHeight;
      viewportTop = viewport?.offsetTop ?? 0;
      viewportBottom = Math.max(0, window.innerHeight - visibleHeight - viewportTop);
    };
    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  });

  // Filled in with the host the page is actually served from, so the command
  // is runnable as printed rather than a template to edit.
  const verifyCommand = $derived(
    `npx github:awful-org/awful-verify ${
      typeof window === "undefined" ? "your-instance" : window.location.host
    }`
  );
  let verifyCopied = $state(false);
  let verifyCopiedTimer: ReturnType<typeof setTimeout> | undefined;
  async function copyVerifyCommand() {
    try {
      await navigator.clipboard.writeText(verifyCommand);
      verifyCopied = true;
      clearTimeout(verifyCopiedTimer);
      verifyCopiedTimer = setTimeout(() => (verifyCopied = false), 1600);
    } catch {
      // Clipboard denied, or no permission. The command is on screen and
      // selectable either way.
    }
  }
  import { Button } from "$lib/components/ui/button";
  import { lock } from "$lib/identity/identity.svelte";
  import {
    LogOut,
    SlidersHorizontal,
    User,
    Volume2,
    RefreshCw,
    ChartPie,
    Activity,
    Info,
    Heart,
    Sparkles,
    Puzzle,
    Github,
    Check,
    Copy,
    ExternalLink,
  } from "@lucide/svelte";

  import ProfileSettings from "./settings/ProfileSettings.svelte";
  import AudioSettings from "./settings/AudioSettings.svelte";
  import SessionSettings from "./settings/SessionSettings.svelte";
  import AppSettings from "./settings/AppSettings.svelte";
  import DataSettings from "./settings/DataSettings.svelte";
  import DiagnosticsSettings from "./settings/DiagnosticsSettings.svelte";
  import PluginSettings from "./settings/PluginSettings.svelte";
  import AvatarPickerDialog from "./AvatarPickerDialog.svelte";
  import { getScopedProfile, saveAvatar, saveScopedFields } from "$lib/profile.svelte";
  import QuirksNotice from "./QuirksNotice.svelte";
  import OssCredits from "./OssCredits.svelte";
  import WhatsNewSettings from "./settings/WhatsNewSettings.svelte";
  import { whatsNew } from "$lib/whats-new.svelte";

  type SettingsTab =
    | "profile"
    | "audio"
    | "app"
    | "session"
    | "data"
    | "diagnostics"
    | "plugins"
    | "whatsnew"
    | "quirks"
    | "oss";

  interface Props {
    open: boolean;
    onClose: () => void;
    onOpenSync?: (mode: "generate-qr" | "scan-qr") => void;
  }

  let { open = $bindable(), onClose, onOpenSync }: Props = $props();

  let activeTab = $state<SettingsTab>("profile");

  // A requested tab (profile card's "Edit profile") wins when the dialog
  // opens; consumed so later opens land on the default again.
  $effect(() => {
    if (open && uiState.settingsTab) {
      activeTab = uiState.settingsTab as SettingsTab;
      selectedProfileRoom = uiState.settingsProfileRoom;
      uiState.settingsTab = null;
      uiState.settingsProfileRoom = null;
    }
  });
  let avatarDialogOpen = $state(false);
  let selectedProfileRoom = $state<string | null>(null);
  let avatarPickerRoom = $state<string | null>(null);
  $effect(() => {
    if (!open) selectedProfileRoom = null;
  });
  let isMobile = $state(false);

  const tabs = $state([
    { id: "profile" as SettingsTab, label: "Profile", icon: User },
    { id: "audio" as SettingsTab, label: "Audio", icon: Volume2 },
    { id: "app" as SettingsTab, label: "App", icon: SlidersHorizontal },
    { id: "session" as SettingsTab, label: "Session/Sync", icon: RefreshCw },
    { id: "data" as SettingsTab, label: "Data", icon: ChartPie },
    {
      id: "diagnostics" as SettingsTab,
      label: "Diagnostics",
      icon: Activity,
    },
    { id: "plugins" as SettingsTab, label: "Plugins", icon: Puzzle },
    { id: "quirks" as SettingsTab, label: "Quirks", icon: Info },
    { id: "oss" as SettingsTab, label: "OSS", icon: Heart },
    // Always last: news, not a setting. On desktop it also sits at the foot
    // of the column, apart from the tabs that change something.
    { id: "whatsnew" as SettingsTab, label: "What's new", icon: Sparkles },
  ]);

  $effect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => {
      isMobile = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });

  function handleLockLogout() {
    lock();
  }

  const closeHandler = (v: boolean) => {
    if (!v) onClose();
  };

  /** What the palette's own shortcut is called on this machine. */
  const modKey =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.userAgent) ? "⌘" : "Ctrl";

  /** Settings' tip: close this and open the palette on settings only. */
  function searchInPalette(): void {
    onClose();
    openPalette(">");
  }
</script>

{#snippet TabBar()}
  <!-- On a phone the bar is a full-width row that scrolls sideways and
       shows every label: nine icons squeezed into one pill left most tabs
       unnamed, and the pill read as a control of its own. Desktop keeps
       the column. -->
  <div
    class={isMobile
      ? "flex w-full gap-1 overflow-x-auto border-b border-border pb-2"
      : "flex flex-col gap-1 p-1 bg-muted rounded-lg md:h-full"}
  >
    {#each tabs as tab}
      <button
        type="button"
        onclick={() => (activeTab = tab.id)}
        aria-pressed={activeTab === tab.id}
        class="flex shrink-0 items-center gap-2 px-3 py-2 rounded-md text-xs font-mono transition-colors whitespace-nowrap {!isMobile &&
        tab.id === 'whatsnew'
          ? 'mt-auto'
          : ''} {activeTab ===
        tab.id
          ? isMobile
            ? 'bg-muted text-foreground'
            : 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10'}"
      >
        <!-- shrink-0: without it a long label like "Session/Sync" squeezes its
             own icon narrower than the others, so the labels no longer start
             at the same x and the column looks ragged. -->
        <tab.icon class="w-4 h-4 shrink-0" />
        <span class="truncate">{tab.label}</span>
        {#if tab.id === "whatsnew" && whatsNew.unseen}
          <span class="ml-auto size-2 shrink-0 rounded-full bg-primary" role="img" aria-label="New"></span>
        {/if}
      </button>
    {/each}
  </div>
{/snippet}

{#snippet QuirksTab()}
  <div class="flex flex-col gap-3">
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      Awful.chat is peer-to-peer: no accounts on a server, no copy of your data
      anywhere but your own devices. Here is what that changes compared to apps
      like WhatsApp or Discord.
    </p>
    <QuirksNotice />
  </div>
{/snippet}

{#snippet OssTab()}
  <div class="flex flex-col gap-3">
    <!-- One card, wrap-friendly: the old side-by-side button + version row
         overflowed narrow settings panels. -->
    <div
      class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-border/50 bg-muted/30 p-3"
    >
      <div class="flex min-w-0 items-center gap-2.5">
        <Github class="size-5 shrink-0 text-muted-foreground" />
        <div class="min-w-0">
          <p class="truncate font-mono text-xs font-semibold text-foreground">
            Awful.chat
            <span class="font-normal text-muted-foreground">
              - <a
                href="https://github.com/awful-org/awful.chat/blob/main/LICENSE"
                target="_blank"
                rel="noopener noreferrer"
                class="hover:text-primary hover:underline">Apache-2.0</a
              ></span
            >
          </p>
          <a
            href="https://github.com/awful-org/awful.chat"
            target="_blank"
            rel="noopener noreferrer"
            class="block truncate font-mono text-[11px] text-muted-foreground hover:text-primary hover:underline"
          >
            github.com/awful-org/awful.chat
          </a>
        </div>
      </div>
      <!-- Pre-1.0 there are no tags to link, so 0.x points at the releases
           list; once versions ship the link lands on the exact release. The
           commit hash is what identifies a build until then. -->
      <a
        href={__APP_VERSION__ === "0.0.0"
          ? "https://github.com/awful-org/awful.chat/releases"
          : `https://github.com/awful-org/awful.chat/releases/tag/v${__APP_VERSION__}`}
        target="_blank"
        rel="noopener noreferrer"
        class="shrink-0 rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
      >
        v{__APP_VERSION__}{__APP_COMMIT__ ? `-${__APP_COMMIT__}` : ""}
      </a>
    </div>
    <!-- The badge above is a CLAIM: this page saying which commit it was
         built from. Nothing about it is evidence, so the way to check it
         belongs directly underneath, with the host already filled in. -->
    <div
      class="flex flex-col gap-2 rounded-lg border border-border/50 bg-muted/30 p-3"
    >
      <p class="font-mono text-xs leading-relaxed text-muted-foreground">
        That version is what this page says it is running. A server can serve
        anything, so check it:
      </p>
      <button
        type="button"
        onclick={copyVerifyCommand}
        class="flex items-center justify-between gap-2 rounded-md border border-border
          bg-background/60 px-2 py-1.5 text-left font-mono text-[11px]
          text-foreground transition-colors hover:border-primary/60"
      >
        <span class="truncate">{verifyCommand}</span>
        {#if verifyCopied}
          <Check class="size-3.5 shrink-0 text-primary" />
        {:else}
          <Copy class="size-3.5 shrink-0 text-muted-foreground" />
        {/if}
      </button>
      <a
        href="https://github.com/awful-org/awful-verify"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground hover:text-primary hover:underline"
      >
        what this checks, and what it cannot
        <ExternalLink class="size-3" />
      </a>
    </div>
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      Awful.chat is entirely open source, and it is built on open source.
      These are the projects doing the heavy lifting, and they deserve the
      credit.
    </p>
    <OssCredits />
  </div>
{/snippet}

{#snippet DesktopSidebar()}
  <div class="flex flex-col h-full">
    <div class="min-h-0 flex-1 overflow-y-auto">
      {@render TabBar()}
    </div>
    <div class="shrink-0 pt-2 border-t border-border mt-2">
      <Button
        variant="ghost"
        class="w-full font-mono text-xs text-muted-foreground justify-start
          hover:bg-destructive/10! hover:text-destructive!"
        onclick={handleLockLogout}
      >
        <LogOut class="w-4 h-4 mr-2" />
        Lock/Logout
      </Button>
    </div>
  </div>
{/snippet}

{#snippet DesktopContent()}
  <div class="flex flex-row h-full gap-8">
    <div class="hidden sm:flex w-36 h-full">
      {@render DesktopSidebar()}
    </div>
    <div class="min-w-0 min-h-0 flex-1 overflow-y-auto pr-2 pt-4">
      {#if activeTab === "profile"}
        <ProfileSettings
          {isMobile}
          {avatarDialogOpen}
          roomCode={selectedProfileRoom}
          onRoomChange={(room) => (selectedProfileRoom = room)}
          onAvatarClick={() => { avatarPickerRoom = selectedProfileRoom; avatarDialogOpen = true; }}
        />
      {:else if activeTab === "audio"}
        <AudioSettings />
      {:else if activeTab === "app"}
        <AppSettings />
      {:else if activeTab === "session"}
        <SessionSettings {isMobile} {onClose} {onOpenSync} />
      {:else if activeTab === "data"}
        <DataSettings {activeTab} />
      {:else if activeTab === "diagnostics"}
        <DiagnosticsSettings {activeTab} />
      {:else if activeTab === "plugins"}
        <PluginSettings />
      {:else if activeTab === "whatsnew"}
        <WhatsNewSettings />
      {:else if activeTab === "quirks"}
        {@render QuirksTab()}
      {:else if activeTab === "oss"}
        {@render OssTab()}
      {/if}
    </div>
  </div>
{/snippet}

{#if isMobile}
  <Drawer bind:open onOpenChange={closeHandler} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground border-border overflow-hidden" style="height: {visibleHeight * 0.9}px; max-height: {visibleHeight * 0.9}px; bottom: {viewportBottom}px;">
      <DrawerHeader class="shrink-0 px-4 py-2 bg-card">
        <DrawerTitle class="font-mono text-base font-semibold mx-auto"
          >Settings</DrawerTitle
        >
        {@render TabBar()}
      </DrawerHeader>
      <div class="flex min-h-0 flex-1 flex-col w-full overflow-hidden">
        <div class="px-4 py-2 space-y-4 overflow-y-auto min-h-0">
          {#if activeTab === "profile"}
            <ProfileSettings
              {isMobile}
              {avatarDialogOpen}
              roomCode={selectedProfileRoom}
              onRoomChange={(room) => (selectedProfileRoom = room)}
              onAvatarClick={() => { avatarPickerRoom = selectedProfileRoom; avatarDialogOpen = true; }}
            />
          {:else if activeTab === "audio"}
            <AudioSettings />
          {:else if activeTab === "app"}
            <AppSettings />
          {:else if activeTab === "session"}
            <SessionSettings {isMobile} {onClose} {onOpenSync} />
          {:else if activeTab === "data"}
            <DataSettings {activeTab} />
          {:else if activeTab === "diagnostics"}
            <DiagnosticsSettings {activeTab} />
          {:else if activeTab === "plugins"}
            <PluginSettings />
          {:else if activeTab === "whatsnew"}
            <WhatsNewSettings />
          {:else if activeTab === "quirks"}
            {@render QuirksTab()}
          {:else if activeTab === "oss"}
            {@render OssTab()}
          {/if}
        </div>
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog bind:open onOpenChange={closeHandler}>
    <DialogContent
      class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-lg lg:max-w-5xl min-h-0 sm:h-178.75 lg:h-195 flex flex-col overflow-hidden p-0"
      style="max-height: {Math.max(0, visibleHeight - 32)}px; top: {viewportTop + visibleHeight / 2}px;"
    >
      <!-- pr-12 clears the dialog's own close button, absolute at the right. -->
      <DialogHeader class="flex-row items-center justify-between gap-4 px-6 py-4 pr-12 border-b border-border shrink-0">
        <DialogTitle class="font-mono text-base font-semibold"
          >Settings</DialogTitle
        >
        <!-- Every setting is a row in the palette, under ">": a hint, not a
             second search box. Clicking it takes you there. -->
        <button
          type="button"
          onclick={searchInPalette}
          class="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <span>Tip:</span>
          <kbd class="rounded border border-border px-1">{modKey}</kbd><kbd class="rounded border border-border px-1">K</kbd>
          <span>then</span>
          <kbd class="rounded border border-border px-1">&gt;</kbd>
          <span>finds any setting</span>
        </button>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-hidden px-4 pb-4">
        {@render DesktopContent()}
      </div>
    </DialogContent>
  </Dialog>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  scopeKey={avatarPickerRoom}
  value={getScopedProfile(avatarPickerRoom).avatarUrl}
  onSave={(url) => avatarPickerRoom ? saveScopedFields(avatarPickerRoom, { pfpURL: url ?? null }) : saveAvatar(url)}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
