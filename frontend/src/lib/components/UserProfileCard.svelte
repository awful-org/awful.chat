<script lang="ts">
  import { transportState } from "$lib/transport/transport.svelte";
  import { profileStore } from "$lib/profile.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { nameEffectStyle } from "$lib/name-effect";
  import { Copy, Check, MessageSquare, Pencil, UserPlus, UserRoundMinus, X } from "@lucide/svelte";
  import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";

  interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    did: string;
    name: string;
    avatarUrl?: string;
    color?: string;
    /** Absent = the action is unavailable (self, or peer not connected). */
    onMessage?: () => void;
    onTogglePhonebook?: () => void;
    inPhonebook?: boolean;
    /** Shown on your OWN card only: jumps to profile editing. */
    onEdit?: () => void;
  }

  let {
    open = false,
    onOpenChange,
    did,
    name,
    avatarUrl,
    color,
    onMessage,
    onTogglePhonebook,
    inPhonebook = false,
    onEdit,
  }: Props = $props();

  // Our own metadata never enters peerProfileMeta (that map is fed by the
  // wire); clicking your own row reads the local profile instead.
  const isSelf = $derived(did === identityStore.did);
  const profileMeta = $derived(
    isSelf
      ? {
          bannerUrl: profileStore.bannerUrl ?? undefined,
          tagText: profileStore.tagText ?? undefined,
          tagTextColor: profileStore.tagTextColor ?? undefined,
          tagChipColor: profileStore.tagChipColor ?? undefined,
          bio: profileStore.bio ?? undefined,
          nameEffect: profileStore.nameEffect ?? undefined,
          nameShimmer: profileStore.nameShimmer ?? undefined,
          nameGlow: profileStore.nameGlow ?? undefined,
          gradient2: profileStore.gradient2 ?? undefined,
          gradient3: profileStore.gradient3 ?? undefined,
        }
      : transportState.peerProfileMeta.get(did)
  );

  const effectStyle = $derived(
    nameEffectStyle(
      profileMeta?.nameEffect,
      color,
      profileMeta?.gradient2,
      profileMeta?.gradient3,
      profileMeta?.nameShimmer,
      profileMeta?.nameGlow
    )
  );

  const bannerUrl = $derived(profileMeta?.bannerUrl);
  const tagText = $derived(profileMeta?.tagText);
  const tagTextColor = $derived(profileMeta?.tagTextColor ?? "#000000");
  const tagChipColor = $derived(profileMeta?.tagChipColor ?? "#e5e7eb");
  const bio = $derived(profileMeta?.bio);

  let copied = $state(false);
  async function copyDid() {
    try {
      await navigator.clipboard.writeText(did);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard blocked: nothing to do, the did is visible to select.
    }
  }
</script>

