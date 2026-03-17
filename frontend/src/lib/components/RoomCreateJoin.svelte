<script lang="ts">
  import { Check, Clipboard, Copy, LogIn, Plus } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import { profileStore, loadProfile, saveName } from "$lib/profile.svelte";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";

  interface Props {
    onJoin: (roomCode: string, displayName: string, roomName?: string) => void;
    error?: string | null;
  }

  let { onJoin, error = null }: Props = $props();

  let roomName = $state("");
  let joinCode = $state("");
  let createdCode = $state<string | null>(null);
  let copied = $state(false);
  let avatarDialogOpen = $state(false);

  $effect(() => {
    loadProfile();
  });

  async function handleCreate() {
    await saveName(profileStore.nickname);
    const code = Array.from(crypto.getRandomValues(new Uint8Array(3)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    createdCode = code;
    copied = false;
  }

  async function handleJoinCreated() {
    if (!createdCode) return;
    await saveName(profileStore.nickname);
    onJoin(
      createdCode,
      profileStore.nickname || "Anonymous",
      roomName.trim() || undefined
    );
    createdCode = null;
  }

  async function handleJoin() {
    if (!joinCode.trim()) return;
    await saveName(profileStore.nickname);
    onJoin(joinCode.trim(), profileStore.nickname || "Anonymous");
  }

  async function handleCopy(code: string) {
    await navigator.clipboard.writeText(`${window.location.origin}/r/${code}`);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      joinCode = text.trim();
    } catch {
      // clipboard denied
    }
  }

  const initial = $derived(
    (profileStore.nickname || "?").charAt(0).toUpperCase()
  );
</script>

{#if !createdCode}
  <div
    class="flex min-h-screen h-full items-center justify-center p-4 bg-background"
  >
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader>
        <div class="flex items-center justify-between">
          <div>
            <CardTitle class="text-xl font-mono text-foreground"
              >awful.chat</CardTitle
            >
            <CardDescription class="text-xs mt-1 text-muted-foreground">
              Private rooms, peer-to-peer
            </CardDescription>
          </div>
          <div
            class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted text-xs"
          >
            <span class="size-2 rounded-full bg-emerald-500"></span>
            <span class="text-muted-foreground">Connected</span>
          </div>
        </div>
      </CardHeader>

      <CardContent class="grid gap-6">
        {#if error}
          <div
            class="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </div>
        {/if}

        <div class="flex flex-col items-center gap-3">
          <button
            type="button"
            onclick={() => {
              avatarDialogOpen = true;
            }}
            aria-label="Change profile picture"
            class="relative group flex size-30 items-center justify-center rounded-full overflow-hidden bg-primary/20 hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
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
                >{initial}</span
              >
            {/if}
            <div
              class="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <span class="text-white text-xs font-mono">edit</span>
            </div>
          </button>
          <Input
            value={profileStore.nickname}
            oninput={(e) => {
              profileStore.nickname = (e.target as HTMLInputElement).value;
            }}
            placeholder="Your display name"
            class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono text-center focus-visible:ring-ring"
          />
        </div>

        <div class="grid gap-2">
          <Input
            bind:value={roomName}
            placeholder="Room name (optional)"
            class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring"
          />
          <Button
            onclick={handleCreate}
            class="bg-primary hover:bg-primary/90 text-primary-foreground font-mono cursor-pointer"
          >
            <Plus class="size-4 mr-1" />
            Create Room
          </Button>
        </div>

        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <span class="w-full border-t border-border"></span>
          </div>
          <div class="relative flex justify-center text-xs uppercase">
            <span class="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <div class="grid gap-2">
          <div class="relative">
            <Input
              bind:value={joinCode}
              placeholder="Room code"
              class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono pr-10 focus-visible:ring-ring"
            />
            <button
              type="button"
              onclick={handlePaste}
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="Paste room code"
            >
              <Clipboard class="size-4" />
            </button>
          </div>
          <Button
            variant="outline"
            onclick={handleJoin}
            disabled={!joinCode.trim()}
            class="border-border text-muted-foreground hover:text-foreground hover:bg-muted font-mono cursor-pointer disabled:opacity-30"
          >
            <LogIn class="size-4 mr-1" />
            Join Room
          </Button>
        </div>
      </CardContent>
    </Card>
  </div>
{:else}
  <div
    class="flex min-h-screen h-full items-center justify-center p-4 bg-background"
  >
    <Card class="w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader>
        <CardTitle class="font-mono text-foreground">Room created</CardTitle>
        <CardDescription class="text-muted-foreground">
          Share this code with others so they can join.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4">
        <div class="relative rounded-lg bg-muted px-3 py-2">
          <div
            class="text-center font-mono text-sm tracking-widest text-muted-foreground truncate overflow-hidden pr-8"
          >
            {createdCode}
          </div>
          <button
            type="button"
            onclick={() => handleCopy(createdCode!)}
            class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Copy room code"
          >
            {#if copied}
              <Check class="size-4 text-emerald-500" />
            {:else}
              <Copy class="size-4" />
            {/if}
          </button>
        </div>

        <Button
          onclick={handleJoinCreated}
          class="bg-primary hover:bg-primary/90 text-primary-foreground font-mono cursor-pointer w-full"
        >
          <LogIn class="size-4 mr-1" />
          Join Room
        </Button>
      </CardContent>
    </Card>
  </div>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
