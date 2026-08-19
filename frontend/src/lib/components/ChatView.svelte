<script lang="ts">
  import type { Message } from "$lib/transport/transport.svelte";
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
  import UserListSidebar from "./UserListSidebar.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
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
  } from "$lib/transport/transport.svelte";
  import { roomsStore, refreshPhonebook } from "$lib/rooms.svelte";
  import { formatReactorNames } from "$lib/reaction-names";
  import {
    addToPhonebook,
    openDmConversation,
    removeFromPhonebook,
  } from "$lib/transport/dm.svelte";
  import { joinCall } from "$lib/transport/call.svelte";

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
  });

  let {
    peers,
    messages,
    inCall,
    callRoomCode,
    callPeerIds,
    callPeerRooms,
    peerNames,
    peerAvatars,
    peerColors,
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
  let replyTargetId = $state<string | null>(null);
  let reactionPickerFor = $state<string | null>(null);
  let emojiPickerPos = $state({ x: 0, y: 0 });
  let gifPickerOpen = $state(false);
  let hasMoreHistory = $state(true);
  let loadingMore = $state(false);
  let activeMessageId = $state<string | null>(null);
  let stagedFiles = $state<File[]>([]);
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

  const visibleMessages = $derived(
    messages.filter((m) => m.type !== MessageType.Reaction)
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
    autoScroll = scrollHeight - scrollTop - clientHeight < 40;
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

  function handleKeydown(e: KeyboardEvent) {
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

  function submit() {
    const text = draft.trim();
    if (!text && stagedFiles.length === 0) return;

    if (stagedFiles.length > 0) {
      sendFiles(stagedFiles, text, {
        replyTo: replyTarget
          ? {
              id: replyTarget.id,
              senderName: displayName(replyTarget),
              content:
                replyTarget.content.length > 160
                  ? `${replyTarget.content.slice(0, 157)}...`
                  : replyTarget.content,
            }
          : undefined,
      });
      clearStagedFiles();
    } else if (replyTarget) {
      sendReply(text, replyTarget);
    } else {
      sendMessage(text);
    }

    draft = "";
    replyTargetId = null;
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

  function openReactionPicker(msgId: string, e: MouseEvent) {
    emojiPickerPos = { x: e.clientX - 40, y: e.clientY - 12 };
    reactionPickerFor = msgId;
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

  function handleGifSelect(url: string) {
    sendMessage(url);
    autoScroll = true;
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

  async function copyCode() {
    await navigator.clipboard.writeText(window.location.href);
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
      if (e.key !== "Escape" || stagedFiles.length === 0) return;
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
      await openDmConversation(peerId);
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
  onclick={closeUserMenu}
  onkeydown={(e) => {
    if (e.key === "Escape") {
      closeUserMenu();
      reactionPickerFor = null;
      activeMessageId = null;
    }
  }}
/>

<div
  use:viewportHeight
  class="relative flex flex-col bg-background text-foreground font-mono overflow-hidden"
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
          <Tip text={copied ? "Copied" : "Copy room code"}>
            {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={copyCode}
            aria-label="Copy room code"
            class="hidden sm:flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
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

  {#if showCallView}
    <VoiceVideoCallView />
  {/if}

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

  <div class="flex flex-1 min-h-0 overflow-hidden">
    <div
      bind:this={messagesEl}
      onscroll={handleScroll}
      class="chat-messages flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 min-h-0"
    >
      {#if hasMoreHistory && visibleMessages.length >= 50}
        <div class="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            onclick={handleLoadMore}
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
                  <button
                    type="button"
                    class="ml-9 mb-0.5 max-w-md text-left inline-flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground/90 hover:text-foreground cursor-pointer"
                    onclick={() => jumpToMessage(msg.replyTo!.id)}
                  >
                    <Reply
                      size="16"
                      class="text-muted-foreground -ml-5 transform -scale-x-100"
                    />
                    <span class="font-semibold">{msg.replyTo.senderName}</span>
                    <span class="truncate">{msg.replyTo.content}</span>
                  </button>
                {/if}

                {#if showHeader}
                  <div class="flex items-start gap-2">
                    <div
                      role="button"
                      tabindex="0"
                      onclick={(e) => openUserMenuFromMessage(msg, e)}
                      onkeydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openUserMenuFromMessage(
                            msg,
                            e as unknown as MouseEvent
                          );
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
                      <span
                        class="text-sm font-medium {isOwn
                          ? 'text-primary'
                          : 'text-foreground'} {isOwn && displayPrefs.italicOwnName
                          ? 'italic'
                          : ''}"
                        style={isOwn
                          ? profileStore.color
                            ? `color: ${profileStore.color}`
                            : ""
                          : senderColor(msg.senderId)
                            ? `color: ${senderColor(msg.senderId)}`
                            : ""}
                      >
                        {isOwn
                          ? profileStore.nickname || "You"
                          : displayName(msg)}
                      </span>
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
                  <button
                    type="button"
                    class="size-7 inline-flex items-center justify-center rounded bg-card border border-border/70 text-muted-foreground hover:text-foreground cursor-pointer"
                    title="React"
                    aria-label="React"
                    onclick={(e) => {
                      e.stopPropagation();
                      if (reactionPickerFor === msg.id) {
                        reactionPickerFor = null;
                      } else {
                        openReactionPicker(msg.id, e as MouseEvent);
                      }
                      activeMessageId = null;
                    }}
                  >
                    <Smile class="size-3.5" />
                  </button>
                  <button
                    type="button"
                    class="size-7 inline-flex items-center justify-center rounded bg-card border border-border/70 text-muted-foreground hover:text-foreground cursor-pointer"
                    title="Reply"
                    aria-label="Reply"
                    onclick={(e) => {
                      e.stopPropagation();
                      startReply(msg);
                      activeMessageId = null;
                    }}
                  >
                    <Reply class="size-3.5" />
                  </button>
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
          <span class="truncate">{replyTarget.content}</span>
        </div>
        <button
          type="button"
          class="size-5 inline-flex items-center justify-center rounded hover:bg-muted cursor-pointer"
          onclick={() => (replyTargetId = null)}
          aria-label="Cancel reply"
        >
          <X class="size-3.5" />
        </button>
      </div>
    </div>
  {/if}

  {#if stagedFiles.length > 0}
    <div class="border-t border-border bg-muted/30 px-4 py-2">
      <div class="flex gap-2 overflow-x-auto pb-1">
        {#each stagedFiles as file (fileKey(file))}
          {@const previewUrl = getStagedPreviewURL(file)}
          <div
            class="group relative shrink-0 rounded-md border border-border/70 bg-background/80 p-1.5"
          >
            <button
              type="button"
              class="absolute right-2 top-1 z-10 hidden size-5 items-center justify-center rounded-full bg-black/70 text-white group-hover:inline-flex"
              aria-label="Remove file"
              onclick={() => removeStagedFile(file)}
            >
              <X class="size-3" />
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
        <textarea
          bind:this={textareaEl}
          bind:value={draft}
          onkeydown={handleKeydown}
          oninput={autoResize}
          placeholder="Type a message..."
          rows={1}
          class="w-full resize-none rounded-md border border-input bg-background pl-3 pr-20 py-2 text-sm text-foreground placeholder:text-muted-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring min-h-10 max-h-30 overflow-y-auto"
        ></textarea>
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

<GifPicker
  open={gifPickerOpen}
  onOpenChange={(v) => (gifPickerOpen = v)}
  onSelect={handleGifSelect}
/>

<EmojiPickerPopup
  open={reactionPickerFor !== null}
  x={emojiPickerPos.x}
  y={emojiPickerPos.y}
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
