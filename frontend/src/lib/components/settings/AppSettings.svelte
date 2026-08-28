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
  setChatFontFamily,
  setChatFontSize,
  setItalicOwnName,
  setShowConnectionInfo,
  setShowPeerNicknameColors,
  setSidebarCollapsed,
} from "$lib/display-prefs.svelte";
import { Slider } from "$lib/components/ui/slider";
import { Input } from "$lib/components/ui/input";
import { Button } from "$lib/components/ui/button";
import {
  FONT_STACKS,
  MAX_CHAT_FONT_SIZE,
  MIN_CHAT_FONT_SIZE,
  resolveChatFontStack,
  sanitizeFontFamily,
} from "$lib/chat-font";

/** Three short lines: the desktop dialog is a fixed height, mobile is a drawer. */
const PREVIEW_LINES = [
  { name: "ana", text: "did the relay come back up?" },
  { name: "you", text: "yes — mailbox drained, nothing lost" },
  { name: "kai", text: "0x1f4a9 renders fine at this size 💩" },
] as const;

const previewStack = $derived(resolveChatFontStack(displayPrefs.chatFontFamily));

let customFamily = $state("");
let localFonts = $state<string[]>([]);
let loadingFonts = $state(false);
let fontsError = $state<string | null>(null);

// Feature-detected, not assumed. `queryLocalFonts` is Chromium-on-desktop only:
// Firefox and Safari have never implemented it, and Chrome on Android does not
// either. So the typed field above is the mechanism and this is the shortcut.
//
// Typed here rather than in vite-env.d.ts because that file is a global script,
// where `declare global` cannot augment `Window`, and one call site does not
// justify reshaping the ambient types.
type LocalFont = { family: string };
const queryLocalFonts = (
  globalThis as unknown as {
    queryLocalFonts?: () => Promise<LocalFont[]>;
  }
).queryLocalFonts;
const canQueryLocalFonts = typeof queryLocalFonts === "function";

function applyCustomFamily(): void {
  const safe = sanitizeFontFamily(customFamily);
  if (safe === null) return;
  setChatFontFamily(safe);
  customFamily = "";
}

async function loadLocalFonts(): Promise<void> {
  loadingFonts = true;
  fontsError = null;
  try {
    // MUST run from a click: the API throws SecurityError without a real user
    // gesture, and the first call prompts for permission.
    const faces = await queryLocalFonts!();
    // One entry per FACE, so Menlo Regular/Bold/Italic all report family
    // "Menlo". Dedupe to families, which is what font-family takes.
    const families = [...new Set(faces.map((f) => f.family))]
      .filter((f) => sanitizeFontFamily(f) !== null)
      .sort((a, b) => a.localeCompare(b));
    localFonts = families;
    if (families.length === 0) {
      fontsError = "The browser returned no fonts. Type a name instead.";
    }
  } catch {
    // Denial is a normal answer, not a failure worth a stack trace.
    fontsError = "No permission to list fonts. Type a name instead.";
  } finally {
    loadingFonts = false;
  }
}
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

<!-- Chat text Section -->
<div
  class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
>
  <div class="flex items-center gap-2">
    <div class="w-1 h-4 bg-teal-500 rounded-full"></div>
    <Label
      class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >Chat text</Label
    >
  </div>

  <div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
      <span class="text-xs font-mono text-muted-foreground">Size</span>
      <span class="text-xs font-mono tabular-nums text-green-400"
        >{displayPrefs.chatFontSize}px</span
      >
    </div>
    <Slider
      type="single"
      value={displayPrefs.chatFontSize}
      min={MIN_CHAT_FONT_SIZE}
      max={MAX_CHAT_FONT_SIZE}
      step={1}
      onValueChange={(v) => setChatFontSize(v)}
      class="w-full **:data-[orientation=vertical]:h-full"
    />
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-xs font-mono text-muted-foreground">Font</span>
    <!--
      Each option renders in its own family, so you can see whether a stack
      actually resolved on this machine. That is a better answer than a dropdown
      of names, and it needs no permission prompt.
    -->
    <div class="flex flex-wrap items-center gap-1.5">
      {#each FONT_STACKS as entry (entry.id)}
        <button
          type="button"
          onclick={() => setChatFontFamily(entry.id)}
          style="font-family: {entry.stack}"
          class="cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors {displayPrefs.chatFontFamily ===
          entry.id
            ? 'border-primary bg-primary/10'
            : 'border-border hover:border-primary/40'}"
        >
          {entry.label}
        </button>
      {/each}
    </div>
  </div>

  <div class="flex flex-col gap-2">
    <span class="text-xs font-mono text-muted-foreground"
      >Or name a font installed on this device</span
    >
    <div class="flex items-center gap-2">
      <Input
        value={customFamily}
        placeholder="Consolas, Inter, Comic Sans MS…"
        oninput={(e) => (customFamily = e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === "Enter") applyCustomFamily();
        }}
        class="h-8 text-xs"
      />
      <Button
        variant="outline"
        size="sm"
        class="h-8 shrink-0 text-xs"
        disabled={sanitizeFontFamily(customFamily) === null}
        onclick={applyCustomFamily}
      >
        Use
      </Button>
    </div>
    {#if localFonts.length > 0}
      <!--
        Populated only after a click, because queryLocalFonts needs a real user
        gesture and asks the user's permission.
      -->
      <div class="flex flex-wrap items-center gap-1.5">
        {#each localFonts as family (family)}
          <button
            type="button"
            onclick={() => setChatFontFamily(family)}
            style="font-family: '{family}'"
            class="cursor-pointer rounded-full border px-2.5 py-1 text-xs transition-colors {displayPrefs.chatFontFamily ===
            family
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-primary/40'}"
          >
            {family}
          </button>
        {/each}
      </div>
    {:else if canQueryLocalFonts}
      <Button
        variant="outline"
        size="sm"
        class="h-8 self-start text-xs"
        disabled={loadingFonts}
        onclick={loadLocalFonts}
      >
        {loadingFonts ? "Asking…" : "List my installed fonts"}
      </Button>
    {:else}
      <span class="text-xs font-mono text-muted-foreground leading-relaxed">
        This browser cannot list your fonts, so type the name instead. Any font
        installed on this device works.
      </span>
    {/if}
    {#if fontsError}
      <span class="text-xs font-mono text-destructive">{fontsError}</span>
    {/if}
  </div>

  <!--
    The preview declares the SAME two custom properties the real chat container
    does, so it is structurally identical to production rather than an
    approximation of it. Kept to three short lines: the desktop dialog has a
    fixed height and the mobile path is a bottom drawer.
  -->
  <div
    style="--chat-font-size: {displayPrefs.chatFontSize}px; --chat-font-family: {previewStack}"
    class="rounded-md border border-border bg-background p-3 font-(family-name:--chat-font-family)"
  >
    <div class="flex flex-col gap-1.5">
      {#each PREVIEW_LINES as line (line.name)}
        <div class="flex gap-2">
          <span class="shrink-0 text-xs font-semibold text-primary"
            >{line.name}</span
          >
          <span
            class="text-(length:--chat-font-size) leading-normal text-foreground"
            >{line.text}</span
          >
        </div>
      {/each}
    </div>
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
