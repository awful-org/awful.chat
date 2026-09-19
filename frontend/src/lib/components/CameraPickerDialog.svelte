<script lang="ts">
  /**
   * The camera picker for turning the camera ON mid-call: the same live
   * preview /qc's green room (DeviceCheck) uses before you ever join.
   * Picking a camera here saves it as the default (DeviceCheck.pickCamera
   * already does that), the same way the screen share quality picker
   * remembers its choice. The mic picker is hidden (showMic=false) - a call
   * already has its own mic control, and a second one here is not this
   * dialog's job. The level bar stays, so it still answers "is it hearing
   * me" while you pick a camera.
   *
   * Turning the camera OFF stays a single click - it needs no picker, and
   * this dialog is never involved (see cameraOnPressed in call.svelte).
   *
   * Opened through uiState.cameraPickerOpen: the call view is the only
   * button today, but this is a plain shared flag like sharePickerOpen so
   * a second entry point costs nothing.
   */
  import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import DeviceCheck from "$lib/components/DeviceCheck.svelte";
  import { toggleCamera } from "$lib/transport/call.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { uiState } from "$lib/ui-state.svelte";

  function start() {
    uiState.cameraPickerOpen = false;
    // A camera turned on elsewhere while this sat open must not be toggled
    // off by the button that promises to turn one on.
    if (!transportState.cameraOff) return;
    void toggleCamera();
  }
</script>

<Dialog bind:open={uiState.cameraPickerOpen}>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-sm flex flex-col p-0"
  >
    <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
      <DialogTitle class="font-mono text-base font-semibold"
        >Camera and mic</DialogTitle
      >
    </DialogHeader>

    <div class="flex flex-col gap-3 px-4 pb-4">
      <DeviceCheck open={uiState.cameraPickerOpen} showMic={false} />
    </div>

    <DialogFooter class="px-6 pb-5 pt-3 border-t border-border shrink-0">
      <Button
        class="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        disabled={transportState.cameraPending}
        onclick={start}>Start camera</Button
      >
    </DialogFooter>
  </DialogContent>
</Dialog>
