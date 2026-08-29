<script lang="ts">
  import { tick } from "svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { ReplyTo } from "$lib/types/message";
  import { MessageType } from "$lib/types/message";
  import {
    LogOut,
    Menu,
    Phone,
    Send,
    Users,
    Copy,
    Check,
    ImagePlay,
    ChevronUp,
    Smile,
    Reply,
    X,
    Paperclip,
    FileText,
    ArrowDown,
    UserPlus,
    UserRoundMinus,
    Trash2,
    Angry,
    Annoyed,
    Laugh,
    Meh,
    Frown,
    Baby,
    Dog,
    Skull,
    Ghost,
    Cat,
    Bot,
    PartyPopper,
    Heart,
    Star,
    ChessQueen,
    ThumbsUp,
    CornerUpLeft,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Tip } from "$lib/components/ui/tooltip";
  import { Separator } from "$lib/components/ui/separator";
  import VoiceVideoCallView from "./VoiceVideoCallView.svelte";
  import MsgRender from "./MsgRender.svelte";
  import GifPicker from "./GifPicker.svelte";
  import GifImage from "./GifImage.svelte";
  import EmojiPickerPopup from "./EmojiPickerPopup.svelte";
  import MentionInput from "./MentionInput.svelte";
  import UserListSidebar from "./UserListSidebar.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import { resolveChatFontStack } from "$lib/chat-font";
  import { nameEffectStyle } from "$lib/name-effect";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import {
    transportState,
    sendMessage,
    selfId,
    isSelfSender,
    peerId as myPeerId,
    didToPeerId,
    peerIdToDid,
    sendReply,
    sendFiles,
    toggleReaction,
    loadMoreMessages,
    markSeen,
    requestFileDownload,
    resolveMentionDisplayName,
  } from "$lib/transport/transport.svelte";
  import { humanizeMentions } from "$lib/mentions";
  import { roomsStore, refreshPhonebook } from "$lib/rooms.svelte";
  import { formatReactorNames } from "$lib/reaction-names";
  import {
    addToPhonebook,
    openDmPanel,
    removeFromPhonebook,
  } from "$lib/transport/dm.svelte";
  import { joinCall } from "$lib/transport/call.svelte";
  import {
    buildMentionCandidates,
    mentionsMe,
    segmentDraft,
    serialize,
  } from "$lib/mentions";
  import { makeHostApi } from "$lib/plugins/host";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import UserProfileCard from "./UserProfileCard.svelte";
  import { openSettings, requestReturnToCall } from "$lib/ui-state.svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { getRegistry, getPlugin } from "$lib/plugins/registry";
  import { isPluginEnabled } from "$lib/plugins/prefs.svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { seededRandom } from "$lib/utils";
  import { getQuotableText } from "$lib/quote-helper";
  import { createInvite, formatShortCode } from "$lib/invite";

  $effect(() => {
    loadProfile();
  });

  interface Props {
    roomCode: string;
    roomName: string;
    selfId: string;
    onLeave: () => void;
    onOpenSidebar?: () => void;
    onOpenDm?: (peerId: string) => Promise<void> | void;
    incomingSharedFiles?: File[];
    incomingSharedText?: string;
    onConsumeIncomingShared?: () => void;
  }

  let {
    roomCode,
    roomName,
    onLeave,
    onOpenSidebar,
    onOpenDm,
    incomingSharedFiles = [],
    incomingSharedText = "",
    onConsumeIncomingShared,
  }: Props = $props();

  // Reset scroll state when room changes
  $effect(() => {
    roomCode;
    initialScrollDone = false;
    autoScroll = true;
    // hasMoreHistory too. This component is not keyed by room, so switching
    // rooms does not remount it: paging to the top of one room set this false
    // and every other room then opened with no way to page back for the rest
    // of the session.
    hasMoreHistory = true;
  });

  let {
    peers,
    roomUsers,
    messages,
    inCall,
    callRoomCode,
    callPeerIds,
    callPeerRooms,
    peerNames,
    peerAvatars,
    peerColors,
    peerProfileMeta,
    fileTransfers,
    connecting,
  } = $derived(transportState);

  const peersInThisRoom = $derived(
    [...callPeerIds].filter((peerId) => callPeerRooms.get(peerId) === roomCode)
  );

  const showCallView = $derived(
    (inCall && callRoomCode === roomCode) || peersInThisRoom.length > 0
  );
  let showUserList = $state(false);

  let draft = $state("");
  let commandPopupOpen = $state(false);
  let commandSelectedIndex = $state(0);
  let commandHint = $state<string | null>(null);
  let commandHintTimer: ReturnType<typeof setTimeout> | undefined;
  let mentionPopupOpen = $state(false);
  let mentionPrefix = $state("");
  let mentionSelectedIndex = $state(0);
  /**
   * Names the user picked from the popup this draft, mapped to dids. Reactive
   * because the composer highlight is derived from it - a plain Map would
   * leave a freshly picked mention unhighlighted until the next keystroke.
   */
  const draftMentionMap = new SvelteMap<string, string>();
  let replyTargetId = $state<string | null>(null);
  let reactionPickerFor = $state<string | null>(null);
  let reactionAnchor = $state<DOMRect | null>(null);
  let composerEmojiOpen = $state(false);
  // Idle toy: each hover of the emoji button steps to the next icon, and it
  // STAYS there until the next hover. Deliberately not persisted - a refresh
  // starts back at Smile.
  const emojiCycle = [
    Smile,
    Angry,
    Annoyed,
    Laugh,
    Meh,
    Frown,
    Baby,
    Dog,
    Skull,
    Ghost,
    Cat,
    Bot,
    PartyPopper,
    Heart,
    Star,
    ChessQueen,
    ThumbsUp,
  ];
  let emojiCycleIdx = $state(0);
  let composerEmojiAnchor = $state<DOMRect | null>(null);
  let gifPickerOpen = $state(false);
  let hasMoreHistory = $state(true);
  let loadingMore = $state(false);
  let activeMessageId = $state<string | null>(null);
  let stagedFiles = $state<File[]>([]);
  // Names of files between "Enter pressed" and "message echoed" - hashing
  // for seeding happens in that window and it is silent otherwise.
  let sendingFiles = $state<string[]>([]);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let dragOverlayActive = $state(false);
  let dragDepth = $state(0);
  let stagedPreviewUrls = $state(new Map<string, string>());
  const stagedFileFingerprints = new Map<string, string>();

  type SwipeDirection = "undecided" | "horizontal" | "vertical";
  let swipeStartX = $state(0);
  let swipeStartY = $state(0);
  let swipeCurrentX = $state(0);
  let swipeMessageId = $state<string | null>(null);
  let isSwiping = $state(false);
  let swipeDirection: SwipeDirection = $state("undecided");
  const SWIPE_THRESHOLD = 25;
  const SWIPE_DEADZONE = 15;
  const SWIPE_DIRECTION_RATIO = 1.25;

  let isMobile = $state(false);
  let messagesEl = $state<HTMLDivElement | null>(null);
  let textareaEl = $state<HTMLTextAreaElement | null>(null);
  let copied = $state(false);
  let autoScroll = $state(true);
  // Tracks whether the initial scroll-to-bottom on mount has happened
  let initialScrollDone = $state(false);
  let userMenu = $state<{
    peerId: string | null;
    senderId: string;
    x: number;
    y: number;
  } | null>(null);

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

  // Allowlist, not a blocklist: history sync stores any verified message
  // regardless of type, so a build that predates a future message type (the
  // plugin surface is the planned case) would otherwise render its raw
  // content as a chat line. Shipping this ahead of that surface means stale
  // tabs hide unknown types instead of showing JSON.
  const RENDERABLE_TYPES = new Set<string>([
    MessageType.Text,
    MessageType.Reply,
    MessageType.File,
    MessageType.PluginCard,
  ]);
  // The roomCode check is the backstop for switch races: writes that land in
  // the shared array mid-switch (a sync batch for the room being left, a live
  // append during the open's awaits) must never RENDER in the wrong
  // conversation, whatever the transport layer let through.
  const visibleMessages = $derived(
    messages.filter(
      (m) => RENDERABLE_TYPES.has(m.type) && m.roomCode === roomCode
    )
  );

  const messageById = $derived(new Map(visibleMessages.map((m) => [m.id, m])));

  const replyTarget = $derived(
    replyTargetId ? (messageById.get(replyTargetId) ?? null) : null
  );

  const reactionsByMessage = $derived.by(() => {
    const byMessage = new Map<string, Map<string, Set<string>>>();
    for (const m of messages) {
      if (m.type !== MessageType.Reaction || !m.reactionTo || !m.reactionEmoji)
        continue;
      if (!byMessage.has(m.reactionTo)) byMessage.set(m.reactionTo, new Map());
      const byEmoji = byMessage.get(m.reactionTo)!;
      if (!byEmoji.has(m.reactionEmoji))
        byEmoji.set(m.reactionEmoji, new Set());
      const users = byEmoji.get(m.reactionEmoji)!;
      // Normalize to the DID: a reaction added before the sender's binding
      // was known (peerId form) must cancel against one added after.
      const reactor = senderDid(m.senderId) || m.senderId;
      if (m.reactionOp === "remove") users.delete(reactor);
      else users.add(reactor);
    }
    return byMessage;
  });

  function scrollToBottom(behavior: ScrollBehavior = "instant") {
    if (!messagesEl) return;
    messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior });
  }

  function handleScroll() {
    if (!messagesEl) return;
    const { scrollHeight, scrollTop, clientHeight } = messagesEl;
    // "At the bottom" within 120px: the old 40px meant stopping half a
    // message short of the end - one flick of momentum scroll on mobile -
    // silently stopped the view from following new arrivals.
    autoScroll = scrollHeight - scrollTop - clientHeight < 120;
    // Reaching the top fetches the next page - the button alone was gated on
    // 50+ VISIBLE messages, and a page full of invisible rows (reactions,
    // plugin updates) kept the count below that forever: two weeks of
    // history with no way to scroll to it.
    if (
      scrollTop < 80 &&
      initialScrollDone &&
      hasMoreHistory &&
      !loadingMore
    ) {
      void loadOlderPreservingScroll();
    }
  }

  /** Prepending grows the container upward; without compensation the view
   *  jumps to the oldest loaded message and re-triggers the top fetch. */
  async function loadOlderPreservingScroll() {
    if (!messagesEl) return;
    const prevHeight = messagesEl.scrollHeight;
    const prevTop = messagesEl.scrollTop;
    await handleLoadMore();
    await tick();
    if (messagesEl) {
      messagesEl.scrollTop = prevTop + (messagesEl.scrollHeight - prevHeight);
    }
  }

  $effect(() => {
    if (initialScrollDone || !messagesEl || visibleMessages.length === 0)
      return;
    requestAnimationFrame(() => {
      scrollToBottom();
      initialScrollDone = true;
    });
  });

  // Scroll on new messages if autoScroll is enabled
  $effect(() => {
    visibleMessages.length;
    if (!initialScrollDone) return;
    if (autoScroll && messagesEl) {
      setTimeout(() => scrollToBottom(), 0);
    }
  });

  // Scroll when keyboard opens/closes (visualViewport resize)
  $effect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const onResize = () => {
      if (autoScroll) setTimeout(() => scrollToBottom(), 0);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  });

  // Scroll when images/other content load and change scroll height
  $effect(() => {
    if (!messagesEl || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (autoScroll) {
        requestAnimationFrame(() => scrollToBottom());
      }
    });
    observer.observe(messagesEl, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  /** Enabled plugin commands matching the draft's "/prefix". */
  const filteredCommands = $derived.by(() => {
    if (!commandPopupOpen) return [];
    const m = draft.match(/^\/([a-z0-9-]*)$/);
    if (!m) return [];
    const prefix = m[1];
    const out: Array<{ name: string; usage: string; icon: string }> = [];
    for (const [pluginId, registered] of getRegistry()) {
      if (!isPluginEnabled(pluginId)) continue;
      for (const cmd of registered.manifest.commands ?? []) {
        if (cmd.name.startsWith(prefix)) {
          out.push({ ...cmd, icon: registered.manifest.icon });
        }
      }
    }
    return out;
  });

  function updateCommandState() {
    // Only a lone "/word" at the start of the draft is a command in
    // progress; anything after a space is prose.
    commandPopupOpen = /^\/[a-z0-9-]*$/.test(draft);
    commandSelectedIndex = 0;
    if (commandHint) commandHint = null;
  }

  function selectCommand(cmd: { name: string; usage: string }) {
    draft = `/${cmd.name} `;
    commandPopupOpen = false;
    requestAnimationFrame(() => {
      textareaEl?.focus();
      if (textareaEl) {
        textareaEl.selectionStart = textareaEl.selectionEnd = draft.length;
      }
    });
  }

  function handleCommandKeydown(e: KeyboardEvent) {
    if (!commandPopupOpen || filteredCommands.length === 0) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      commandSelectedIndex = Math.max(0, commandSelectedIndex - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      commandSelectedIndex = Math.min(
        filteredCommands.length - 1,
        commandSelectedIndex + 1
      );
    } else if (e.key === "Tab") {
      e.preventDefault();
      selectCommand(filteredCommands[commandSelectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commandPopupOpen = false;
    }
  }

  /**
   * What the composer highlights. It runs the same tokenizer the wire
   * serializer uses, so the chips mark exactly the text that will ship as a
   * signed @[did] token - a hand-typed @Name stays plain, and breaking a
   * picked name un-highlights it immediately.
   */
  const draftSegments = $derived(segmentDraft(draft, draftMentionMap));

  /**
   * `roomUsers` is DID-keyed and seeded on join from the persisted participant
   * list, and `peerNames` is seeded from stored peer profiles, so an offline
   * member is still mentionable by name. The selection rules live in
   * `mentions.ts` because they are testable there and this file is not.
   */
  const mentionCandidates = $derived(
    buildMentionCandidates({
      roomUsers,
      peers,
      toDid: senderDid,
      nameOf: (id) => peerNames.get(id),
      selfIds: [identityStore.did ?? "", selfId(), myPeerId()],
    }),
  );

  const filteredMembersForMention = $derived.by(() => {
    if (!mentionPopupOpen) return [];
    const lower = mentionPrefix.toLowerCase();
    if (!lower) return mentionCandidates;
    return mentionCandidates.filter((m) =>
      m.name.toLowerCase().includes(lower),
    );
  });

  function updateMentionState() {
    if (!textareaEl) return;
    const cursor = textareaEl.selectionStart;
    const before = draft.slice(0, cursor);
    const at = before.lastIndexOf("@");
    // Only an @ at the start or after whitespace opens the popup - emails
    // and mid-word @s must not.
    if (at === -1 || (at > 0 && !/\s/.test(before[at - 1]))) {
      mentionPopupOpen = false;
      return;
    }
    const prefix = before.slice(at + 1);
    if (/[\s]/.test(prefix)) {
      mentionPopupOpen = false;
      return;
    }
    mentionPrefix = prefix;
    mentionSelectedIndex = 0;
    mentionPopupOpen = true;
  }

  function selectMentionMember(member: { did: string; name: string }) {
    if (!textareaEl) return;
    const cursor = textareaEl.selectionStart;
    const beforeText = draft.slice(0, cursor);
    const at = beforeText.lastIndexOf("@");
    draft = `${draft.slice(0, at)}@${member.name} ${draft.slice(cursor)}`;
    draftMentionMap.set(member.name, member.did);
    mentionPopupOpen = false;
    mentionPrefix = "";
    requestAnimationFrame(() => {
      if (!textareaEl) return;
      const pos = at + member.name.length + 2;
      textareaEl.selectionStart = textareaEl.selectionEnd = pos;
      textareaEl.focus();
      autoResize();
    });
  }

  function handleMentionKeydown(e: KeyboardEvent) {
    if (!mentionPopupOpen || filteredMembersForMention.length === 0) return;
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mentionSelectedIndex = Math.max(0, mentionSelectedIndex - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      mentionSelectedIndex = Math.min(
        filteredMembersForMention.length - 1,
        mentionSelectedIndex + 1
      );
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      selectMentionMember(filteredMembersForMention[mentionSelectedIndex]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      mentionPopupOpen = false;
    }
  }

  function messageIsMentioningMe(msg: Message): boolean {
    return mentionsMe(msg.content ?? "", [selfId(), myPeerId()]);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (commandPopupOpen) {
      handleCommandKeydown(e);
      if (e.defaultPrevented) return;
    }
    if (mentionPopupOpen) {
      handleMentionKeydown(e);
      if (e.defaultPrevented) return;
    }
    if (e.key === "Escape" && stagedFiles.length > 0) {
      e.preventDefault();
      clearStagedFiles();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  async function submit() {
    const text = draft.trim();
    if (!text && stagedFiles.length === 0) return;

    // Check for slash commands
    const slashMatch = text.match(/^\/([a-z0-9-]+)\s?(.*)$/);
    if (slashMatch) {
      const [, commandName, args] = slashMatch;
      const registry = getRegistry();
      let found = false;

      for (const [pluginId, registered] of registry) {
        if (!isPluginEnabled(pluginId)) continue;
        const plugin = await getPlugin(pluginId);
        if (!plugin || !plugin.commands || !(commandName in plugin.commands))
          continue;

        found = true;
        const handler = plugin.commands[commandName];
        const hostApi: HostApi = makeHostApi(pluginId, roomCode);

        try {
          await handler(args, hostApi);
          draft = "";
          replyTargetId = null;
          autoScroll = true;
          requestAnimationFrame(() => {
            autoResize();
            textareaEl?.focus();
          });
        } catch (err) {
          console.error(`[chat] command /${commandName} failed:`, err);
        }
        return;
      }

      if (!found) {
        commandHint = `Unknown command /${commandName} - type / to see what is available`;
        // Typing clears it too, but a hint left alone must fade by itself.
        clearTimeout(commandHintTimer);
        commandHintTimer = setTimeout(() => (commandHint = null), 5000);
        return;
      }
    }

    // Mentions ride the wire as signed @[did] tokens; the input kept names.
    const wireText = serialize(text, draftMentionMap);

    if (stagedFiles.length > 0) {
      sendingFiles = stagedFiles.map((f) => f.name);
      sendFiles(stagedFiles, wireText, {
        replyTo: replyTarget
          ? {
              id: replyTarget.id,
              senderName: displayName(replyTarget),
              content: getQuotableText(replyTarget),
            }
          : undefined,
      }).finally(() => {
        sendingFiles = [];
      });
      clearStagedFiles();
    } else if (replyTarget) {
      sendReply(wireText, replyTarget);
    } else {
      sendMessage(wireText);
    }

    draft = "";
    replyTargetId = null;
    draftMentionMap.clear();
    mentionPopupOpen = false;
    autoScroll = true;
    // The composer grew with the multiline draft; clearing the value does
    // not fire input, so shrink it back explicitly.
    requestAnimationFrame(() => {
      autoResize();
      textareaEl?.focus();
    });
  }

  function startReply(msg: Message) {
    replyTargetId = msg.id;
    reactionPickerFor = null;
    requestAnimationFrame(() => textareaEl?.focus());
  }

  function openReactionPicker(msgId: string, trigger: HTMLElement) {
    reactionAnchor = trigger.getBoundingClientRect();
    reactionPickerFor = msgId;
  }

  /** Drop an emoji in at the caret, replacing any selection. */
  function insertEmoji(emoji: string) {
    const el = textareaEl;
    if (!el) {
      draft += emoji;
      return;
    }
    const start = el.selectionStart;
    const end = el.selectionEnd;
    draft = draft.slice(0, start) + emoji + draft.slice(end);
    // The value lands on the next flush, so the caret has to wait for it.
    requestAnimationFrame(() => {
      if (!textareaEl) return;
      const caret = start + emoji.length;
      textareaEl.focus();
      textareaEl.setSelectionRange(caret, caret);
      autoResize();
    });
  }

  function jumpToMessage(messageId: string) {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el || !messagesEl) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-1", "ring-primary/60", "bg-primary/5");
    setTimeout(() => {
      el.classList.remove("ring-1", "ring-primary/60", "bg-primary/5");
    }, 900);
  }

  function sendOrReplyWithMessage(content: string): void {
    // Send a message (text or URL) with reply context if set. Mirrors the
    // reply branching logic from submit() so GIF selections preserve reply targets.
    if (replyTarget) {
      sendReply(content, replyTarget);
    } else {
      sendMessage(content);
    }
    // Clear reply state exactly as submit() does.
    replyTargetId = null;
    autoScroll = true;
  }

  function handleGifSelect(url: string) {
    sendOrReplyWithMessage(url);
  }

  function handleGifFileSelect(file: File) {
    // A saved uploaded gif re-enters as a fresh file send: re-seeded, and
    // inlined into the message when small enough.
    sendingFiles = [file.name];
    sendFiles([file], "", {
      replyTo: replyTarget
        ? {
            id: replyTarget.id,
            senderName: displayName(replyTarget),
            content: getQuotableText(replyTarget),
          }
        : undefined,
    })
      .catch(() => {})
      .finally(() => {
        sendingFiles = [];
        // Clear reply state exactly as submit() does.
        replyTargetId = null;
        autoScroll = true;
      });
  }

  async function handleLoadMore() {
    if (loadingMore || !hasMoreHistory || messages.length === 0) return;
    loadingMore = true;
    const oldest = messages[0].lamport;
    const more = await loadMoreMessages(oldest);
    hasMoreHistory = more;
    loadingMore = false;
  }

  function fileKey(file: File): string {
    return `${file.name}:${file.size}:${file.lastModified}`;
  }

  async function fingerprintFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function addFilesToStage(files: FileList | File[]) {
    const incoming = Array.from(files);
    if (!incoming.length) return;

    const dedup = new Map(stagedFiles.map((file) => [fileKey(file), file]));
    const existingFingerprints = new Set<string>();

    for (const file of stagedFiles) {
      const key = fileKey(file);
      let fp = stagedFileFingerprints.get(key);
      if (!fp) {
        fp = await fingerprintFile(file);
        stagedFileFingerprints.set(key, fp);
      }
      existingFingerprints.add(fp);
    }

    for (const file of incoming) {
      const key = fileKey(file);
      const fp = await fingerprintFile(file);
      if (existingFingerprints.has(fp)) continue;
      existingFingerprints.add(fp);
      stagedFileFingerprints.set(key, fp);
      dedup.set(key, file);
    }

    stagedFiles = [...dedup.values()];
    dragOverlayActive = false;
    dragDepth = 0;
  }

  function removeStagedFile(target: File) {
    const key = fileKey(target);
    stagedFiles = stagedFiles.filter((file) => fileKey(file) !== key);

    const url = stagedPreviewUrls.get(key);
    if (url) {
      URL.revokeObjectURL(url);
      const map = new Map(stagedPreviewUrls);
      map.delete(key);
      stagedPreviewUrls = map;
    }
    stagedFileFingerprints.delete(key);
  }

  function clearStagedFiles() {
    for (const url of stagedPreviewUrls.values()) {
      URL.revokeObjectURL(url);
    }
    stagedPreviewUrls = new Map();
    stagedFiles = [];
    stagedFileFingerprints.clear();
    if (fileInputEl) fileInputEl.value = "";
  }

  function isPreviewable(file: File): boolean {
    return file.type.startsWith("image/") || file.type.startsWith("video/");
  }

  function getStagedPreviewURL(file: File): string | null {
    if (!isPreviewable(file)) return null;
    return stagedPreviewUrls.get(fileKey(file)) ?? null;
  }

  function formatSize(size: number): string {
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    if (size < 1024 * 1024 * 1024)
      return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  function hasFilesInDataTransfer(dt: DataTransfer | null): boolean {
    if (!dt) return false;
    if (dt.items && dt.items.length > 0)
      return Array.from(dt.items).some((item) => item.kind === "file");
    if (dt.files && dt.files.length > 0) return true;
    return Array.from(dt.types).includes("Files");
  }

  function handleRootDragEnter(e: DragEvent) {
    if (!hasFilesInDataTransfer(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth += 1;
    dragOverlayActive = true;
  }

  function handleRootDragOver(e: DragEvent) {
    if (!hasFilesInDataTransfer(e.dataTransfer)) return;
    e.preventDefault();
    dragOverlayActive = true;
  }

  function handleRootDragLeave(e: DragEvent) {
    if (!hasFilesInDataTransfer(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dragOverlayActive = false;
  }

  function handleRootDrop(e: DragEvent) {
    if (!hasFilesInDataTransfer(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth = 0;
    dragOverlayActive = false;
    if (!e.dataTransfer?.files?.length) return;
    void addFilesToStage(e.dataTransfer.files);
  }

  let copyMenuOpen = $state(false);
  // Header short code: minted for THIS room on first use and dropped on a
  // room switch, since it aliases one room code.
  let shortCode = $state<string | null>(null);
  let shortCodeFor = $state<string | null>(null);
  let shortCodeError = $state<string | null>(null);

  async function copyCode() {
    copyMenuOpen = false;
    await navigator.clipboard.writeText(window.location.href);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function copyShortCode() {
    copyMenuOpen = false;
    shortCodeError = null;
    if (shortCodeFor !== roomCode) shortCode = null;
    try {
      shortCode ??= (await createInvite(roomCode)).code;
      shortCodeFor = roomCode;
    } catch {
      shortCodeError = "Relay not reachable";
      return;
    }
    await navigator.clipboard.writeText(formatShortCode(shortCode));
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function handleMessageClick(msgId: string) {
    if (!isMobile) return;
    activeMessageId = activeMessageId === msgId ? null : msgId;
  }

  function autoResize() {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = textareaEl.scrollHeight + "px";
  }

  function handleTouchStart(msgId: string, e: TouchEvent) {
    if (e.touches.length !== 1) {
      swipeMessageId = null;
      isSwiping = false;
      return;
    }

    const rowEl = e.currentTarget as HTMLElement | null;
    if (rowEl) {
      const rect = rowEl.getBoundingClientRect();
      const touchX = e.touches[0].clientX;
      if (touchX < rect.left + rect.width * 0.5) {
        swipeMessageId = null;
        isSwiping = false;
        return;
      }
    }

    const touch = e.touches[0];
    swipeStartX = touch.clientX;
    swipeStartY = touch.clientY;
    swipeCurrentX = touch.clientX;

    swipeMessageId = msgId;
    swipeDirection = "undecided";
    isSwiping = false;
  }

  function handleTouchMove(msgId: string, e: TouchEvent) {
    if (swipeMessageId !== msgId || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - swipeStartX;
    const deltaY = touch.clientY - swipeStartY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (absX < SWIPE_DEADZONE && absY < SWIPE_DEADZONE) return;

    if (swipeDirection === "undecided") {
      if (absX > absY * SWIPE_DIRECTION_RATIO) {
        swipeDirection = "horizontal";
      } else if (absY > absX) {
        swipeDirection = "vertical";
        swipeMessageId = null;
        isSwiping = false;
        return;
      }
    }

    if (swipeDirection === "horizontal") {
      if (deltaX >= 0) {
        isSwiping = false;
        return;
      }

      const resistance = 1 - Math.pow(Math.min(absX / 180, 1), 1.2);
      const adjustedX = deltaX * resistance;

      isSwiping = true;
      swipeCurrentX = swipeStartX + adjustedX;

      if (adjustedX < -SWIPE_THRESHOLD) {
        const msg = visibleMessages.find((m) => m.id === msgId);
        if (msg) {
          startReply(msg);
          activeMessageId = null;
        }
      }
    }
  }

  function handleTouchEnd(msgId: string, _: TouchEvent) {
    if (swipeMessageId !== msgId) return;

    if (isSwiping && swipeCurrentX - swipeStartX < -SWIPE_THRESHOLD) {
      const msg = visibleMessages.find((m) => m.id === msgId);
      if (msg) {
        startReply(msg);
        activeMessageId = null;
      }
    }

    swipeMessageId = null;
    swipeDirection = "undecided";
    isSwiping = false;
    swipeCurrentX = 0;
  }

  $effect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[id^="msg-"]'))
        activeMessageId = null;
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  });

  $effect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      void addFilesToStage(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  $effect(() => {
    if (!incomingSharedFiles.length) return;
    void addFilesToStage(incomingSharedFiles);
    if (incomingSharedText && !draft.trim()) draft = incomingSharedText;
    onConsumeIncomingShared?.();
  });

  $effect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A reply in progress is the most immediate thing to back out of.
      if (replyTargetId) {
        e.preventDefault();
        replyTargetId = null;
        return;
      }
      if (stagedFiles.length === 0) return;
      e.preventDefault();
      clearStagedFiles();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  $effect(() => {
    const onWindowDragEnter = (e: DragEvent) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth += 1;
      dragOverlayActive = true;
    };
    const onWindowDragOver = (e: DragEvent) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      dragOverlayActive = true;
    };
    const onWindowDragLeave = (e: DragEvent) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dragOverlayActive = false;
    };
    const onWindowDrop = (e: DragEvent) => {
      if (!hasFilesInDataTransfer(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer?.files?.length)
        void addFilesToStage(e.dataTransfer.files);
      dragDepth = 0;
      dragOverlayActive = false;
    };

    window.addEventListener("dragenter", onWindowDragEnter);
    window.addEventListener("dragover", onWindowDragOver);
    window.addEventListener("dragleave", onWindowDragLeave);
    window.addEventListener("drop", onWindowDrop);

    return () => {
      window.removeEventListener("dragenter", onWindowDragEnter);
      window.removeEventListener("dragover", onWindowDragOver);
      window.removeEventListener("dragleave", onWindowDragLeave);
      window.removeEventListener("drop", onWindowDrop);
    };
  });

  $effect(() => {
    const nextMap = new Map(stagedPreviewUrls);
    const activeKeys = new Set<string>();

    for (const file of stagedFiles) {
      if (!isPreviewable(file)) continue;
      const key = fileKey(file);
      activeKeys.add(key);
      if (!nextMap.has(key)) nextMap.set(key, URL.createObjectURL(file));
    }

    for (const [key, url] of nextMap) {
      if (activeKeys.has(key)) continue;
      URL.revokeObjectURL(url);
      nextMap.delete(key);
    }

    const changed =
      nextMap.size !== stagedPreviewUrls.size ||
      [...nextMap.entries()].some(([k, v]) => stagedPreviewUrls.get(k) !== v);
    if (changed) stagedPreviewUrls = nextMap;
  });

  $effect(() => {
    return () => {
      for (const url of stagedPreviewUrls.values()) URL.revokeObjectURL(url);
    };
  });

  $effect(() => {
    if (messages.length > 0) markSeen().catch(() => {});
  });

  // markSeen refuses to run while the page is hidden, so the room the user was
  // parked on keeps its unread count in a background tab. Catch it up the
  // moment they look again.
  function markSeenOnReturn(): void {
    if (document.visibilityState === "visible") markSeen().catch(() => {});
  }

  function shouldShowHeader(current: Message, previous?: Message): boolean {
    if (!previous) return true;
    const a = senderDid(current.senderId) || current.senderId;
    const b = senderDid(previous.senderId) || previous.senderId;
    if (a !== b) return true;
    return current.timestamp - previous.timestamp > 2 * 60 * 1000;
  }

  function shouldShowDateSep(current: number, previous?: number): boolean {
    if (!previous) return true;
    return (
      new Date(current).toDateString() !== new Date(previous).toDateString()
    );
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function formatDate(ts: number): string {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  }

  /**
   * senderId is usually a DID, but messages stored before the sender's DID was
   * known carry their peerId instead - and peerNames/peerAvatars are keyed by
   * DID only, so looking up the raw senderId silently missed and the message
   * kept whatever name it was saved with, with no avatar at all.
   */
  function senderDid(senderId: string): string {
    return peerIdToDid(senderId);
  }

  function initials(msg: Message): string {
    return (displayName(msg) || msg.senderId).charAt(0).toUpperCase();
  }

  function senderAvatar(senderId: string): string | undefined {
    return (
      peerAvatars.get(senderDid(senderId)) ?? peerAvatars.get(senderId)
    );
  }

  /** User-picked nickname color, keyed like names (by DID, peerId fallback). */
  function senderColor(senderId: string): string | undefined {
    if (!displayPrefs.showPeerNicknameColors) return undefined;
    return peerColors.get(senderDid(senderId)) ?? peerColors.get(senderId);
  }

  /** Name effect, keyed like names (by DID, peerId fallback). Respects showPeerNicknameColors. */
  function senderEffect(senderId: string): string | undefined {
    if (!displayPrefs.showPeerNicknameColors) return undefined;
    const did = senderDid(senderId);
    return peerProfileMeta.get(did)?.nameEffect ?? peerProfileMeta.get(senderId)?.nameEffect;
  }

  /** Gradient stops for the gradient effect, keyed like names. */
  function senderGradients(senderId: string): {
    g2?: string;
    g3?: string;
  } {
    const did = senderDid(senderId);
    const meta = peerProfileMeta.get(did) ?? peerProfileMeta.get(senderId);
    return { g2: meta?.gradient2, g3: meta?.gradient3 };
  }

  /** Tag chip, keyed like names. Deliberately NOT behind
   *  showPeerNicknameColors: the tag is content, like the name; the colors
   *  pref governs decoration of the name itself. */
  function senderTag(
    senderId: string
  ): { text: string; textColor: string; chipColor: string } | null {
    const did = senderDid(senderId);
    const meta = peerProfileMeta.get(did) ?? peerProfileMeta.get(senderId);
    if (!meta?.tagText) return null;
    return {
      text: meta.tagText,
      textColor: meta.tagTextColor ?? "#000000",
      chipColor: meta.tagChipColor ?? "#e5e7eb",
    };
  }

  /** Live name wins over the one stored with the message, so a rename shows up
   *  on everything that person ever said, not just what they say next. */
  function displayNameFor(senderId: string, stored?: string): string {
    return (
      peerNames.get(senderDid(senderId)) ||
      peerNames.get(senderId) ||
      stored ||
      senderId.slice(0, 8)
    );
  }

  function displayName(msg: Message): string {
    return displayNameFor(msg.senderId, msg.senderName);
  }

  /** What a reply should QUOTE.
   *
   *  The reply snapshot travels unsigned: no canonical version covers
   *  replyTo.senderName or replyTo.content, so any room member can take a
   *  genuine signed message, rewrite the words it appears to be quoting, and
   *  have it verify honestly - and because sync puts by id, their copy
   *  overwrites the original on peers that already hold it. Whenever we hold
   *  the quoted message ourselves, its own signed content is the truth and the
   *  snapshot is ignored. The snapshot is still the fallback for a quote whose
   *  target we never received. */
  function quoted(r: ReplyTo): { name: string; content: string } {
    const held = messageById.get(r.id);
    if (held) {
      // Use quotable text for held messages so image-only messages show
      // [image] instead of empty content. Held message is the source of truth.
      return { name: displayName(held), content: getQuotableText(held) };
    }
    // Snapshot from the wire is already built with quotable text
    return { name: r.senderName, content: r.content };
  }

  function reactorNames(users: Set<string>): string {
    const names: string[] = [];
    let self = false;
    for (const id of users) {
      if (isSelfSender(id)) self = true;
      else names.push(displayNameFor(id));
    }
    return formatReactorNames(names, self);
  }

  function peerIdForSender(senderId: string): string | null {
    if (peers.includes(senderId)) return senderId;
    const mapped = didToPeerId(senderId);
    if (mapped) return mapped;
    if (senderId.startsWith("12D3") || senderId.startsWith("Qm"))
      return senderId;
    return null;
  }

  let profileCardFor = $state<{
    did: string;
    name: string;
    avatarUrl?: string;
    color?: string;
  } | null>(null);

  function openProfileFromMessage(msg: Message): void {
    const own = isSelfSender(msg.senderId);
    const did = own ? selfId() : senderDid(msg.senderId);
    profileCardFor = {
      did,
      name: own ? profileStore.nickname || "You" : displayName(msg),
      avatarUrl: own
        ? (profileStore.avatarUrl ?? undefined)
        : (senderAvatar(msg.senderId) ?? undefined),
      color: own
        ? (profileStore.color ?? undefined)
        : senderColor(msg.senderId),
    };
  }

  function openUserMenuFromMessage(msg: Message, e: MouseEvent): void {
    if (isSelfSender(msg.senderId)) return;
    e.stopPropagation();
    const peerId = peerIdForSender(msg.senderId);
    const pos = clampMenu(e.clientX, e.clientY);
    userMenu = { peerId, senderId: msg.senderId, x: pos.x, y: pos.y };
  }

  function clampMenu(x: number, y: number): { x: number; y: number } {
    if (typeof window === "undefined") return { x, y };
    const menuWidth = 240;
    const menuHeight = 170;
    const pad = 8;
    return {
      x: Math.max(pad, Math.min(x, window.innerWidth - menuWidth - pad)),
      y: Math.max(pad, Math.min(y, window.innerHeight - menuHeight - pad)),
    };
  }

  function closeUserMenu(): void {
    userMenu = null;
  }

  // A person can be referenced by raw peerId or by DID depending on where
  // the reference came from, and a phonebook entry carries both. Compare
  // every form, or the header button shows "Add" for someone already saved
  // (and its toggle then silently removes them).
  function isInPhonebook(peerId: string): boolean {
    const did = peerIdToDid(peerId);
    return roomsStore.phonebook.some(
      (entry) =>
        entry.peerId === peerId ||
        entry.did === peerId ||
        (!!did && (entry.peerId === did || entry.did === did))
    );
  }

  async function startDmFromMenu(peerId: string): Promise<void> {
    if (onOpenDm) {
      await onOpenDm(peerId);
    } else {
      // No host to switch the view for us, so the panel: openDmConversation
      // only moves the transport, leaving this pane rendering the room it is
      // still keyed to and the DM invisible.
      await openDmPanel(peerId);
    }
    closeUserMenu();
  }

  async function addFromMenu(peerId: string): Promise<void> {
    await addToPhonebook(peerId);
    await refreshPhonebook();
    closeUserMenu();
  }

  async function removeFromMenu(peerId: string): Promise<void> {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
    closeUserMenu();
  }

  // Deleting destroys stored history, so the header button arms first.
  let confirmingDelete = $state(false);

  const isDmChat = $derived(
    transportState.chatMode === "dm" && !!transportState.activeDmPeerId
  );

  // Desktop only: below sm there is no room for two columns, and the call
  // stage would squeeze the messages to nothing.
  const callBeside = $derived(displayPrefs.callChatBeside && !isMobile);

  // The stored pref is a stack id or a custom family name; the resolver turns
  // either into a complete CSS stack, and sanitises the custom case because the
  // value lands in an inline style attribute.
  const chatFontStack = $derived(
    resolveChatFontStack(displayPrefs.chatFontFamily),
  );
  // Opening the user list widens the chat column instead of crushing the
  // message text into what the w-60 aside leaves behind.
  const chatColClass = $derived(
    callBeside && showCallView
      ? `shrink-0 border-l border-border ${
          showUserList && !isDmChat ? "w-156" : "w-96"
        }`
      : "flex-1"
  );

  const dmPeerInPhonebook = $derived.by(() => {
    const peerId = transportState.activeDmPeerId;
    if (!peerId) return false;
    return isInPhonebook(peerId);
  });

  async function toggleActiveDmPhonebook(): Promise<void> {
    const peerId = transportState.activeDmPeerId;
    if (!peerId) return;
    // Re-check current state to avoid stale closure issues
    const currentlyInPhonebook = isInPhonebook(peerId);
    if (currentlyInPhonebook) await removeFromPhonebook(peerId);
    else await addToPhonebook(peerId);
    await refreshPhonebook();
  }
</script>

<svelte:window
  onclick={(e) => {
    closeUserMenu();
    if (copyMenuOpen && !(e.target as HTMLElement).closest("[data-copy-menu]"))
      copyMenuOpen = false;
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      closeUserMenu();
      copyMenuOpen = false;
      reactionPickerFor = null;
      activeMessageId = null;
    }
  }}
/>

<svelte:document onvisibilitychange={markSeenOnReturn} />

<!--
  The two chat font properties are declared here and consumed by the message
  body. They are purpose-named on purpose: overriding Tailwind's `--font-mono`
  instead would also retarget every shiki code block, because Preflight resolves
  `code`/`pre`/`kbd`/`samp` from that token.
-->
<div
  use:viewportHeight
  style="--chat-font-family: {chatFontStack}"
  class="relative flex flex-col bg-background text-foreground font-(family-name:--chat-font-family) overflow-hidden"
  role="main"
  ondragenter={handleRootDragEnter}
  ondragover={handleRootDragOver}
  ondragleave={handleRootDragLeave}
  ondrop={handleRootDrop}
>
  {#if dragOverlayActive}
    <div
      class="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-background/85 backdrop-blur-sm border-2 border-dashed border-primary/60"
    >
      <div
        class="rounded-lg bg-card/90 px-4 py-2 text-sm text-foreground shadow-lg"
      >
        Drop files to attach
      </div>
    </div>
  {/if}

  <!-- h-13 keeps this row exactly level with the sidebar header (RoomSidebar). -->
  <header class="flex h-13 items-center border-b border-border px-4 shrink-0">
    <div class="flex w-full items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        {#if onOpenSidebar}
          <Button
            variant="ghost"
            size="icon"
            onclick={onOpenSidebar}
            aria-label="Open rooms sidebar"
            class="sm:hidden shrink-0 cursor-pointer -ml-1 text-muted-foreground hover:text-foreground"
          >
            <Menu class="size-4" />
          </Button>
        {/if}
        <h1 class="text-sm font-semibold truncate text-foreground">
          {roomName || roomCode}
        </h1>
        {#if !isDmChat}
          <Badge
            variant="outline"
            class="gap-1 text-xs shrink-0 border-border text-muted-foreground"
          >
            <Users class="size-3" />
            {peers.length + 1}
          </Badge>
        {/if}
      </div>
      <div class="flex items-center gap-2 shrink-0">
        {#if !isDmChat}
          <div class="relative hidden sm:block" data-copy-menu>
            <Tip text={copied ? "Copied" : "Copy invite"}>
              {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={() => (copyMenuOpen = !copyMenuOpen)}
              aria-label="Copy invite"
              aria-haspopup="menu"
              aria-expanded={copyMenuOpen}
              class="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
            >
              <code>{roomCode}</code>
              {#if copied}
                <Check class="size-3 text-primary" />
              {:else}
                <Copy class="size-3 mb-0.5" />
              {/if}
            </button>
              {/snippet}
            </Tip>
            {#if copyMenuOpen}
              <div
                role="menu"
                class="absolute right-0 top-full mt-2 z-20 w-56 rounded-lg border border-border bg-popover text-popover-foreground shadow-md p-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onclick={copyCode}
                  class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
                >
                  Copy link
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onclick={copyShortCode}
                  class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
                >
                  Copy short code
                  <span class="block text-xs text-muted-foreground">
                    {#if shortCode && shortCodeFor === roomCode}
                      {formatShortCode(shortCode)} - works for 5 minutes
                    {:else if shortCodeError}
                      {shortCodeError}
                    {:else}
                      Works for 5 minutes
                    {/if}
                  </span>
                </button>
              </div>
            {/if}
          </div>
        {/if}
        {#if !inCall}
          <Tip text="Join call">
            {#snippet children(props)}
              <Button
                {...props}
                variant="ghost"
                size="icon"
                onclick={joinCall}
                disabled={transportState.connecting}
                aria-label="Join call"
                class="text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Phone class="size-4" />
              </Button>
            {/snippet}
          </Tip>
        {:else if callRoomCode && callRoomCode !== roomCode}
          <!--
            The call is live in another conversation and its stage is not on
            screen. The sidebar chip also leads back, but below sm the sidebar
            is off-canvas - so the way back has to exist here too, and this slot
            is empty in exactly this state.
          -->
          <Tip text="Back to the call you are in">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={requestReturnToCall}
                aria-label="Back to call"
                class="flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/10 px-2 py-1 text-xs font-mono text-green-400 hover:brightness-125 cursor-pointer"
              >
                <span
                  class="size-1.5 rounded-full bg-green-400 animate-pulse"
                ></span>
                <CornerUpLeft class="size-3.5" />
                <span class="hidden sm:inline">Back to call</span>
              </button>
            {/snippet}
          </Tip>
        {/if}
        {#if !isDmChat}
          <Tip text={showUserList ? "Hide users" : "Show users"}>
            {#snippet children(props)}
              <Button
                {...props}
                variant="ghost"
                size="icon"
                onclick={() => (showUserList = !showUserList)}
                aria-label="Toggle user list"
                class="flex text-muted-foreground hover:text-foreground cursor-pointer {showUserList
                  ? 'text-primary'
                  : ''}"
              >
                <Users class="size-4" />
              </Button>
            {/snippet}
          </Tip>
        {/if}
        {#if isDmChat}
          <Tip
            text={dmPeerInPhonebook
              ? "Remove from phonebook"
              : "Add to phonebook"}
          >
            {#snippet children(props)}
          <Button
            {...props}
            variant="ghost"
            size="icon"
            onclick={toggleActiveDmPhonebook}
            aria-label={dmPeerInPhonebook
              ? "Remove from phonebook"
              : "Add to phonebook"}
            class={dmPeerInPhonebook
              ? "text-red-400 hover:text-destructive! hover:bg-destructive/10!"
              : "text-green-400 hover:text-green-500! hover:bg-green-500/10!"}
          >
            {#if dmPeerInPhonebook}
              <UserRoundMinus class="size-4" />
            {:else}
              <UserPlus class="size-4" />
            {/if}
          </Button>
            {/snippet}
          </Tip>
        {/if}
        <Tip
          text={confirmingDelete
            ? "Click again to confirm"
            : isDmChat
              ? "Delete conversation"
              : "Delete room"}
        >
          {#snippet children(props)}
            <Button
              {...props}
              variant="ghost"
              size="icon"
              onclick={() => {
                if (!confirmingDelete) {
                  confirmingDelete = true;
                  setTimeout(() => (confirmingDelete = false), 3000);
                  return;
                }
                confirmingDelete = false;
                onLeave();
              }}
              aria-label={isDmChat ? "Delete conversation" : "Delete room"}
              class="text-red-400 hover:bg-destructive/10! hover:text-destructive! {confirmingDelete
                ? 'bg-destructive/20!'
                : ''}"
            >
              <LogOut class="size-4" />
            </Button>
          {/snippet}
        </Tip>
      </div>
    </div>
  </header>

  {#if connecting}
    <div
      class="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center"
    >
      <div class="flex flex-col items-center gap-3">
        <div
          class="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin"
        ></div>
        <p class="text-sm text-muted-foreground">Connecting...</p>
      </div>
    </div>
  {/if}

  <!-- Call and chat. Stacked by default, side by side when callBeside. The
       wrapper is always mounted: a remount would rebind messagesEl and drop
       the scroll position on every switch. -->
  <div
    class="flex flex-1 min-h-0 overflow-hidden {callBeside
      ? 'flex-row'
      : 'flex-col'}"
  >
    {#if showCallView}
      <!-- Own column: the call view also renders an error banner, which must
           not become a second column of the row. -->
      <div
        class="flex min-h-0 flex-col {callBeside
          ? 'min-w-0 flex-1'
          : 'shrink-0'}"
      >
        <VoiceVideoCallView beside={callBeside} />
      </div>
    {/if}
    <div
      class="flex min-h-0 min-w-0 flex-col overflow-hidden {chatColClass}"
    >

  <div class="flex flex-1 min-h-0 overflow-hidden">
    <div
      bind:this={messagesEl}
      onscroll={handleScroll}
      style="--chat-font-size: {displayPrefs.chatFontSize}px"
      class="chat-messages flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 min-h-0"
    >
      {#if hasMoreHistory && visibleMessages.length > 0}
        <div class="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            onclick={loadOlderPreservingScroll}
            disabled={loadingMore}
            class="gap-1.5 text-xs text-muted-foreground font-mono cursor-pointer"
          >
            <ChevronUp class="size-3.5" />
            {loadingMore ? "Loading..." : "Load older messages"}
          </Button>
        </div>
      {/if}

      {#if visibleMessages.length === 0}
        <div class="flex h-full items-center justify-center py-20">
          <p class="text-sm text-muted-foreground italic">
            No messages yet. Say something!
          </p>
        </div>
      {:else}
        <div class="space-y-0.5">
          {#each visibleMessages as msg, i (msg.id)}
            {@const prev = visibleMessages[i - 1]}
            {@const showDate = shouldShowDateSep(
              msg.timestamp,
              prev?.timestamp
            )}
            {@const showHeader = shouldShowHeader(msg, prev)}
            {@const isOwn = isSelfSender(msg.senderId)}
            <div>
              {#if showDate}
                <div class="flex items-center gap-3 py-3">
                  <Separator class="flex-1 bg-border" />
                  <span class="text-xs text-muted-foreground"
                    >{formatDate(msg.timestamp)}</span
                  >
                  <Separator class="flex-1 bg-border" />
                </div>
              {/if}
              <div
                id={`msg-${msg.id}`}
                class="group relative rounded-md px-2 py-0.5 hover:bg-muted/50 cursor-default! {showHeader
                  ? 'mt-3 pt-1'
                  : ''} {messageIsMentioningMe(msg)
                  ? 'bg-primary/5 border-l-2 border-l-primary pl-1.5'
                  : ''}"
                role="button"
                tabindex={isMobile ? 0 : -1}
                onclick={() => isMobile && handleMessageClick(msg.id)}
                onkeydown={isMobile
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleMessageClick(msg.id);
                      }
                    }
                  : undefined}
                ontouchstart={isMobile
                  ? (e) => handleTouchStart(msg.id, e)
                  : undefined}
                ontouchmove={isMobile
                  ? (e) => handleTouchMove(msg.id, e)
                  : undefined}
                ontouchend={isMobile
                  ? (e) => handleTouchEnd(msg.id, e)
                  : undefined}
                style={isMobile && swipeMessageId === msg.id
                  ? `transform: translateX(${Math.min(0, swipeCurrentX - swipeStartX)}px); transition: ${isSwiping ? "none" : "transform 0.2s ease-out"}`
                  : ""}
              >
                {#if msg.replyTo}
                  {@const q = quoted(msg.replyTo)}
                  <button
                    type="button"
                    class="ml-9 mb-0.5 max-w-md text-left inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground/90 hover:text-foreground cursor-pointer"
                    onclick={() => jumpToMessage(msg.replyTo!.id)}
                  >
                    <Reply
                      size="16"
                      class="text-muted-foreground -ml-5 transform -scale-x-100"
                    />
                    <span class="font-semibold">{q.name}</span>
                    <span class="truncate"
                      >{humanizeMentions(
                        q.content,
                        resolveMentionDisplayName
                      )}</span
                    >
                  </button>
                {/if}

                {#if showHeader}
                  <div class="flex items-start gap-2">
                    <div
                      role="button"
                      tabindex="0"
                      onclick={(e) => {
                        e.stopPropagation();
                        openProfileFromMessage(msg);
                      }}
                      oncontextmenu={(e) => {
                        e.preventDefault();
                        openUserMenuFromMessage(msg, e);
                      }}
                      onkeydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openProfileFromMessage(msg);
                        }
                      }}
                      class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full overflow-hidden text-xs font-semibold font-mono
                      {isOwn
                        ? 'bg-primary/20 text-primary'
                        : 'bg-secondary text-secondary-foreground'}"
                      style={isOwn
                        ? profileStore.color
                          ? `color: ${profileStore.color}`
                          : ""
                        : senderColor(msg.senderId)
                          ? `color: ${senderColor(msg.senderId)}`
                          : ""}
                    >
                      {#if isOwn && profileStore.avatarUrl}
                        <img
                          src={profileStore.avatarUrl}
                          alt="You"
                          class="size-full object-cover"
                        />
                      {:else if !isOwn && senderAvatar(msg.senderId)}
                        <GifImage
                          src={senderAvatar(msg.senderId) ?? ""}
                          alt={displayName(msg)}
                          class="size-full object-cover"
                          animate="hover"
                        />
                      {:else}
                        {initials(msg)}
                      {/if}
                    </div>
                    <div class="flex items-baseline gap-2">
                      {#if isOwn}
                        {@const effectStyle = nameEffectStyle(profileStore.nameEffect, profileStore.color, profileStore.gradient2 ?? undefined, profileStore.gradient3 ?? undefined)}
                        <span
                          role="button"
                          tabindex="0"
                          onclick={() => openProfileFromMessage(msg)}
                          onkeydown={(e) => {
                            if (e.key === "Enter") openProfileFromMessage(msg);
                          }}
                          class="cursor-pointer text-(length:--chat-font-size) font-medium text-primary {displayPrefs.italicOwnName
                            ? 'italic'
                            : ''} {effectStyle.class}"
                          style={effectStyle.style || (profileStore.color ? `color: ${profileStore.color}` : "")}
                        >
                          {profileStore.nickname || "You"}
                        </span>
                        {#if profileStore.tagText}
                          <span
                            class="rounded px-1 py-px font-mono text-[10px] font-semibold uppercase leading-4"
                            style={`background-color: ${profileStore.tagChipColor ?? "#e5e7eb"}; color: ${profileStore.tagTextColor ?? "#000000"}`}
                            >{profileStore.tagText}</span
                          >
                        {/if}
                      {:else}
                        {@const color = senderColor(msg.senderId)}
                        {@const effect = senderEffect(msg.senderId)}
                        {@const grads = senderGradients(msg.senderId)}
                        {@const effectStyle = nameEffectStyle(effect, color, grads.g2, grads.g3)}
                        <span
                          role="button"
                          tabindex="0"
                          onclick={() => openProfileFromMessage(msg)}
                          oncontextmenu={(e) => {
                            e.preventDefault();
                            openUserMenuFromMessage(msg, e);
                          }}
                          onkeydown={(e) => {
                            if (e.key === "Enter") openProfileFromMessage(msg);
                          }}
                          class="cursor-pointer text-(length:--chat-font-size) font-medium text-foreground {effectStyle.class}"
                          style={effectStyle.style || (color ? `color: ${color}` : "")}
                        >
                          {displayName(msg)}
                        </span>
                        {@const tag = senderTag(msg.senderId)}
                        {#if tag}
                          <span
                            class="rounded px-1 py-px font-mono text-[10px] font-semibold uppercase leading-4"
                            style={`background-color: ${tag.chipColor}; color: ${tag.textColor}`}
                            >{tag.text}</span
                          >
                        {/if}
                      {/if}
                      <span class="text-xs text-muted-foreground"
                        >{formatTime(msg.timestamp)}</span
                      >
                    </div>
                  </div>
                {/if}

                <MsgRender
                  {msg}
                  {isOwn}
                  {fileTransfers}
                  onRequestFileDownload={requestFileDownload}
                />

                {#if reactionsByMessage.get(msg.id)?.size}
                  <div class="ml-9 mt-1 flex items-center gap-1">
                    {#each [...(reactionsByMessage
                        .get(msg.id)
                        ?.entries() ?? [])] as [emoji, users] (emoji)}
                      {#if users.size > 0}
                        {@const reacted = users.has(selfId()) || users.has(myPeerId())}
                        <Tip text={reactorNames(users)}>
                          {#snippet children(props)}
                            <button
                              {...props}
                              type="button"
                              class="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs cursor-pointer transition-colors {reacted
                                ? 'border-blue-400/70 bg-blue-500/20 text-blue-200'
                                : 'border-border/80 bg-muted/40 text-muted-foreground hover:text-foreground'}"
                              onclick={(e) => {
                                e.stopPropagation();
                                toggleReaction?.(msg.id, emoji);
                                activeMessageId = null;
                              }}
                            >
                              <span>{emoji}</span>
                              <span>{users.size}</span>
                            </button>
                          {/snippet}
                        </Tip>
                      {/if}
                    {/each}
                  </div>
                {/if}

                {#if isMobile && swipeMessageId === msg.id}
                  {@const progress = Math.min(
                    1,
                    Math.abs((swipeCurrentX - swipeStartX) / SWIPE_THRESHOLD)
                  )}
                  <div
                    class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                    style={`opacity: ${progress}; transform: translateY(-50%) scale(${0.8 + progress * 0.25});`}
                  >
                    <Reply class="size-5" />
                  </div>
                {/if}

                <div
                  class="absolute right-0 sm:right-8 top-0 -translate-y-1/2 opacity-0 group-hover:opacity-100 {activeMessageId ===
                  msg.id
                    ? 'opacity-100'
                    : ''} transition-opacity flex items-center gap-1 pr-1"
                >
                  <Tip text="React">
                    {#snippet children(props)}
                  <button
                    {...props}
                    type="button"
                    class="size-7 inline-flex items-center justify-center rounded bg-card border border-border/70 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label="React"
                    onclick={(e) => {
                      e.stopPropagation();
                      if (reactionPickerFor === msg.id) {
                        reactionPickerFor = null;
                      } else {
                        openReactionPicker(msg.id, e.currentTarget);
                      }
                      activeMessageId = null;
                    }}
                  >
                    <Smile class="size-3.5" />
                  </button>
                    {/snippet}
                  </Tip>
                  <Tip text="Reply">
                    {#snippet children(props)}
                  <button
                    {...props}
                    type="button"
                    class="size-7 inline-flex items-center justify-center rounded bg-card border border-border/70 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label="Reply"
                    onclick={(e) => {
                      e.stopPropagation();
                      startReply(msg);
                      activeMessageId = null;
                    }}
                  >
                    <Reply class="size-3.5" />
                  </button>
                    {/snippet}
                  </Tip>
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if !isDmChat}
      <UserListSidebar
        open={showUserList}
        onToggle={() => (showUserList = !showUserList)}
        {onOpenDm}
      />
    {/if}
  </div>

  {#if !autoScroll && visibleMessages.length > 0}
    <div class="flex justify-center -mt-10 relative z-10 mb-2">
      <Button
        variant="secondary"
        size="sm"
        class="rounded-full shadow-md font-mono text-xs"
        onclick={() => {
          scrollToBottom("smooth");
          autoScroll = true;
        }}
      >
        <ArrowDown class="size-3" /> New messages below <ArrowDown
          class="size-3"
        />
      </Button>
    </div>
  {/if}

  {#if replyTarget}
    <div
      class="px-4 p-2 text-muted-foreground bg-muted/50 border-t border-border text-sm"
    >
      <div class="flex items-center justify-between gap-2 leading-tight">
        <Reply
          size="16"
          class="text-muted-foreground transform mb-0.5 -scale-x-100"
        />
        <div class="truncate mt-0.5 flex flex-row items-center gap-1 w-full">
          Replying to
          <span class="font-semibold text-foreground"
            >{displayName(replyTarget)}</span
          >
          <span class="mx-1">•</span>
          <span class="truncate"
            >{humanizeMentions(getQuotableText(replyTarget), resolveMentionDisplayName)}</span
          >
        </div>
        <Tip text="Cancel reply (Esc)">
          {#snippet children(props)}
        <button
          {...props}
          type="button"
          class="size-6 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
          onclick={() => (replyTargetId = null)}
          aria-label="Cancel reply"
        >
          <X class="size-4" />
        </button>
          {/snippet}
        </Tip>
      </div>
    </div>
  {/if}

  {#if sendingFiles.length > 0}
    <!-- The gap this fills: staged previews clear on Enter, but the message
         only appears once the file is fingerprinted and hashed for seeding -
         seconds of dead air on a big file with nothing saying it is going. -->
    <div
      class="flex items-center gap-2 border-t border-border bg-muted/30 px-4 py-2 font-mono text-xs text-muted-foreground"
    >
      <span
        class="size-2 shrink-0 animate-pulse rounded-full bg-primary"
      ></span>
      <span class="truncate">
        Sending {sendingFiles.length === 1
          ? sendingFiles[0]
          : `${sendingFiles.length} files`}...
      </span>
    </div>
  {/if}

  {#if stagedFiles.length > 0}
    <div
      class="flex items-start gap-2 border-t border-border bg-muted/30 px-4 py-2"
    >
      <!-- pt-2/pr-2 inside the scroll area: the per-file delete badge hangs
           past the tile's top-right corner, and the overflow container was
           cropping it. -->
      <div class="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 pr-2 pt-2">
        {#each stagedFiles as file (fileKey(file))}
          {@const previewUrl = getStagedPreviewURL(file)}
          <div
            class="group relative shrink-0 rounded-md border border-border/70 bg-background/80 p-1.5"
          >
            <!-- Always visible: hover-gated made it invisible on touch, and
                 a file staged by mistake needs an obvious way out (Esc works
                 but nothing said so). -->
            <button
              type="button"
              class="absolute -right-1.5 -top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full bg-red-500 text-white shadow-sm hover:bg-red-600"
              aria-label="Remove file"
              onclick={() => removeStagedFile(file)}
            >
              <Trash2 class="size-3" />
            </button>

            {#if previewUrl && file.type.startsWith("image/")}
              <img
                src={previewUrl}
                alt={file.name}
                class="h-16 w-16 rounded object-cover"
              />
            {:else if previewUrl && file.type.startsWith("video/")}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                src={previewUrl}
                class="h-16 w-16 rounded object-cover"
                muted
                playsinline
              ></video>
            {:else}
              <div
                class="flex h-16 w-28 items-center gap-2 rounded bg-muted px-2"
              >
                <FileText class="size-4 shrink-0 text-muted-foreground" />
                <div class="min-w-0">
                  <p class="truncate text-xs text-foreground">{file.name}</p>
                  <p class="text-[10px] text-muted-foreground">
                    {formatSize(file.size)}
                  </p>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
      <!-- Same way out the reply banner has: one X clears everything staged. -->
      <Tip text="Remove attachments (Esc)">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            class="self-center size-6 shrink-0 inline-flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
            onclick={clearStagedFiles}
            aria-label="Remove all attachments"
          >
            <X class="size-4" />
          </button>
        {/snippet}
      </Tip>
    </div>
  {/if}

  <div
    class="border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))] min-h-18.75 bg-background"
  >
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      class="flex gap-2"
    >
      <input
        bind:this={fileInputEl}
        type="file"
        multiple
        class="hidden"
        onchange={(e) => {
          const target = e.currentTarget as HTMLInputElement;
          if (target.files?.length) void addFilesToStage(target.files);
          target.value = "";
        }}
      />
      <div class="relative flex w-full items-center">
        <MentionInput
          bind:el={textareaEl}
          bind:value={draft}
          segments={draftSegments}
          onkeydown={handleKeydown}
          placeholder="Type a message..."
          oninput={() => {
            autoResize();
            updateMentionState();
            updateCommandState();
          }}
        />
        {#if commandHint}
          <p class="absolute bottom-full left-0 mb-1 rounded bg-popover border border-border px-2 py-1 font-mono text-xs text-muted-foreground">
            {commandHint}
          </p>
        {/if}
        {#if commandPopupOpen && filteredCommands.length > 0}
          <div
            class="absolute bottom-full left-0 z-50 mb-1 max-h-48 min-w-64 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            {#each filteredCommands as cmd, index (cmd.name)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-muted {commandSelectedIndex ===
                index
                  ? 'bg-muted'
                  : ''}"
                onclick={() => selectCommand(cmd)}
              >
                <PluginIcon icon={cmd.icon} class="size-4" />
                <span class="text-foreground">/{cmd.name}</span>
                <span class="truncate text-xs text-muted-foreground">{cmd.usage}</span>
              </button>
            {/each}
          </div>
        {/if}
        {#if mentionPopupOpen && filteredMembersForMention.length > 0}
          <div
            class="absolute bottom-full left-0 z-50 mb-1 max-h-48 min-w-48 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg"
          >
            {#each filteredMembersForMention as member, index (member.did)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm hover:bg-muted {mentionSelectedIndex ===
                index
                  ? 'bg-muted'
                  : ''}"
                onclick={() => selectMentionMember(member)}
              >
                <span class="text-muted-foreground">@</span>
                <span class="truncate">{member.name}</span>
                {#if !member.online}
                  <!-- Say so rather than hiding them: mentioning an away member
                       is the point, and a silent list looks like a bug. -->
                  <span class="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    away
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        <div
          class="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1"
        >
          <Tip text="Attach files">
            {#snippet children(props)}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon"
                onclick={() => fileInputEl?.click()}
                aria-label="Attach files"
                class="size-8 shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <Paperclip class="size-4" />
              </Button>
            {/snippet}
          </Tip>
          <Tip text="Insert emoji">
            {#snippet children(props)}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon"
                onclick={(e: MouseEvent) => {
                  composerEmojiAnchor = (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect();
                  composerEmojiOpen = !composerEmojiOpen;
                }}
                aria-label="Insert emoji"
                class="size-8 shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
                onpointerenter={() =>
                  (emojiCycleIdx = (emojiCycleIdx + 1) % emojiCycle.length)}
              >
                {@const CycleIcon = emojiCycle[emojiCycleIdx]}
                <CycleIcon class="size-4" />
              </Button>
            {/snippet}
          </Tip>
          <Tip text="Send a GIF">
            {#snippet children(props)}
              <Button
                {...props}
                type="button"
                variant="ghost"
                size="icon"
                onclick={() => (gifPickerOpen = true)}
                aria-label="Send a GIF"
                class="size-8 shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
              >
                <ImagePlay class="size-4" />
              </Button>
            {/snippet}
          </Tip>
        </div>
      </div>
      <Button
        type="submit"
        size="icon"
        disabled={!draft.trim() && stagedFiles.length === 0}
        aria-label="Send message"
        class="size-11 sm:size-10 shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-30"
      >
        <Send class="size-4" />
      </Button>
    </form>
  </div>
    </div>
  </div>
</div>

{#if profileCardFor}
  <UserProfileCard
    open={!!profileCardFor}
    onOpenChange={(open) => {
      if (!open) profileCardFor = null;
    }}
    did={profileCardFor.did}
    name={profileCardFor.name}
    avatarUrl={profileCardFor.avatarUrl}
    color={profileCardFor.color}
    onEdit={() => openSettings("profile")}
    onMessage={peerIdForSender(profileCardFor.did)
      ? () => {
          const pid = peerIdForSender(profileCardFor!.did)!;
          profileCardFor = null;
          startDmFromMenu(pid);
        }
      : undefined}
    onTogglePhonebook={peerIdForSender(profileCardFor.did)
      ? () => {
          const pid = peerIdForSender(profileCardFor!.did)!;
          if (isInPhonebook(pid)) removeFromMenu(pid);
          else addFromMenu(pid);
        }
      : undefined}
    inPhonebook={peerIdForSender(profileCardFor.did)
      ? isInPhonebook(peerIdForSender(profileCardFor.did)!)
      : false}
  />
{/if}

<GifPicker
  open={gifPickerOpen}
  onOpenChange={(v) => (gifPickerOpen = v)}
  onSelect={handleGifSelect}
  onSelectFile={handleGifFileSelect}
/>

<EmojiPickerPopup
  open={reactionPickerFor !== null}
  anchor={reactionAnchor}
  onClose={() => {
    reactionPickerFor = null;
    activeMessageId = null;
  }}
  onSelect={(emoji) => {
    if (!reactionPickerFor) return;
    toggleReaction?.(reactionPickerFor, emoji);
    reactionPickerFor = null;
    activeMessageId = null;
  }}
/>

<EmojiPickerPopup
  open={composerEmojiOpen}
  anchor={composerEmojiAnchor}
  onClose={() => (composerEmojiOpen = false)}
  onSelect={insertEmoji}
/>

{#if userMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="menu"
    tabindex="-1"
    class="fixed z-50 min-w-40 rounded-md border border-border bg-popover py-1 shadow-xl"
    style="top: {userMenu.y}px; left: {userMenu.x}px"
    onkeydown={() => {}}
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <button
      type="button"
      disabled={!userMenu.peerId}
      class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-muted cursor-pointer"
      onclick={() => userMenu?.peerId && startDmFromMenu(userMenu.peerId)}
    >
      <Users class="size-4" />
      {userMenu.peerId ? "Send DM" : "DM unavailable"}
    </button>
    {#if userMenu.peerId && !isInPhonebook(userMenu.peerId)}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono hover:bg-muted cursor-pointer"
        onclick={() => userMenu?.peerId && addFromMenu(userMenu.peerId)}
      >
        <UserPlus class="size-4" />
        Add to phonebook
      </button>
    {:else if userMenu.peerId}
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-sm font-mono text-destructive hover:bg-muted cursor-pointer"
        onclick={() => userMenu?.peerId && removeFromMenu(userMenu.peerId)}
      >
        <UserRoundMinus class="size-4" />
        Remove from phonebook
      </button>
    {:else}
      <div class="px-3 py-1.5 text-xs text-muted-foreground">
        DM unavailable
      </div>
    {/if}
  </div>
{/if}
