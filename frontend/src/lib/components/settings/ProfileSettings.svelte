<script lang="ts">
  import { Input } from "$lib/components/ui/input";
import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { profileStore, saveName, saveColor } from "$lib/profile.svelte";
  import { lock } from "$lib/identity/identity.svelte";
  import { Pencil, LogOut } from "@lucide/svelte";

  interface Props {
    isMobile?: boolean;
    avatarDialogOpen?: boolean;
    onAvatarClick?: () => void;
  }

  let { isMobile = false, onAvatarClick }: Props = $props();

  let nameValue = $state("");
  let colorValue = $state("#3b82f6");

  $effect(() => {
    nameValue = profileStore.nickname;
    colorValue = profileStore.color ?? "#3b82f6";
  });

  const profileInitial = $derived(
    (profileStore.nickname || nameValue || "?").charAt(0).toUpperCase()
  );

  async function handleNameBlur() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== profileStore.nickname) {
      await saveName(trimmed);
    }
  }

  function handleLockLogout() {
    lock();
  }
</script>

<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Profile</Label
    >
  </div>

  <div class="flex flex-col gap-3">
    <div class="flex flex-col items-center gap-3">
      <button
        type="button"
        onclick={() => onAvatarClick?.()}
        aria-label="Change avatar"
        class="relative group flex size-20 md:size-36 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer shrink-0"
      >
        {#if profileStore.avatarUrl}
          <img
            src={profileStore.avatarUrl}
            alt="Avatar"
            class="size-full object-cover"
          />
        {:else}
          <span
            class="text-2xl font-semibold text-primary font-mono select-none"
            >{profileInitial}</span
          >
        {/if}
        <div
          class="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Pencil class="text-white" />
        </div>
      </button>
      <Input
        bind:value={nameValue}
        onblur={handleNameBlur}
        onkeydown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        placeholder="Your display name"
        class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring text-center w-full max-w-64 md:max-w-80"
      />

      <div class="flex flex-col gap-2 w-full max-w-64 md:max-w-80">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Nickname color</Label
        >
        <div class="flex items-center gap-2">
          <input
            type="color"
            bind:value={colorValue}
            onchange={() => saveColor(colorValue).catch(() => {})}
            aria-label="Nickname color"
            class="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <span
            class="flex-1 truncate text-sm font-medium font-mono"
            style={profileStore.color
              ? `color: ${profileStore.color}`
              : ""}
            >{profileStore.nickname || "Anonymous"}
            {#if !profileStore.color}(default){/if}</span
          >
          <button
            type="button"
            onclick={() => {
              colorValue = "#3b82f6";
              saveColor(null).catch(() => {});
            }}
            aria-label="Reset nickname color to default"
            class="text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  </div>

  {#if isMobile}
    <Button
      variant="outline"
      class="w-full font-mono text-muted-foreground"
      onclick={handleLockLogout}
    >
      <LogOut class="w-4 h-4 mr-2" />
      Lock/Logout
    </Button>
  {/if}
</div>
