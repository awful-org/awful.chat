<script lang="ts">
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
  import { viewportHeight } from "$lib/actions/viewport-height";
  import { Button } from "$lib/components/ui/button";
  import { lock } from "$lib/identity.svelte";
  import { LogOut, User, Volume2, RefreshCw, ChartPie } from "@lucide/svelte";

  import ProfileSettings from "./settings/ProfileSettings.svelte";
  import AudioSettings from "./settings/AudioSettings.svelte";
  import SessionSettings from "./settings/SessionSettings.svelte";
  import DataSettings from "./settings/DataSettings.svelte";
  import AvatarPickerDialog from "./AvatarPickerDialog.svelte";

  type SettingsTab = "profile" | "audio" | "session" | "data";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();

  let activeTab = $state<SettingsTab>("profile");
  let avatarDialogOpen = $state(false);
  let isMobile = $state(false);

  const tabs = $state([
    { id: "profile" as SettingsTab, label: "Profile", icon: User },
    { id: "audio" as SettingsTab, label: "Audio", icon: Volume2 },
    { id: "session" as SettingsTab, label: "Session/Sync", icon: RefreshCw },
    { id: "data" as SettingsTab, label: "Data", icon: ChartPie },
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
</script>

{#snippet TabBar()}
  <div
    class="flex flex-row sm:flex-col gap-1 p-1 bg-muted rounded-lg md:h-full"
  >
    {#each tabs as tab}
      <button
        type="button"
        onclick={() => (activeTab = tab.id)}
        class="flex-1 sm:flex-none flex items-center justify-center sm:justify-start gap-2 px-3 py-2 rounded-md text-xs font-mono transition-colors whitespace-nowrap {activeTab ===
        tab.id
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10'}"
      >
        <tab.icon class="w-4 h-4" />
        <span class="hidden sm:inline">{tab.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet DesktopSidebar()}
  <div class="flex flex-col h-full">
    <div class="flex-1">
      {@render TabBar()}
    </div>
    <div class="pt-2 border-t border-border mt-2">
      <Button
        variant="ghost"
        class="w-full font-mono text-xs text-muted-foreground justify-start"
        onclick={handleLockLogout}
      >
        <LogOut class="w-4 h-4 mr-2" />
        Lock / Logout
      </Button>
    </div>
  </div>
{/snippet}

{#snippet DesktopContent()}
  <div class="flex flex-row h-full gap-8">
    <div class="hidden sm:flex w-36 h-full">
      {@render DesktopSidebar()}
    </div>
    <div class="flex-1 overflow-y-auto pr-2 pt-4">
      {#if activeTab === "profile"}
        <ProfileSettings
          {isMobile}
          {avatarDialogOpen}
          onAvatarClick={() => (avatarDialogOpen = true)}
        />
      {:else if activeTab === "audio"}
        <AudioSettings />
      {:else if activeTab === "session"}
        <SessionSettings {isMobile} {onClose} />
      {:else if activeTab === "data"}
        <DataSettings {activeTab} />
      {/if}
    </div>
  </div>
{/snippet}

{#if isMobile}
  <Drawer bind:open onOpenChange={closeHandler} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground border-border">
      <div use:viewportHeight class="flex flex-col w-full">
        <DrawerHeader class="px-4 py-3 border-b border-border shrink-0">
          <DrawerTitle class="font-mono text-base font-semibold mx-auto"
            >Settings</DrawerTitle
          >
        </DrawerHeader>
        <div class="p-4 space-y-4 border-border overflow-y-auto flex-1">
          {@render TabBar()}
          <div class="pt-2">
            {#if activeTab === "profile"}
              <ProfileSettings
                {isMobile}
                onAvatarClick={() => (avatarDialogOpen = true)}
              />
            {:else if activeTab === "audio"}
              <AudioSettings />
            {:else if activeTab === "session"}
              <SessionSettings {isMobile} {onClose} />
            {:else if activeTab === "data"}
              <DataSettings {activeTab} />
            {/if}
          </div>
        </div>
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog bind:open onOpenChange={closeHandler}>
    <DialogContent
      class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-lg lg:max-w-5xl min-h-200 sm:h-137.5 lg:h-150 flex flex-col p-0"
    >
      <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
        <DialogTitle class="font-mono text-base font-semibold"
          >Settings</DialogTitle
        >
      </DialogHeader>
      <div class="flex-1 overflow-hidden px-4 pb-4">
        {@render DesktopContent()}
      </div>
    </DialogContent>
  </Dialog>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
