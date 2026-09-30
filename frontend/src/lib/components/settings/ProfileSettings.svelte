<script lang="ts">
  import GifImage from "../GifImage.svelte";
  import { mediaPrefs } from "$lib/media-prefs.svelte";
  import { onDestroy, tick } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import {
    getScopedProfile, hasScopedOverrides, loadRoomProfile, resetScopedProfile,
    saveScopedFields,
    saveName as mainSaveName,
    saveColor as mainSaveColor,
    saveBanner as mainSaveBanner,
    saveTag as mainSaveTag,
    saveTagColors as mainSaveTagColors,
    saveBio as mainSaveBio,
    saveNameEffectFields as mainSaveNameEffectFields,
    saveGradientColors as mainSaveGradientColors,
  } from "$lib/profile.svelte";
  import { roomsStore } from "$lib/rooms.svelte";
  import { roomEditFields, shouldSaveEditedValue } from "./profile-editor";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import { identityStore, lock } from "$lib/identity/identity.svelte";
  import { nameEffectStyle, wireToModel, modelToWire, type NameEffectFill } from "$lib/name-effect";
  import {
    Camera,
    Check,
    Copy,
    LogOut,
    Pencil,
    Plus,
    Trash2,
    Hash,
  } from "@lucide/svelte";

  interface Props {
    isMobile?: boolean;
    avatarDialogOpen?: boolean;
    onAvatarClick?: () => void;
    roomCode?: string | null;
    onRoomChange?: (roomCode: string | null) => void;
  }

  let { isMobile = false, avatarDialogOpen = false, onAvatarClick, roomCode = null, onRoomChange }: Props = $props();
  const scopedProfile = $derived(getScopedProfile(roomCode));
  const joinedRooms = $derived(roomsStore.rooms.filter(r => r.type === "text" && !r.movedTo));
  let saveError = $state("");
  let nameAtStart = "";
  let tagAtStart = "";
  let bioAtStart = "";
  let tagTextColorAtStart: string | undefined;
  let tagChipColorAtStart: string | undefined;
  let switching = $state(false);
  let bannerPickerRoom = $state<string | null>(null);
  let scopeList = $state<HTMLDivElement | null>(null);

  function roomNickname(code: string): string {
    return getScopedProfile(code).nickname || "Anonymous";
  }

  async function saveRoomOrMain(scope: string | null, fields: Record<string, string | boolean | undefined>, mainSave: () => Promise<void>) {
    try {
      if (scope) await saveScopedFields(scope, roomEditFields(fields));
      else await mainSave();
      saveError = "";
    } catch (error) {
      saveError = "Could not save profile. Try again.";
      editing = null;
      throw error;
    }
  }
  const saveName = (v: string, scope = roomCode) => saveRoomOrMain(scope, { nickname: v }, () => mainSaveName(v));
  const saveColor = (v: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { color: v }, () => mainSaveColor(v));
  const saveBanner = (v: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { bannerURL: v }, () => mainSaveBanner(v));
  const saveTag = (v: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { tagText: v?.toUpperCase() }, () => mainSaveTag(v));
  const saveTagColors = (text: string | undefined, chip: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { tagTextColor: text, tagChipColor: chip }, () => mainSaveTagColors(text, chip));
  const saveBio = (v: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { bio: v }, () => mainSaveBio(v));
  const saveNameEffectFields = (effect: string | undefined, shimmer: boolean | undefined, glow: boolean | undefined, scope = roomCode) => saveRoomOrMain(scope, { nameEffect: effect, nameShimmer: shimmer, nameGlow: glow }, () => mainSaveNameEffectFields(effect, shimmer, glow));
  const saveGradientColors = (second: string | undefined, third: string | undefined, scope = roomCode) => saveRoomOrMain(scope, { gradient2: second, gradient3: third }, () => mainSaveGradientColors(second, third));

  async function selectRoom(next: string | null) {
    if (switching || next === roomCode) return;
    switching = true;
    try {
      if (editing === "name") await commitName();
      else if (editing === "tag") await commitTag();
      else if (editing === "bio") await commitBio();
      if (next) await loadRoomProfile(next);
      saveError = "";
      onRoomChange?.(next);
    } catch { /* keep the current scope and visible error */ }
    finally { switching = false; }
  }

  $effect(() => {
    if (roomCode && !joinedRooms.some(r => r.roomCode === roomCode)) onRoomChange?.(null);
  });

  // The dialog can open directly on the room that is currently visible. Load
  // that scope before the editor reads its fields, just as a manual room
  // selection does below.
  $effect(() => {
    if (roomCode && joinedRooms.some(r => r.roomCode === roomCode)) {
      void loadRoomProfile(roomCode);
    }
  });

  // Keep the selected scope visible when Profile opens on a room farther down
  // the list, and when the user changes scope manually.
  $effect(() => {
    const selected = roomCode;
    joinedRooms.length;
    void tick().then(() => {
      const list = scopeList;
      if (!list) return;
      const target = Array.from(
        list.querySelectorAll<HTMLElement>("[data-profile-scope]")
      ).find((element) =>
        selected === null
          ? element.dataset.mainProfile === "true"
          : element.dataset.roomCode === selected
      );
      target?.scrollIntoView({ block: "nearest" });
    });
  });

  let nameValue = $state("");
  let colorValue = $state("#3b82f6");
  let tagText = $state("");
  let tagTextColor = $state("#000000");
  let tagChipColor = $state("#e5e7eb");
  let bio = $state("");
  let nameFill = $state<NameEffectFill>("none");
  let nameShimmer = $state(false);
  let nameGlow = $state(false);

  $effect(() => {
    // Never let a store echo stomp an edit in progress: saveTag() mutates
    // the store mid-commit, which re-ran this sync and reset the color
    // locals to their OLD values before saveTagColors read them.
    if (editing) return;
    nameValue = scopedProfile.nickname;
    colorValue = scopedProfile.color ?? "#3b82f6";
    tagText = scopedProfile.tagText ?? "";
    tagTextColor = scopedProfile.tagTextColor ?? "#000000";
    tagChipColor = scopedProfile.tagChipColor ?? "#e5e7eb";
    bio = scopedProfile.bio ?? "";

    // Convert wire format to model
    const model = wireToModel(
      scopedProfile.nameEffect,
      scopedProfile.nameShimmer,
      scopedProfile.nameGlow
    );
    nameFill = model.fill;
    nameShimmer = model.shimmer;
    nameGlow = model.glow;

    gradient2Value = scopedProfile.gradient2 ?? "#a855f7";
    gradient3Value = scopedProfile.gradient3 ?? null;
  });

  const FILL_OPTIONS = ["none", "gradient", "rainbow"] as const;

  async function pickFill(fill: NameEffectFill) {
    nameFill = fill;
    const wire = modelToWire({ fill, shimmer: nameShimmer, glow: nameGlow });
    await saveNameEffectFields(
      wire.nameEffect === "none" ? undefined : wire.nameEffect,
      wire.nameShimmer,
      wire.nameGlow
    );
    if (fill === "gradient") {
      await saveGradientColors(gradient2Value, gradient3Value ?? undefined);
    }
  }

  async function toggleShimmer() {
    nameShimmer = !nameShimmer;
    const wire = modelToWire({ fill: nameFill, shimmer: nameShimmer, glow: nameGlow });
    await saveNameEffectFields(
      wire.nameEffect === "none" ? undefined : wire.nameEffect,
      wire.nameShimmer,
      wire.nameGlow
    );
  }

  async function toggleGlow() {
    nameGlow = !nameGlow;
    const wire = modelToWire({ fill: nameFill, shimmer: nameShimmer, glow: nameGlow });
    await saveNameEffectFields(
      wire.nameEffect === "none" ? undefined : wire.nameEffect,
      wire.nameShimmer,
      wire.nameGlow
    );
  }

  async function commitGradients() {
    gradientTouched = true;
    await saveGradientColors(gradient2Value, gradient3Value ?? undefined);
  }

  /** The card IS the editor: exactly one piece is in edit mode at a time. */
  let editing = $state<null | "name" | "tag" | "bio">(null);
  let bannerPickerOpen = $state(false);
  let gradient2Value = $state("#a855f7");
  let gradient3Value = $state<string | null>(null);
  let gradient3El = $state<HTMLInputElement | null>(null);
  let addColorEl = $state<HTMLButtonElement | null>(null);
  let nameEditorEl = $state<HTMLElement | null>(null);
  let tagEditorEl = $state<HTMLElement | null>(null);
  let colorTouched = $state(false);
  let gradientTouched = $state(false);

  // Native colour pickers take focus outside the page. That produces a
  // focusout with no destination, but no in-page pointer event. Only a real
  // pointerdown outside this editor is a click-away.
  $effect(() => {
    if (editing !== "name" && editing !== "tag") return;
    const onPointerDown = (e: PointerEvent) => {
      const editor = editing === "name" ? nameEditorEl : tagEditorEl;
      if (!editor) return;
      const target = e.target;
      if (!(target instanceof Node) || editor.contains(target)) return;
      if (editing === "name") void commitName();
      else void commitTag();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  });

  const profileInitial = $derived(
    (scopedProfile.nickname || nameValue || "?").charAt(0).toUpperCase()
  );

  const effectStyle = $derived.by(() => {
    const wire = modelToWire({
      fill: nameFill,
      shimmer: nameShimmer,
      glow: nameGlow,
    });
    return nameEffectStyle(
      wire.nameEffect,
      colorValue,
      gradient2Value,
      gradient3Value ?? undefined,
      wire.nameShimmer,
      wire.nameGlow
    );
  });

  // Closing the dialog or switching tabs mid-edit unmounts this component;
  // whatever was being typed must be saved, not thrown away.
  onDestroy(() => {
    if (editing === "name") void commitName();
    else if (editing === "tag") void commitTag();
    else if (editing === "bio") void commitBio();
  });

  /**
   * Stop a control inside the editor from taking focus off the name input.
   *
   * Cancelling mousedown cancels only the focus shift and the text
   * selection; the click still fires on mouseup. Without it the input blurs,
   * focusout runs its click-away check, and the editor can unmount before
   * the click is delivered.
   */
  function keepFocus(e: MouseEvent) {
    e.preventDefault();
  }

  function focusOnMount(el: HTMLElement) {
    el.focus();
    if (el instanceof HTMLInputElement) el.select();
  }

  async function commitName() {
    const scope = roomCode;
    const trimmed = nameValue.trim();
    if (trimmed && shouldSaveEditedValue(scope, trimmed, nameAtStart, scopedProfile.nickname)) await saveName(trimmed, scope);
    if (colorTouched) {
      const color = colorValue || undefined;
      if (color !== (scopedProfile.color ?? undefined)) await saveColor(color, scope);
    }
    if (gradientTouched) {
      const gradient2 = gradient2Value || undefined;
      const gradient3 = gradient3Value || undefined;
      if (
        gradient2 !== (scopedProfile.gradient2 ?? undefined) ||
        gradient3 !== (scopedProfile.gradient3 ?? undefined)
      ) {
        await saveGradientColors(gradient2, gradient3, scope);
      }
    }
    editing = null;
  }

  async function commitTag() {
    const scope = roomCode;
    // Snapshot before any await - belt to the effect-guard's suspenders.
    const trimmed = tagText.trim();
    const textColor = tagTextColor || undefined;
    const chipColor = tagChipColor || undefined;
    if (shouldSaveEditedValue(scope, trimmed, tagAtStart, scopedProfile.tagText ?? "")) {
      await saveTag(trimmed || undefined, scope);
    }
    if (textColor !== tagTextColorAtStart || chipColor !== tagChipColorAtStart) {
      await saveTagColors(textColor, chipColor, scope);
    }
    editing = null;
  }

  async function commitBio() {
    const scope = roomCode;
    if (shouldSaveEditedValue(scope, bio, bioAtStart, scopedProfile.bio ?? "")) await saveBio(bio || undefined, scope);
    editing = null;
  }



  let copiedDid = $state(false);
  async function copyDid() {
    if (!identityStore.did) return;
    try {
      await navigator.clipboard.writeText(identityStore.did);
      copiedDid = true;
      setTimeout(() => (copiedDid = false), 1200);
    } catch {
      // Clipboard blocked: the did is visible to select by hand.
    }
  }
</script>

<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
    <Label
      class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Profile</Label
    >
  </div>
  <p class="text-xs font-mono text-muted-foreground -mt-2">
    This card is what others see. Click any part of it to change it.
  </p>
  {#if saveError}<p role="alert" class="text-xs text-destructive">{saveError}</p>{/if}

  <div class="flex flex-col items-stretch gap-4 lg:flex-row lg:items-start lg:justify-center">
  <!-- max-w-md, the real card's own width. "What others see" is only true
       if the preview is the same shape: object-cover crops to the box, so a
       preview twice as wide showed a thin band through the middle of a
       banner whose real card shows the whole subject. -->
  <div
    class="relative mx-auto w-full max-w-md rounded-lg border border-border/50 bg-card overflow-hidden"
  >
    <!-- Banner: click to change -->
    <button
      type="button"
      onclick={() => { bannerPickerRoom = roomCode; bannerPickerOpen = true; }}
      aria-label="Change banner"
      class="group relative block h-40 w-full cursor-pointer overflow-hidden bg-linear-to-r from-primary/20 to-secondary/40 sm:h-48"
    >
      {#if scopedProfile.bannerUrl}
        <GifImage
          src={scopedProfile.bannerUrl}
          alt="Profile banner"
          class="h-full w-full object-cover"
          animate={mediaPrefs.gifAutoplay ? true : "hover"}
        />
      {/if}
      <div
        class="pointer-events-none absolute inset-x-0 -bottom-px h-2/3 bg-linear-to-b from-transparent via-card/45 via-60% to-card to-96%"
      ></div>
      <div
        class="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/50 font-mono text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Camera class="size-4" />
        {scopedProfile.bannerUrl ? "Change banner" : "Add a banner"}
      </div>
    </button>
    {#if scopedProfile.bannerUrl}
      <!-- Positioned against the card, not floated up out of the row below
           the banner on an offset that only worked at one banner height. -->
      <button
        type="button"
        onclick={() => saveBanner(undefined)}
        aria-label="Remove banner"
        class="absolute top-2 right-2 z-10 flex size-6 items-center justify-center rounded-full bg-black/60 text-white hover:bg-red-500/80 transition-colors cursor-pointer"
      >
        <Trash2 class="size-3.5" />
      </button>
    {/if}

    <div class="flex flex-col gap-2 p-3">
      <!-- Avatar overlapping the banner: click opens the existing picker -->
      <button
        type="button"
        onclick={() => onAvatarClick?.()}
        aria-label="Change avatar"
        class="group relative -mt-13 flex size-20 items-center justify-center overflow-hidden rounded-full bg-primary/20 ring-4 ring-card cursor-pointer shrink-0"
      >
        {#if scopedProfile.avatarUrl}
          <GifImage
            src={scopedProfile.avatarUrl}
            alt="Avatar"
            class="size-full object-cover"
            animate={mediaPrefs.gifAutoplay ? true : "hover"}
          />
        {:else}
          <span class="font-mono text-lg font-semibold text-primary select-none"
            >{profileInitial}</span
          >
        {/if}
        <div
          class="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Pencil class="size-4 text-white" />
        </div>
      </button>

      <!-- Name + tag row -->
      {#if editing === "name"}
        <!-- Commit when focus leaves the whole EDITOR, pills and gradient
             stops included: with the handler on just the name row, pressing
             an effect pill blurred the input, committed, and unmounted the
             editor before mouseup - the pick never landed. display:contents
             keeps the layout while giving focusout one shared boundary. -->
        <div
          class="contents"
          bind:this={nameEditorEl}
          onfocusout={(e) => {
            if (!(e.target as HTMLElement).isConnected) return;
            const editor = e.currentTarget as HTMLElement;
            const next = e.relatedTarget as Node | null;
            if (next && !editor.contains(next)) void commitName();
          }}
        >
        <div class="flex flex-wrap items-center gap-2">
          <input
            use:focusOnMount
            bind:value={nameValue}
            onkeydown={(e) => {
              if (e.key === "Enter") void commitName();
              if (e.key === "Escape") {
                nameValue = scopedProfile.nickname;
                editing = null;
              }
            }}
            placeholder="Your display name"
            class="w-40 rounded border border-border bg-background px-2 py-1 font-mono text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <!-- Every colour of the name lives in this one row. The gradient
               stops used to sit in a separate section that re-rendered the
               nickname swatch as "Gradient start", so the same value had two
               controls and one of them appeared and vanished as you switched
               effects. Stop one IS the nickname colour; there is nothing to
               duplicate. -->
          <input
            type="color"
            bind:value={colorValue}
            oninput={() => {
              colorTouched = true;
            }}
            onchange={() => {
              colorTouched = true;
              saveColor(colorValue).catch(() => {});
            }}
            aria-label="Nickname color"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          {#if nameFill === "gradient"}
            <input
              type="color"
              bind:value={gradient2Value}
              onchange={commitGradients}
              aria-label="Second gradient color"
              class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
            />
            {#if gradient3Value !== null}
              <input
                type="color"
                bind:this={gradient3El}
                bind:value={gradient3Value}
                onchange={commitGradients}
                aria-label="Third gradient color"
                class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
              />
              <button
                type="button"
                onmousedown={keepFocus}
                onclick={async () => {
                  gradient3Value = null;
                  commitGradients();
                  // The clicked button just unmounted itself; park focus
                  // back inside so the next click-away still commits.
                  await tick();
                  addColorEl?.focus();
                }}
                aria-label="Remove third color"
                class="cursor-pointer font-mono text-xs text-muted-foreground hover:text-destructive"
                >x</button
              >
            {:else}
              <button
                type="button"
                bind:this={addColorEl}
                onmousedown={keepFocus}
                onclick={async () => {
                  gradient3Value = "#22d3ee";
                  commitGradients();
                  await tick();
                  gradient3El?.focus();
                }}
                aria-label="Add a third color"
                class="cursor-pointer rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/60 hover:text-foreground"
                >+ color</button
              >
            {/if}
          {/if}
        </div>

        <!-- Two rows, one label column, one pill shape: the axes read as
             related instead of as a pile of unrelated widgets. The fill row
             is pick-one and the add row is toggles, so the two states are
             drawn differently - a selected fill gets a ring, an active
             modifier gets a solid chip - and every label previews the effect
             it will produce ON TOP of what is already chosen, so "Glow" next
             to a gradient shows a glowing gradient. -->
        <div class="flex flex-col gap-1.5">
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="w-12 shrink-0 font-mono text-[10px] uppercase text-muted-foreground"
              >Fill</span
            >
            {#each FILL_OPTIONS as fill (fill)}
              {@const w = modelToWire({
                fill,
                shimmer: nameShimmer,
                glow: nameGlow,
              })}
              {@const preview = nameEffectStyle(
                w.nameEffect,
                colorValue,
                gradient2Value,
                gradient3Value ?? undefined,
                w.nameShimmer,
                w.nameGlow
              )}
              <button
                type="button"
                onmousedown={keepFocus}
                onclick={() => pickFill(fill)}
                aria-pressed={nameFill === fill}
                class="cursor-pointer rounded-full border px-2.5 py-1 font-mono text-xs capitalize transition-colors {nameFill ===
                fill
                  ? 'border-primary bg-primary/10'
                  : 'border-border/60 hover:border-primary/40'}"
              >
                <span class={preview.class} style={preview.style}>{fill}</span>
              </button>
            {/each}
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <span
              class="w-12 shrink-0 font-mono text-[10px] uppercase text-muted-foreground"
              >Add</span
            >
            {#each [{ key: "shimmer", label: "Shimmer", on: nameShimmer, toggle: toggleShimmer }, { key: "glow", label: "Glow", on: nameGlow, toggle: toggleGlow }] as mod (mod.key)}
              {@const w = modelToWire({
                fill: nameFill,
                shimmer: mod.key === "shimmer" ? true : nameShimmer,
                glow: mod.key === "glow" ? true : nameGlow,
              })}
              {@const preview = nameEffectStyle(
                w.nameEffect,
                colorValue,
                gradient2Value,
                gradient3Value ?? undefined,
                w.nameShimmer,
                w.nameGlow
              )}
              <button
                type="button"
                onmousedown={keepFocus}
                onclick={mod.toggle}
                aria-pressed={mod.on}
                class="cursor-pointer rounded-full border px-2.5 py-1 font-mono text-xs transition-colors {mod.on
                  ? 'border-primary bg-primary/20 text-foreground'
                  : 'border-dashed border-border/60 text-muted-foreground hover:border-primary/40'}"
              >
                <span class={preview.class} style={preview.style}
                  >{mod.label}</span
                >
              </button>
            {/each}
          </div>
        </div>
        </div>
      {:else}
        <div class="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onclick={() => {
              colorTouched = false;
              gradientTouched = false;
              nameAtStart = scopedProfile.nickname;
              editing = "name";
            }}
            aria-label="Edit name, color and effect"
            class="group flex min-w-0 cursor-pointer items-center gap-1.5 {scopedProfile.tagText
              ? 'max-w-[calc(100%-3.5rem)]'
              : 'max-w-full'}"
          >
            <span
              class="min-w-0 truncate text-left font-mono text-base font-semibold {effectStyle.class}"
              style={effectStyle.style ||
                (scopedProfile.color ? `color: ${scopedProfile.color}` : "")}
            >
              {scopedProfile.nickname || "Anonymous"}
            </span>
            <Pencil
              class="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>

          {#if editing !== "tag"}
            {#if scopedProfile.tagText}
              <button
                type="button"
                onclick={() => { tagAtStart = scopedProfile.tagText ?? ""; tagTextColorAtStart = scopedProfile.tagTextColor; tagChipColorAtStart = scopedProfile.tagChipColor; editing = "tag"; }}
                aria-label="Edit tag"
                class="shrink-0 cursor-pointer rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase hover:opacity-80"
                style={`background-color: ${scopedProfile.tagChipColor ?? "#e5e7eb"}; color: ${scopedProfile.tagTextColor ?? "#000000"}`}
              >
                {scopedProfile.tagText}
              </button>
            {:else}
              <button
                type="button"
                onclick={() => { tagAtStart = scopedProfile.tagText ?? ""; tagTextColorAtStart = scopedProfile.tagTextColor; tagChipColorAtStart = scopedProfile.tagChipColor; editing = "tag"; }}
                aria-label="Add a tag"
                class="flex cursor-pointer items-center gap-0.5 rounded border border-dashed border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors"
              >
                <Plus class="size-3" /> tag
              </button>
            {/if}
          {/if}
        </div>
      {/if}

      {#if editing === "tag"}
        <!-- Same rule as the name row: clicking away SAVES. Enter-or-the-
             check-button-only silently discarded a typed tag on blur. -->
        <div
          class="flex flex-wrap items-center gap-2"
          bind:this={tagEditorEl}
          onfocusout={(e) => {
            if (!(e.target as HTMLElement).isConnected) return;
            const row = e.currentTarget as HTMLElement;
            const next = e.relatedTarget as Node | null;
            if (next && !row.contains(next)) void commitTag();
          }}
        >
          <input
            use:focusOnMount
            bind:value={tagText}
            maxlength="5"
            placeholder="2-5 ch"
            onkeydown={(e) => {
              if (e.key === "Enter") commitTag();
              if (e.key === "Escape") {
                tagText = scopedProfile.tagText ?? "";
                editing = null;
              }
            }}
            class="w-20 rounded border border-border bg-background px-2 py-1 text-center font-mono text-xs uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <input
            type="color"
            bind:value={tagTextColor}
            onchange={() =>
              saveTagColors(tagTextColor || undefined, tagChipColor || undefined).catch(() => {})}
            aria-label="Tag text color"
            title="Text"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <input
            type="color"
            bind:value={tagChipColor}
            onchange={() =>
              saveTagColors(tagTextColor || undefined, tagChipColor || undefined).catch(() => {})}
            aria-label="Tag chip color"
            title="Chip"
            class="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
          />
          <span
            class="rounded px-2 py-0.5 font-mono text-xs font-semibold uppercase"
            style={`background-color: ${tagChipColor}; color: ${tagTextColor}`}
          >
            {tagText || "TAG"}
          </span>
          <button
            type="button"
            onclick={commitTag}
            aria-label="Save tag"
            class="cursor-pointer text-muted-foreground hover:text-foreground"
          >
            <Check class="size-4" />
          </button>
          {#if scopedProfile.tagText}
            <button
              type="button"
              onclick={async () => {
                tagText = "";
                await saveTag(undefined);
                editing = null;
              }}
              aria-label="Remove tag"
              class="cursor-pointer text-muted-foreground hover:text-destructive"
            >
              <Trash2 class="size-3.5" />
            </button>
          {/if}
        </div>
      {/if}

      <!-- Bio: click to edit -->
      {#if editing === "bio"}
        <div class="flex flex-col gap-1">
          <textarea
            use:focusOnMount
            bind:value={bio}
            onblur={commitBio}
            onkeydown={(e) => {
              if (e.key === "Escape") {
                bio = scopedProfile.bio ?? "";
                editing = null;
              }
            }}
            maxlength="200"
            placeholder="Tell people something..."
            class="h-20 resize-none rounded border border-border bg-background px-2 py-1.5 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          ></textarea>
          <span class="text-right font-mono text-[10px] text-muted-foreground"
            >{bio.length}/200</span
          >
        </div>
      {:else}
        <button
          type="button"
          onclick={() => { bioAtStart = scopedProfile.bio ?? ""; editing = "bio"; }}
          aria-label="Edit bio"
          class="group block min-h-20 w-full cursor-pointer rounded text-left"
        >
          {#if scopedProfile.bio}
            <span
              class="whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors"
              >{scopedProfile.bio}</span
            >
          {:else}
            <span
              class="font-mono text-xs text-muted-foreground/60 italic group-hover:text-muted-foreground transition-colors"
              >Add a bio...</span
            >
          {/if}
        </button>
      {/if}

      <!-- DID -->
      {#if identityStore.did}
        <div
          class="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5"
        >
          <span
            class="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
            >{identityStore.did}</span
          >
          <button
            type="button"
            onclick={copyDid}
            aria-label="Copy DID"
            class="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground transition-colors"
          >
            {#if copiedDid}
              <Check class="size-3.5 text-primary" />
            {:else}
              <Copy class="size-3.5" />
            {/if}
          </button>
        </div>
      {/if}
    </div>
  </div>

  <aside class="w-full max-w-md rounded-lg border border-border/50 bg-card/70 p-2 lg:w-64 lg:max-w-none">
    <div class="px-2 pb-2 pt-1">
      <p class="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Profile scope</p>
      <p class="mt-1 font-mono text-[11px] text-muted-foreground/70">Choose where this profile appears</p>
    </div>
    <div bind:this={scopeList} class="max-h-80 space-y-1 overflow-y-auto pr-1">
      <button
        type="button"
        data-profile-scope
        data-main-profile="true"
        disabled={switching || bannerPickerOpen || avatarDialogOpen}
        aria-current={roomCode === null ? "true" : undefined}
        onclick={() => void selectRoom(null)}
        class="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors {roomCode === null ? 'border-primary/40 bg-primary/10 text-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground'} disabled:cursor-default"
      >
        <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"><Hash class="size-4" /></span>
        <span class="min-w-0 flex-1 truncate font-mono text-sm">Main Profile</span>
        {#if roomCode === null}<span class="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">✓</span>{/if}
      </button>
      {#each joinedRooms as room (room.roomCode)}
        {@const nickname = roomNickname(room.roomCode)}
        {@const differs = nickname !== getScopedProfile(null).nickname}
        {@const modified = hasScopedOverrides(room.roomCode)}
        <button
          type="button"
          data-profile-scope
          data-room-code={room.roomCode}
          disabled={switching || bannerPickerOpen || avatarDialogOpen}
          aria-current={roomCode === room.roomCode ? "true" : undefined}
          onclick={() => void selectRoom(room.roomCode)}
          class="flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors {roomCode === room.roomCode ? 'border-primary/40 bg-primary/10 text-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground'} disabled:cursor-default"
        >
          {#if room.pfpURL}
            <GifImage src={room.pfpURL} alt="" class="size-8 shrink-0 rounded-md object-cover" />
          {:else}
            <span class="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 font-mono text-xs font-semibold text-primary">{(room.name || "#").charAt(0).toUpperCase()}</span>
          {/if}
          <span class="min-w-0 flex-1">
            <span class="block truncate font-mono text-sm">{room.name || "Unnamed room"}</span>
            {#if differs}<span class="block truncate font-mono text-[10px] {roomCode === room.roomCode ? 'text-primary/70' : 'text-muted-foreground/70'}">{nickname}</span>{/if}
          </span>
          <span class="mt-0.5 flex size-5 shrink-0 translate-y-1.5 items-center justify-center self-start">
            {#if modified}<span class="font-mono text-sm font-bold text-red-400" title="Room profile has custom fields">*</span>{/if}
          </span>
          <span class="flex size-5 shrink-0 items-center justify-center">
            {#if roomCode === room.roomCode}<span class="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">✓</span>{/if}
          </span>
        </button>
      {/each}
    </div>
    {#if roomCode && hasScopedOverrides(roomCode)}
      <Button variant="outline" class="mt-2 w-full border-primary/30 bg-primary/5 text-xs hover:bg-primary/10" onclick={async () => {
        try { await resetScopedProfile(roomCode!); saveError = ""; }
        catch { saveError = "Could not save profile. Try again."; }
      }}>Reset to main profile</Button>
    {/if}
  </aside>
  </div>

  <AvatarPickerDialog
    open={bannerPickerOpen}
    onClose={() => (bannerPickerOpen = false)}
    target="banner"
    scopeKey={bannerPickerRoom}
    value={getScopedProfile(bannerPickerRoom).bannerUrl}
    onSave={(value) => saveBanner(value, bannerPickerRoom)}
  />

  {#if isMobile}
    <Button
      variant="outline"
      class="w-full font-mono text-muted-foreground"
      onclick={() => lock()}
    >
      <LogOut class="w-4 h-4 mr-2" />
      Lock/Logout
    </Button>
  {/if}
</div>
