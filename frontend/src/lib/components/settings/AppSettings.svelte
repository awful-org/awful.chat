<script lang="ts">
import { Label } from "$lib/components/ui/label";
import { Switch } from "$lib/components/ui/switch";
import {
  notifyState,
  setMessageSoundsEnabled,
  setNotificationsEnabled,
} from "$lib/notify.svelte";
import { mediaPrefs, setGifAutoplay } from "$lib/media-prefs.svelte";
import {
  displayPrefs,
  setCallChatBeside,
  setItalicOwnName,
  setShowConnectionInfo,
  setShowPeerNicknameColors,
  setSidebarCollapsed,
} from "$lib/display-prefs.svelte";
</script>

<div class="flex flex-col gap-6">
<!-- Notifications Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-violet-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Notifications</Label
    >
  </div>
  {#if notifyState.supported}
    <div class="flex items-center justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-xs font-mono">Notify me about new messages</span>
        <span class="text-xs font-mono text-muted-foreground leading-relaxed">
          Only while the app is running and off screen. Nothing can reach you
          once it is fully closed: no server is holding your messages.
        </span>
      </div>
      <Switch
        checked={notifyState.enabled}
        onCheckedChange={(checked) => setNotificationsEnabled(checked)}
      />
    </div>
    {#if notifyState.permission === "denied"}
      <p class="text-xs font-mono text-muted-foreground">
        Your browser is blocking notifications for this site. Allow them in the
        site permissions to turn this on.
      </p>
    {/if}
  {/if}
  <!-- Sounds need no notification permission, so they are not behind the
       supported gate. -->
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Message sounds</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        A soft tone for incoming messages. Stays quiet while you are reading
        that conversation with the window focused.
      </span>
    </div>
    <Switch
      checked={notifyState.soundsEnabled}
      onCheckedChange={(checked) => setMessageSoundsEnabled(checked)}
    />
  </div>
</div>

<!-- Appearance Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-amber-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Appearance</Label
    >
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Auto-play GIFs in chat</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Off shows a still preview that plays while you hover it. Avatars in
        lists always wait for a hover, and in calls they play while that
        person is speaking.
      </span>
    </div>
    <Switch
      checked={mediaPrefs.gifAutoplay}
      onCheckedChange={(checked) => setGifAutoplay(checked)}
    />
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Italicize my name</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Renders your name above your own messages in italics. Only affects
        your view of the chat.
      </span>
    </div>
    <Switch
      checked={displayPrefs.italicOwnName}
      onCheckedChange={(checked) => setItalicOwnName(checked)}
    />
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Show others' nickname colors</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Off keeps every remote name in the default color and hides the
        initials tint. Your own color still shows to you.
      </span>
    </div>
    <Switch
      checked={displayPrefs.showPeerNicknameColors}
      onCheckedChange={(checked) => setShowPeerNicknameColors(checked)}
    />
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Collapse the sidebar</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Shrinks the room list to an icon rail. Cmd or Ctrl + B toggles it too.
        Pinned plugin widgets hide while it is collapsed. No effect on a phone.
      </span>
    </div>
    <Switch
      checked={displayPrefs.sidebarCollapsed}
      onCheckedChange={(checked) => setSidebarCollapsed(checked)}
    />
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Chat beside the call</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        In a call the video sits on the left and the chat is a column on the
        right, instead of a band above the messages. No effect on a phone.
      </span>
    </div>
    <Switch
      checked={displayPrefs.callChatBeside}
      onCheckedChange={(checked) => setCallChatBeside(checked)}
    />
  </div>
</div>

<!-- Debug Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-sky-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Debug</Label
    >
  </div>
  <div class="flex items-center justify-between gap-3">
    <div class="flex flex-col gap-1 min-w-0">
      <span class="text-xs font-mono">Connection &amp; relay indicators</span>
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        Off hides the transport status overlay, the "Relayed" peer badges, the
        sidebar connection dot and the room "Connected" pill. Turn it on to see
        relay and connection state.
      </span>
    </div>
    <Switch
      checked={displayPrefs.showConnectionInfo}
      onCheckedChange={(checked) => setShowConnectionInfo(checked)}
    />
  </div>
</div>
</div>
