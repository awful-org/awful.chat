<script lang="ts">
  /**
   * Discord-style pre-share picker: resolution and frame rate, then the
   * browser's own window chooser. The choice is remembered for next time.
   *
   * The chooser itself cannot be ours: a web page has no way to list
   * screens or windows, only getDisplayMedia's picker can - so this dialog
   * is the one step before it, not a replacement for it.
   *
   * Opened through uiState.sharePickerOpen (see shareScreenPressed in
   * call.svelte): the sidebar, the call view and the palette all share one
   * instance, mounted by SidebarControls in the app and by QuickCall on /qc,
   * which has no sidebar. A page with a share button and neither of those
   * needs its own, or the button does nothing.
   */
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import {
    loadAudioPrefs,
    saveAudioPrefs,
    SHARE_FPS,
    SHARE_HEIGHTS,
    SHARE_CONTENT_HINTS,
    type ShareContentHint,
    type ShareFps,
    type ShareHeight,
  } from "$lib/transport/audio-prefs";
  import { toggleScreenShare } from "$lib/transport/call.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { uiState } from "$lib/ui-state.svelte";

  let height = $state<ShareHeight>(0);
  let fps = $state<ShareFps>(30);
  let contentHint = $state<ShareContentHint>("");

  // Fresh from storage each time it opens: a pick abandoned with Escape
  // must not show up as the saved one next time.
  $effect(() => {
    if (uiState.sharePickerOpen) {
      const p = loadAudioPrefs();
      height = p.shareHeight;
      fps = p.shareFps;
      contentHint = p.shareContentHint;
    }
  });

  const heightLabel = (h: ShareHeight) => (h === 0 ? "Source" : `${h}p`);

  // Same chip as the name-style picker in ProfileSettings.
  const chip = (on: boolean) =>
    `cursor-pointer rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
      on
        ? "border-primary bg-primary/10 text-foreground"
        : "border-border/60 text-muted-foreground hover:border-primary/40"
    }`;

  function share() {
    saveAudioPrefs({ shareHeight: height, shareFps: fps, shareContentHint: contentHint });
    uiState.sharePickerOpen = false;
    // A share that started elsewhere while this sat open must not be toggled
    // off by the button that promises to start one.
    if (transportState.screenSharing) return;
    // Still inside the click: getDisplayMedia needs the user gesture.
    void toggleScreenShare();
  }
</script>

<Dialog bind:open={uiState.sharePickerOpen}>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-md flex flex-col p-0"
  >
    <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
      <DialogTitle class="font-mono text-base font-semibold"
        >Share your screen</DialogTitle
      >
    </DialogHeader>

    <!-- pb only: DialogContent is a grid with gap-4, so a top padding here
         doubles the space under the header. Same as SettingsDialog. -->
    <div class="flex flex-col gap-4 px-4 pb-4">
      <div
        class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
      >
        <div class="flex items-center gap-2">
          <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
          <Label
            class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
            >Resolution</Label
          >
        </div>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Resolution">
          {#each SHARE_HEIGHTS as h (h)}
            <button
              type="button"
              role="radio"
              aria-checked={height === h}
              class={chip(height === h)}
              onclick={() => (height = h)}>{heightLabel(h)}</button
            >
          {/each}
        </div>

        <div class="flex items-center gap-2">
          <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
          <Label
            class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
            >Frame rate</Label
          >
        </div>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Frame rate">
          {#each SHARE_FPS as f (f)}
            <button
              type="button"
              role="radio"
              aria-checked={fps === f}
              class={chip(fps === f)}
              onclick={() => (fps = f)}>{f} fps</button
            >
          {/each}
        </div>

        <div class="flex items-center gap-2">
          <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
          <Label class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
            >Prioritize</Label>
        </div>
        <div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Screen-share priority">
          {#each SHARE_CONTENT_HINTS as hint (hint)}
            <button
              type="button"
              role="radio"
              aria-checked={contentHint === hint}
              class={chip(contentHint === hint)}
              onclick={() => (contentHint = hint)}
              >{hint === "motion" ? "Smoothness" : hint === "detail" ? "Detail" : "Auto"}</button
            >
          {/each}
        </div>
        <p class="text-xs font-mono text-muted-foreground leading-relaxed">
          Smoothness favors motion for games and video; Detail favors sharp
          text and images when bandwidth or CPU is limited. Auto lets the
          browser choose. This is a browser hint, not a quality guarantee.
        </p>
        <p class="text-xs font-mono text-muted-foreground leading-relaxed">
          60 fps is for games and video, 15 fps is plenty for a document.
          Lower both on a weak upload. Remembered for next time.
        </p>
      </div>
    </div>

    <DialogFooter class="px-6 pb-5 pt-3 border-t border-border shrink-0">
      <Button
        class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        disabled={transportState.screenSharePending}
        onclick={share}>Choose what to share</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>
