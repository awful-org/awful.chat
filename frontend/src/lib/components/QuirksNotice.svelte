<script lang="ts">
  import {
    HardDrive,
    KeyRound,
    Send,
    RefreshCw,
    Hash,
    FileDown,
    Server,
    Smartphone,
    BellOff,
    Video,
  } from "@lucide/svelte";

  // Single source of truth for the "how this app behaves" copy. Rendered both
  // in the first-run dialog (IdentitySetup) and the Quirks settings tab.
  const quirks = [
    // The WARNINGS lead: these are the trust decisions in the list.
    {
      icon: Server,
      warn: true,
      title: "Only use an instance you trust",
      body: "The instance hands your browser the app itself, on every visit. A malicious operator can serve modified code - to everyone or just to you - and nothing in a browser can detect that: the source being open lets you verify what is published, never what you were served. End-to-end encryption is only as honest as the code doing the encrypting, so use an instance run by you or by someone you actually trust. Self-hosting is the strong answer.",
    },
    {
      icon: Video,
      warn: true,
      title: "Voice is peer-to-peer, video passes through a server",
      body: "Your messages, files and voice audio all travel straight between peers, never through a server. Camera and screen share are the one exception: they are routed by a media server so bigger calls work, which means that server sees those streams. On a self-hosted instance that server belongs to whoever runs it, and they can access what passes through it, so only turn on your camera or share your screen on an instance you trust.",
    },
    {
      icon: HardDrive,
      title: "Every device is a server, yours included",
      body: "Messages, files and your identity live in this browser's storage, not on a server (the one exception: offline DMs wait encrypted at the relay for up to 48 hours). Clearing site data, private browsing or uninstalling the app erases your copy. That is not always fatal: everyone in a room keeps their own copy, so with your 12 words you can restore your identity, rejoin with the room code and pull history back from peers who are online and still have it. Expect gaps in what comes back, and if everyone in a room wipes their data the conversation is gone for good. Settings > Data can ask the browser to protect this storage from being cleared automatically when space runs low.",
    },
    {
      icon: KeyRound,
      title: "12 words are your account",
      body: "No email, no phone number, no password reset. Your recovery phrase is shown once during setup: store it somewhere outside this device. Lose both the phrase and the device and the account is gone for good. Your password only decrypts that phrase locally, and biometric unlock stays tied to the device you enabled it on.",
    },
    {
      icon: Send,
      title: "DMs are delivered device to device",
      body: "A direct message travels straight between your devices when you are both online. If the other person is offline, an encrypted copy waits at the relay for up to 48 hours and they collect it next time they open the app - the relay only ever sees ciphertext and delivery times, never the content or who sent it. You can turn this off in Settings > Session, and then DMs simply queue until you are both online together. Delivery and read receipts exist in DMs only, not in rooms.",
    },
    {
      icon: RefreshCw,
      title: "Room history comes from whoever is online",
      body: "There is no archive in the cloud. When you join a room or come back to it, you receive the messages held by the peers online at that moment. Anything they do not have arrives later, when someone who kept it shows up.",
    },
    {
      icon: Hash,
      title: "The room code is the invite and the lock",
      body: "Anyone holding a room code can join it. There are no roles, bans or moderation tools yet, so share codes only with people you want in the room.",
    },
    {
      icon: FileDown,
      title: "Files come from other people, not a CDN",
      body: "Attachments move over WebTorrent, directly between people, so a download only progresses while somebody who has that file is online. Downloading also makes you a source: you share it onward, so the more people who keep a copy the faster and more available it gets. Files under 5 MB are stored on this device and shared again automatically after a restart; larger ones are only shared while the app stays open. When the last copy is gone, the file is gone.",
    },
    {
      icon: Smartphone,
      title: "Extra devices need an explicit pairing",
      body: "Signing in elsewhere does not pull your history. Pair devices from Settings > Sync with a QR code, which expires after 5 minutes. Pairing copies what exists at that moment, it is not a continuous cloud sync, and it is best to use one device at a time.",
    },
    {
      icon: BellOff,
      title: "Nothing reaches you while the app is closed",
      body: "There are no push notifications: nothing wakes this device while the app is closed. Offline DMs wait for you (encrypted, at the relay) and room messages wait with your peers, but you only find out about any of it once you open the app and it connects.",
    },
  ];
</script>

<div class="flex flex-col gap-2">
  {#each quirks as quirk (quirk.title)}
    <div
      class="flex gap-3 p-3 rounded-lg border {quirk.warn
        ? 'bg-amber-500/5 border-amber-500/40'
        : 'bg-muted/30 border-border/50'}"
    >
      <quirk.icon
        class="w-4 h-4 mt-0.5 shrink-0 {quirk.warn
          ? 'text-amber-500'
          : 'text-primary'}"
      />
      <div class="flex flex-col gap-1 min-w-0">
        <p class="text-xs font-mono font-semibold text-foreground">
          {quirk.title}
        </p>
        <p class="text-xs font-mono text-muted-foreground leading-relaxed">
          {quirk.body}
        </p>
      </div>
    </div>
  {/each}
</div>