<Dialog {open} onOpenChange={(newOpen) => onOpenChange(newOpen)}>
  <!-- p-0 so the banner can own the top of the card outright. Everything
       below it puts the padding back. -->
  <DialogContent
    class="sm:max-w-md gap-0 overflow-hidden p-0"
    showCloseButton={false}
  >
    <DialogHeader class="sr-only">
      <DialogTitle>Profile</DialogTitle>
    </DialogHeader>

    <!-- Banner always renders (gradient fallback). It runs out to the
         dialog's own edges and up under the close button, and stops at the
         bottom by dissolving into the card rather than ending on a line.
         Inset in its own rounded box it read as a thumbnail OF a banner;
         full bleed it reads as the top of someone's page. -->
    <div class="relative h-40 w-full shrink-0 sm:h-48">
      <div
        class="absolute inset-0 bg-linear-to-r from-primary/20 to-secondary/40"
      ></div>
      {#if bannerUrl}
        <img
          src={bannerUrl}
          alt="Profile banner"
          class="absolute inset-0 size-full object-cover"
        />
      {/if}
      <!-- The dissolve. Tall enough that the avatar sits inside it, so the
           circle looks lit by the banner instead of pasted onto it. -->
      <!-- Two guards against the hairline of un-faded image that showed
           along the bottom: the gradient reaches solid at 96% rather than
           exactly at the edge, and the element overshoots the edge by a
           pixel. Centring the dialog with a 50% translate can leave it on a
           half device pixel, and then the overlay and the image it covers
           round to different rows. -->
      <div
        class="pointer-events-none absolute inset-x-0 -bottom-px h-2/3 bg-linear-to-b from-transparent via-background/45 via-60% to-background to-96%"
      ></div>
    </div>

    <!-- The stock close button is a bare icon in the foreground colour, which
         is a coin flip against an arbitrary photo. This one brings its own
         backdrop. -->
    <DialogClose
      class="absolute top-3 right-3 z-20 grid size-7 cursor-pointer place-items-center rounded-full bg-black/40 text-white/90 backdrop-blur-sm transition hover:bg-black/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-hidden"
    >
      <X class="size-4" />
      <span class="sr-only">Close</span>
    </DialogClose>

    <!-- relative, not just padding: the banner above is positioned and this
         was not, so it painted in the layer beneath it and the banner covered
         the avatar that is meant to overlap it. -->
    <div class="relative z-10 flex flex-col gap-3 px-6 pb-6">
      <div
        class="-mt-10 ml-3 flex size-20 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-4 ring-background shrink-0"
      >
        {#if avatarUrl}
          <img
            src={avatarUrl}
            alt={name}
            class="size-full object-cover"
          />
        {:else}
          <span
            class="text-2xl font-semibold text-primary font-mono select-none"
          >
            {(name || "?").charAt(0).toUpperCase()}
          </span>
        {/if}
      </div>

      <div class="flex min-w-0 items-center justify-start gap-2 px-1 text-left">
        <span
          class="w-0 min-w-0 flex-1 truncate text-left text-lg font-mono font-semibold {effectStyle.class}"
          style={effectStyle.style || (color ? `color: ${color}` : "")}
        >
          {name}
        </span>
        {#if tagText}
          <div
            class="shrink-0 rounded px-2 py-1 text-xs font-mono font-semibold uppercase"
            style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
          >
            {tagText}
          </div>
        {/if}
      </div>

      {#if isSelf && onEdit}
        <div class="flex items-center px-1">
          <button
            type="button"
            onclick={() => {
              onOpenChange(false);
              onEdit?.();
            }}
            class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 font-mono text-xs text-foreground hover:bg-muted transition-colors"
          >
            <Pencil class="size-3.5" />
            Edit profile
          </button>
        </div>
      {/if}

      {#if !isSelf && (onMessage || onTogglePhonebook)}
        <div class="flex items-center gap-2 px-1">
          {#if onMessage}
            <button
              type="button"
              onclick={onMessage}
              class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <MessageSquare class="size-3.5" />
              Message
            </button>
          {/if}
          {#if onTogglePhonebook}
            <button
              type="button"
              onclick={onTogglePhonebook}
              class="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 font-mono text-xs transition-colors {inPhonebook
                ? 'border-destructive/40 text-destructive hover:bg-destructive/10'
                : 'border-border text-foreground hover:bg-muted'}"
            >
              {#if inPhonebook}
                <UserRoundMinus class="size-3.5" />
                Remove contact
              {:else}
                <UserPlus class="size-3.5" />
                Add to phonebook
              {/if}
            </button>
          {/if}
        </div>
      {/if}

      {#if bio}
        <div class="px-1 text-sm text-muted-foreground whitespace-pre-wrap break-words">
          {bio}
        </div>
      {/if}

      <div
        class="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
      >
        <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {did}
        </span>
        <button
          type="button"
          onclick={copyDid}
          aria-label="Copy DID"
          class="shrink-0 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        >
          {#if copied}
            <Check class="size-3.5 text-primary" />
          {:else}
            <Copy class="size-3.5" />
          {/if}
        </button>
      </div>
    </div>
  </DialogContent>
</Dialog>
