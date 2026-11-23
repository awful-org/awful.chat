<script lang="ts">
  /**
   * The sidebar: a slim rail (direct messages, then one tile per room, then
   * create/join) beside a column with the selected room's channels or, with
   * direct messages selected, the conversations. Collapsed, it is the rail
   * alone. The bottom - plugin slots, call status, profile and controls - is
   * unchanged and spans both.
   *
   * Selection is quiet (a light surface, a light tile); the accent is kept
   * for things happening: unread badges, a speaking ring, a call going on,
   * the voice channel you are in.
   */
  import type { Room } from "$lib/storage";
  import type { Attachment } from "svelte/attachments";
  import { tick } from "svelte";
  import { flip } from "svelte/animate";
  import { cubicOut } from "svelte/easing";
  import { dropIndex, moveItem, slotTop, type RowBox } from "$lib/room-order";
  import {
    HOLD_MS,
    HOLD_SLOP_PX,
    RoomPictureUrls,
    badgeText,
    clampMenu,
    dmMenuActions,
    dmSections,
    holdRelease,
    menuFocusIndex,
    moveStep,
    pressMove,
    railPill,
    roomInitials,
    sidebarColumn,
    timeAgo,
    type DmContextAction,
    type SidebarView,
  } from "$lib/sidebar-rail";
  import { pfpBlobURL } from "$lib/storage";
  import {
    DEFAULT_CHANNEL_ID,
    channelMoveOrder,
    onScreenRoomUnread,
    type ChannelKind,
    type SidebarChannels,
  } from "$lib/sidebar-channels";
  import { notifyMenuItems } from "$lib/channel-ui";
  import { MAX_CHANNEL_NAME } from "$lib/channels";
  import {
    ArrowDown,
    ArrowUp,
    AtSign,
    Ban,
    Bell,
    BellOff,
    ChevronDown,
    CircleCheck,
    Hash,
    MessageCircle,
    MicOff,
    PanelLeftClose,
    PanelLeftOpen,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Trash2,
    Undo2,
    User,
    Users,
    Volume2,
  } from "@lucide/svelte";
  import SidebarControls from "./SidebarControls.svelte";
  import PluginWidgetSlots from "./PluginWidgetSlots.svelte";
  import GifImage from "./GifImage.svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import CallStatus from "./CallStatus.svelte";
  import { transportState, peerIdToDid } from "$lib/transport/transport.svelte";
  import { displayPrefs, setSidebarCollapsed, setSidebarWidth } from "$lib/display-prefs.svelte";
  import SidebarResizeHandle from "./SidebarResizeHandle.svelte";
  import {
    SIDEBAR_DEFAULT_PX,
    SIDEBAR_MIN_PX,
    clampSidebarWidth,
    sidebarMaxWidth,
    type SidebarDrag,
  } from "$lib/sidebar-width";

  interface DmPreview {
    text: string;
    ts: number;
  }

  interface PhonebookEntry {
    peerId: string;
    nickname: string;
    avatarUrl?: string | null;
    addedAt: number;
    inPhonebook?: boolean;
    /** A message request: listed last, under its own heading. */
    request?: boolean;
    /**
     * Soft-blocked: listed greyed under its own heading, after the
     * requests, so the block can be lifted where the conversation was.
     */
    blocked?: boolean;
  }

  interface Props {
    rooms: Room[];
    phonebook: PhonebookEntry[];
    dmPreviews: Map<string, DmPreview>;
    dmUnreadCounts: Map<string, number>;
    dmUnreadTotal: number;
    activeRoomCode: string | null;
    activeDmPeerId: string | null;
    /** What the rail has selected: the rooms, or direct messages. */
    view: SidebarView;
    onChangeView: (view: SidebarView) => void;
    unreadCounts: Map<string, number>;
    roomActivity: Map<string, number>;
    /** Rooms with a call going on: their tiles carry the live marker. */
    liveRoomCodes?: ReadonlySet<string>;
    /** The open room's channels; null while no room is open. */
    channels?: SidebarChannels | null;
    isOpen?: boolean;
    onClose?: () => void;
    /** Desktop: the rail alone. Ignored below sm, where the sidebar is a slide-over. */
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
    onSelectRoom: (code: string) => void;
    onSelectDm: (peerId: string) => void;
    onAddToPhonebook: (peerId: string) => void;
    onRemoveFromPhonebook: (peerId: string) => void;
    onRemoveDmConversation: (peerId: string) => void;
    /** Block (true) or unblock (false) the person a conversation is with. */
    onSetBlocked: (peerId: string, blocked: boolean) => void;
    dmContextActions?: DmContextAction[];
    onRemoveRoom: (code: string) => void;
    /** Pin or unpin. `rooms` already lists the pinned (pinnedAt) first. */
    onTogglePin: (code: string) => void;
    /** The full room order after a drag or keyboard move, as roomCodes. */
    onReorderRooms: (order: string[]) => void;
    onOpenCreateJoin?: () => void;
    onOpenPhonebook?: () => void;
  }

  let {
    rooms,
    phonebook,
    dmPreviews,
    dmUnreadCounts,
    dmUnreadTotal,
    activeRoomCode,
    activeDmPeerId,
    view,
    onChangeView,
    unreadCounts,
    roomActivity,
    liveRoomCodes = new Set<string>(),
    channels = null,
    isOpen = false,
    onClose,
    // The saved setting; `collapsed` below is what is drawn, which a drag
    // on the edge previews ahead of saving.
    collapsed: savedCollapsed = false,
    onToggleCollapsed,
    onSelectRoom,
    onSelectDm,
    onAddToPhonebook,
    onRemoveFromPhonebook,
    onRemoveDmConversation,
    onSetBlocked,
    dmContextActions,
    onRemoveRoom,
    onTogglePin,
    onReorderRooms,
    onOpenCreateJoin,
    onOpenPhonebook,
  }: Props = $props();

  const uid = $props.id();

  const column = $derived(sidebarColumn(view, activeRoomCode, rooms.map((r) => r.roomCode)));
  /** The room whose tile is selected: only while its channels are showing. */
  const selectedRoomCode = $derived(column.kind === "room" ? column.roomCode : null);
  const dmGroups = $derived(dmSections(phonebook));
  const dmsSelected = $derived(column.kind === "dms");
  const dmsPill = $derived(railPill(dmsSelected, dmUnreadTotal));

  // The channel on screen is being read, so it does not count as unread;
  // the room's other channels do (0 in a room with only its original chat).
  function unreadOf(code: string): number {
    if (code !== activeRoomCode) return unreadCounts.get(code) ?? 0;
    return channels ? onScreenRoomUnread(channels.text, channels.selectedTextId) : 0;
  }

  const roomName = (room: Room): string => room.name || room.roomCode;

  function roomTip(room: Room): string {
    const pinned = room.pinnedAt != null ? " · pinned" : "";
    return `${roomName(room)} · ${timeAgo(roomActivity.get(room.roomCode) ?? room.createdAt)}${pinned}`;
  }

  // ── Rail order: pinned first, then the rest, which drag ───────────────────

  // Drag-to-reorder on the rail, mouse and pen. The lifted tile follows the
  // pointer while the others slide aside (animate:flip on a PREVIEW order);
  // the order is committed once, on drop. A press only becomes a drag past a
  // few pixels, so a click still opens the room. Pointer capture keeps the
  // move/up events coming wherever the pointer goes, and the keyed {#each}
  // keeps the tile the same element as it moves, so capture survives. Touch
  // scrolls the rail instead; there, and from the keyboard, the room menu's
  // Move up / Move down and Alt+Arrow do the same.
  const SETTLE_MS = 180;
  const EDGE_PX = 40;
  const FLIP_MS = 180;
  const DRAG_SLOP_PX = 4;

  let railEl = $state<HTMLElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let drag = $state<{
    code: string;
    /** The order when the drag began; `from`/`to` index into it. */
    base: string[];
    from: number;
    to: number;
    /** Pixels from the tile's current slot to where it is drawn. */
    dy: number;
    order: string[];
    /** Released: the pointer no longer moves it. */
    dropping: boolean;
    /** Animating dy to 0, into its slot. */
    gliding: boolean;
  } | null>(null);
  // Pre-drag geometry, in the list's scroll coordinates so auto-scroll does
  // not invalidate it. Not state: nothing renders from it directly.
  let rowBoxes: RowBox[] = [];
  let startContentY = 0;
  let lastClientY = 0;
  let scrollFrame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * A press on a tile that may yet become a drag: a mouse or pen one past a
   * few pixels, a finger one once it has held still (HOLD_MS).
   */
  let press: {
    code: string;
    pointerId: number;
    x: number;
    y: number;
    touch: boolean;
    el: HTMLElement;
  } | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** A drag a held finger started: where it lifted, and whether it moved since. */
  let held: { x: number; y: number; moved: boolean } | null = null;
  /** The click that ends a drag is not a click on the room. */
  let suppressClick = false;

  function clearHold(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  }

  // Pinned rooms sit above the rest and do not drag; every index the drag
  // code uses is into `movable`, so nothing can be dropped above a pin.
  const pinnedList = $derived(rooms.filter((r) => r.pinnedAt != null));
  const pinnedSet = $derived(new Set(pinnedList.map((r) => r.roomCode)));
  const movable = $derived(rooms.filter((r) => r.pinnedAt == null));
  const roomsByCode = $derived(new Map(rooms.map((r) => [r.roomCode, r])));
  const displayRooms = $derived(
    drag
      ? drag.order.flatMap((code) => roomsByCode.get(code) ?? [])
      : movable
  );

  function contentY(clientY: number): number {
    const rect = listEl!.getBoundingClientRect();
    return clientY - rect.top + listEl!.scrollTop;
  }

  function onTilePointerDown(e: PointerEvent, roomCode: string): void {
    suppressClick = false;
    press = null;
    held = null;
    clearHold();
    if (e.button !== 0 || drag) return;
    const touch = e.pointerType === "touch";
    const p = {
      code: roomCode,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      touch,
      el: e.currentTarget as HTMLElement,
    };
    press = p;
    if (!touch) return;
    // A finger lifts the tile by holding still; a swipe (pressMove) leaves
    // first and the rail scrolls as it always did.
    holdTimer = setTimeout(() => {
      holdTimer = null;
      if (press !== p) return;
      press = null;
      if (startRoomDrag(p.el, p.pointerId, p.code, p.y, p.y)) {
        held = { x: p.x, y: p.y, moved: false };
      }
    }, HOLD_MS);
  }

  function onTilePointerMove(e: PointerEvent): void {
    if (drag) {
      lastClientY = e.clientY;
      if (held && !held.moved && Math.hypot(e.clientX - held.x, e.clientY - held.y) > HOLD_SLOP_PX) {
        held.moved = true;
      }
      updateDrag();
      return;
    }
    const p = press;
    if (!p || e.pointerId !== p.pointerId) return;
    const distance = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if (p.touch) {
      if (pressMove(distance) === "swipe") {
        press = null;
        clearHold();
      }
      return;
    }
    if (distance < DRAG_SLOP_PX) return;
    press = null;
    startRoomDrag(e.currentTarget as HTMLElement, e.pointerId, p.code, p.y, e.clientY);
  }

  /** Lift a tile. False when the rail's rows could not be measured. */
  function startRoomDrag(
    tileEl: HTMLElement,
    pointerId: number,
    roomCode: string,
    pressY: number,
    clientY: number
  ): boolean {
    if (!listEl || drag) return false;
    const from = movable.findIndex((r) => r.roomCode === roomCode);
    if (from === -1) return false;
    const listTop = listEl.getBoundingClientRect().top - listEl.scrollTop;
    rowBoxes = [...listEl.querySelectorAll<HTMLElement>("[data-drag-row]")].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - listTop, height: r.height };
    });
    if (rowBoxes.length !== movable.length) return false;
    try {
      tileEl.setPointerCapture(pointerId);
    } catch {
      // The finger already left: there is nothing to drag.
      return false;
    }
    startContentY = contentY(pressY);
    lastClientY = clientY;
    const base = movable.map((r) => r.roomCode);
    drag = {
      code: roomCode,
      base,
      from,
      to: from,
      dy: 0,
      order: base,
      dropping: false,
      gliding: false,
    };
    updateDrag();
    scrollFrame = requestAnimationFrame(autoScroll);
    return true;
  }

  function updateDrag(): void {
    if (!drag || drag.dropping) return;
    const delta = contentY(lastClientY) - startContentY;
    const { from } = drag;
    const center = rowBoxes[from].top + rowBoxes[from].height / 2 + delta;
    const to = dropIndex(rowBoxes, from, center);
    if (to !== drag.to) {
      drag.to = to;
      drag.order = moveItem(drag.base, from, to);
    }
    drag.dy = rowBoxes[from].top + delta - slotTop(rowBoxes, from, to);
  }

  // Dragging near the rail's edge scrolls it, so a room can travel further
  // than the part of the rail on screen.
  function autoScroll(): void {
    if (!drag || drag.dropping || !listEl) return;
    const rect = listEl.getBoundingClientRect();
    const speed =
      lastClientY < rect.top + EDGE_PX
        ? -Math.ceil((rect.top + EDGE_PX - lastClientY) / 4)
        : lastClientY > rect.bottom - EDGE_PX
          ? Math.ceil((lastClientY - (rect.bottom - EDGE_PX)) / 4)
          : 0;
    if (speed !== 0) {
      listEl.scrollTop += speed;
      updateDrag();
    }
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function finishDrag(commit: boolean): void {
    if (!drag || drag.dropping) return;
    cancelAnimationFrame(scrollFrame);
    const d = drag;
    const heldTop = slotTop(rowBoxes, d.from, d.to) + d.dy;
    if (commit && d.to !== d.from) {
      onReorderRooms(d.order);
    } else {
      d.to = d.from;
      d.order = d.base;
    }
    d.dropping = true;
    // A cancel moves the tile's slot back under it; keep it drawn where it is
    // held for this frame, then glide it into the slot instead of snapping.
    d.dy = heldTop - slotTop(rowBoxes, d.from, d.to);
    requestAnimationFrame(() => {
      if (drag !== d) return;
      d.gliding = true;
      d.dy = 0;
    });
    // Unchanged from the list this replaced: the preview order is held for
    // the glide, by which time the store has the committed order.
    settleTimer = setTimeout(() => {
      drag = null;
      settleTimer = null;
    }, SETTLE_MS + 20);
  }

  function onTilePointerUp(e: PointerEvent): void {
    press = null;
    clearHold();
    const hold = held;
    held = null;
    if (!drag) return;
    const tile = e.currentTarget as HTMLElement;
    if (tile.hasPointerCapture(e.pointerId)) tile.releasePointerCapture(e.pointerId);
    const up = e.type === "pointerup";
    suppressClick = up;
    // A held tile let go where it lifted: the long press's menu, as before.
    if (hold && up && holdRelease(hold.moved) === "menu") {
      const code = drag.code;
      finishDrag(false);
      openMenuUnder(tile, { kind: "room", code });
      return;
    }
    finishDrag(up);
  }

  /**
   * The platform's own long press (Android's context menu) on a tile a
   * finger is holding: the hold already answers it - a drag, or the menu on
   * release - so it does not open a second time underneath.
   */
  function onTileContextMenu(e: MouseEvent, roomCode: string, canDrag: boolean): void {
    if (canDrag && (press?.touch || held || drag)) {
      e.preventDefault();
      return;
    }
    openMenu(e, { kind: "room", code: roomCode });
  }

  // While a finger drags a tile, the rail must not scroll under it. Only
  // then: before the hold a swipe is a scroll, and is left alone. Not a
  // passive listener, or preventDefault is ignored.
  $effect(() => {
    const el = listEl;
    if (!el) return;
    const onTouchMove = (e: TouchEvent) => {
      if (held && drag) e.preventDefault();
    };
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => el.removeEventListener("touchmove", onTouchMove);
  });

  function onTileClick(code: string): void {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    onSelectRoom(code);
  }

  function selectDms(): void {
    // Collapsed, the rail lists the conversations itself, under this
    // button; pressed again it goes back to the rooms. Neither expands the
    // sidebar nor touches the saved collapsed setting.
    if (collapsed) onChangeView(view === "dms" ? "rooms" : "dms");
    else onChangeView("dms");
  }

  // ── Room pictures (sidebar-rail.ts RoomPictureUrls) ───────────────────────

  const pictureUrls = new RoomPictureUrls(
    (data) => pfpBlobURL(data),
    (url) => URL.revokeObjectURL(url)
  );
  /** roomCode -> the picture to draw on its tile; initials without one. */
  let pictures = $state(new Map<string, string>());
  $effect(() => {
    pictures = pictureUrls.sync(rooms);
  });
  $effect(() => () => pictureUrls.dispose());

  /**
   * Arrow keys walk the rail; Alt+Arrow moves a room tile one place, the
   * keyboard twin of the drag.
   */
  function onRailKeydown(e: KeyboardEvent, roomCode: string | null = null): void {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const step = e.key === "ArrowUp" ? -1 : 1;
    if (e.altKey) {
      if (!roomCode || drag || pinnedSet.has(roomCode)) return;
      e.preventDefault();
      const next = moveStep(movable.map((r) => r.roomCode), roomCode, step);
      if (next) onReorderRooms(next);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    const items = [...(railEl?.querySelectorAll<HTMLElement>("[data-rail-item]") ?? [])];
    const next = items[items.indexOf(e.currentTarget as HTMLElement) + step];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }

  function rowStyle(roomCode: string): string {
    if (drag?.code !== roomCode) return "";
    const lift = drag.dropping ? "" : " scale(1.05)";
    const glide = drag.gliding
      ? `transition: transform ${SETTLE_MS}ms cubic-bezier(0.2, 0, 0, 1);`
      : "";
    return `transform: translateY(${drag.dy}px)${lift}; ${glide}`;
  }

  function onDragKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && drag && !drag.dropping) {
      e.preventDefault();
      finishDrag(false);
    }
  }

  $effect(() => () => {
    cancelAnimationFrame(scrollFrame);
    if (settleTimer) clearTimeout(settleTimer);
    clearHold();
  });

  /** Run the tooltip trigger's own handler, then ours. */
  function chain<E extends Event>(
    props: Record<string, unknown>,
    key: string,
    mine: (e: E) => void
  ): (e: E) => void {
    const theirs = props[key] as ((e: E) => void) | undefined;
    return (e) => {
      theirs?.(e);
      mine(e);
    };
  }

  // ── Menus: room, conversation, channel ────────────────────────────────────

  type MenuTarget =
    | { kind: "room"; code: string }
    | { kind: "dm"; peerId: string }
    | { kind: "channel"; channelKind: ChannelKind; id: string };

  interface MenuItem {
    id: string;
    label: string;
    icon: typeof Pin;
    destructive?: boolean;
    /** Destroys stored history: takes a second click, like the erase flows in settings. */
    confirm?: boolean;
    run: () => void;
  }

  let menu = $state<(MenuTarget & { x: number; y: number }) | null>(null);
  /** The armed item of a two-click confirm. */
  let confirming = $state<string | null>(null);
  /** Where focus goes back to when the menu closes. */
  let menuOpener: HTMLElement | null = null;

  const MENU_WIDTH = 240;
  const MENU_ITEM_PX = 36;

  function itemsFor(t: MenuTarget): MenuItem[] {
    if (t.kind === "room") {
      const code = t.code;
      const pinned = pinnedSet.has(code);
      const order = movable.map((r) => r.roomCode);
      const up = pinned ? null : moveStep(order, code, -1);
      const down = pinned ? null : moveStep(order, code, 1);
      return [
        {
          id: "pin",
          label: pinned ? "Unpin" : "Pin to top",
          icon: pinned ? PinOff : Pin,
          run: () => onTogglePin(code),
        },
        ...(up ? [{ id: "up", label: "Move up", icon: ArrowUp, run: () => onReorderRooms(up) }] : []),
        ...(down
          ? [{ id: "down", label: "Move down", icon: ArrowDown, run: () => onReorderRooms(down) }]
          : []),
        {
          id: "remove",
          label: "Remove room",
          icon: Trash2,
          destructive: true,
          confirm: true,
          run: () => onRemoveRoom(code),
        },
      ];
    }
    if (t.kind === "dm") {
      const entry = phonebook.find((e) => e.peerId === t.peerId);
      const actions = dmContextActions?.length
        ? dmContextActions
        : dmMenuActions(t.peerId, {
            blocked: !!entry?.blocked,
            inPhonebook: !!entry?.inPhonebook,
          });
      return actions.map((a): MenuItem => {
        switch (a.type) {
          case "add":
            return { id: a.type, label: "Add to phonebook", icon: User, run: () => onAddToPhonebook(a.peerId) };
          case "removePhonebook":
            return {
              id: a.type,
              label: "Remove from phonebook",
              icon: Trash2,
              destructive: true,
              run: () => onRemoveFromPhonebook(a.peerId),
            };
          case "block":
            return { id: a.type, label: "Block", icon: Ban, destructive: true, run: () => onSetBlocked(a.peerId, true) };
          case "unblock":
            return { id: a.type, label: "Unblock", icon: CircleCheck, run: () => onSetBlocked(a.peerId, false) };
          case "removeConversation":
            return {
              id: a.type,
              label: "Remove conversation",
              icon: Trash2,
              destructive: true,
              confirm: true,
              run: () => onRemoveDmConversation(a.peerId),
            };
        }
      });
    }
    const ch = channels;
    if (!ch) return [];
    const { channelKind: kind, id } = t;
    const order = (kind === "text" ? ch.text : ch.voice).map((c) => c.id);
    const reorder = ch.onReorderChannels;
    const up = reorder ? channelMoveOrder(order, id, -1) : null;
    const down = reorder ? channelMoveOrder(order, id, 1) : null;
    const rename = ch.onRenameChannel;
    const remove = ch.onDeleteChannel;
    const setNotify = ch.onSetNotify;
    const text = kind === "text" ? ch.text.find((c) => c.id === id) : undefined;
    const notify =
      setNotify && text?.notifyMode
        ? notifyMenuItems({
            isDefault: id === DEFAULT_CHANNEL_ID,
            mode: text.notifyMode,
            own: text.notifyOwn ?? null,
            roomMode: ch.roomNotifyMode ?? "all",
          }).map(
            (n): MenuItem => ({
              id: `notify-${n.id}`,
              label: n.label,
              icon:
                n.id === "mute"
                  ? BellOff
                  : n.id === "mentions"
                    ? AtSign
                    : n.id === "follow"
                      ? Undo2
                      : Bell,
              run: () => setNotify(id, n.mode),
            })
          )
        : [];
    return [
      ...notify,
      ...(rename ? [{ id: "rename", label: "Rename channel", icon: Pencil, run: () => startRename(kind, id) }] : []),
      ...(reorder && up ? [{ id: "up", label: "Move up", icon: ArrowUp, run: () => reorder(kind, up) }] : []),
      ...(reorder && down ? [{ id: "down", label: "Move down", icon: ArrowDown, run: () => reorder(kind, down) }] : []),
      // The room's own chat and call are not deleted from here.
      ...(remove && id !== DEFAULT_CHANNEL_ID
        ? [
            {
              id: "delete",
              label: "Delete channel",
              icon: Trash2,
              destructive: true,
              confirm: true,
              run: () => remove(kind, id),
            },
          ]
        : []),
    ];
  }

  const menuItems = $derived(menu ? itemsFor(menu) : []);

  /**
   * Open a menu at the pointer, or under the control when there is no
   * pointer (a keyboard activation, or a button made to open it).
   */
  function openMenu(e: MouseEvent, target: MenuTarget, below = false): void {
    const items = itemsFor(target);
    if (items.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    const noPointer =
      below || (e.type === "click" && e.detail === 0) || (e.clientX === 0 && e.clientY === 0);
    showMenu(el, target, items.length, noPointer ? null : { x: e.clientX, y: e.clientY });
  }

  /**
   * Open a menu under a control with no event to hang it on: a tile a finger
   * held and let go. The click the release may still produce lands on the
   * window after this and must not close it again (keepMenuOnce).
   */
  function openMenuUnder(el: HTMLElement, target: MenuTarget): void {
    const items = itemsFor(target);
    if (items.length === 0) return;
    keepMenuOnce = true;
    showMenu(el, target, items.length, null);
  }

  let keepMenuOnce = false;

  function showMenu(
    el: HTMLElement,
    target: MenuTarget,
    count: number,
    pointer: { x: number; y: number } | null
  ): void {
    const rect = el.getBoundingClientRect();
    const at = clampMenu(
      pointer ? pointer.x : rect.left,
      pointer ? pointer.y : rect.bottom + 4,
      { width: MENU_WIDTH, height: count * MENU_ITEM_PX + 8 },
      { width: window.innerWidth, height: window.innerHeight }
    );
    menuOpener = el;
    confirming = null;
    menu = { ...target, ...at };
  }

  function closeMenu(restoreFocus: boolean): void {
    if (!menu) return;
    menu = null;
    confirming = null;
    if (restoreFocus && menuOpener?.isConnected) menuOpener.focus();
    menuOpener = null;
  }

  function runItem(item: MenuItem): void {
    if (item.confirm && confirming !== item.id) {
      confirming = item.id;
      return;
    }
    item.run();
    closeMenu(true);
  }

  function onMenuKeydown(e: KeyboardEvent): void {
    if (e.key === "Tab") {
      e.preventDefault();
      closeMenu(true);
      return;
    }
    const items = [
      ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ];
    const i = menuFocusIndex(e.key, items.indexOf(document.activeElement as HTMLElement), items.length);
    if (i === null) return;
    e.preventDefault();
    items[i].focus();
  }

  const focusFirstItem: Attachment<HTMLElement> = (el) => {
    el.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  };

  const menuLabel = $derived(
    menu?.kind === "room"
      ? `${roomsByCode.get(menu.code)?.name || "Room"} options`
      : menu?.kind === "dm"
        ? "Conversation options"
        : "Channel options"
  );

  // ── Conversations ─────────────────────────────────────────────────────────

  const peerColors = $derived(transportState.peerColors);

  function colorForPeer(peerId: string): string | undefined {
    const did = peerIdToDid(peerId);
    if (!displayPrefs.showPeerNicknameColors) return undefined;
    return peerColors.get(peerId) ?? (did ? peerColors.get(did) : undefined);
  }

  /** A blocked conversation does not open: its row offers its menu instead. */
  function selectDmEntry(e: MouseEvent, entry: PhonebookEntry): void {
    if (!entry.blocked) {
      onSelectDm(entry.peerId);
      return;
    }
    openMenu(e, { kind: "dm", peerId: entry.peerId });
  }

  // ── Channels ──────────────────────────────────────────────────────────────

  let renaming = $state<{ kind: ChannelKind; id: string } | null>(null);
  let renameValue = $state("");
  let columnEl = $state<HTMLElement | null>(null);

  function startRename(kind: ChannelKind, id: string): void {
    const list = kind === "text" ? channels?.text : channels?.voice;
    renameValue = list?.find((c) => c.id === id)?.name ?? "";
    creating = null;
    renaming = { kind, id };
  }

  async function endRename(commit: boolean, refocus: boolean): Promise<void> {
    const r = renaming;
    if (!r) return;
    renaming = null;
    const list = r.kind === "text" ? channels?.text : channels?.voice;
    const name = renameValue.trim();
    if (commit && name && name !== list?.find((c) => c.id === r.id)?.name) {
      channels?.onRenameChannel?.(r.kind, r.id, name);
    }
    if (!refocus) return;
    await tick();
    columnEl
      ?.querySelector<HTMLElement>(`[data-channel="${r.kind}:${CSS.escape(r.id)}"]`)
      ?.focus();
  }

  const focusAndSelect: Attachment<HTMLInputElement> = (el) => {
    el.focus();
    el.select();
  };

  /** Alt+Arrow moves a channel one place; F2 renames it. */
  function onChannelKeydown(e: KeyboardEvent, kind: ChannelKind, id: string): void {
    const ch = channels;
    if (!ch) return;
    if (e.key === "F2" && ch.onRenameChannel) {
      e.preventDefault();
      startRename(kind, id);
      return;
    }
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !ch.onReorderChannels) return;
    e.preventDefault();
    const order = (kind === "text" ? ch.text : ch.voice).map((c) => c.id);
    const next = channelMoveOrder(order, id, e.key === "ArrowUp" ? -1 : 1);
    if (next) ch.onReorderChannels(kind, next);
  }

  const channelMenus = $derived(
    !!channels &&
      !!(
        channels.onRenameChannel ||
        channels.onDeleteChannel ||
        channels.onReorderChannels ||
        channels.onSetNotify
      )
  );

  // A new channel is named before it exists: "+" opens a field at the end of
  // its section, and Enter (or leaving the field with a name in it) makes it.
  let creating = $state<ChannelKind | null>(null);
  let createValue = $state("");

  function startCreate(kind: ChannelKind): void {
    renaming = null;
    createValue = "";
    creating = kind;
  }

  async function endCreate(commit: boolean, refocus: boolean): Promise<void> {
    const kind = creating;
    if (!kind) return;
    creating = null;
    const name = createValue.trim();
    if (commit && name) channels?.onCreateChannel?.(kind, name);
    if (!refocus) return;
    await tick();
    columnEl?.querySelector<HTMLElement>(`[data-create="${kind}"]`)?.focus();
  }

  // Another room's column, or none: a half-typed name does not follow.
  $effect(() => {
    void activeRoomCode;
    creating = null;
    renaming = null;
  });

  // ── Width (sidebar-width.ts) ──────────────────────────────────────────────
  // The expanded width on a desktop, dragged at the right edge. Drawn from
  // the saved width clamped to this window, so a width saved on a big
  // screen does not swallow a small one, and comes back with the big one.

  let viewportWidth = $state(typeof window === "undefined" ? 0 : window.innerWidth);
  /** While the edge is dragged: the rail or the width to draw, not yet saved. */
  let dragPreview = $state<SidebarDrag | null>(null);
  /** Drawn as the rail alone: the saved setting, or where a drag has taken it. */
  const collapsed = $derived(dragPreview ? dragPreview.collapsed : savedCollapsed);
  /** The open width: drawn when open, and kept (not drawn) when collapsed. */
  const sidebarWidth = $derived(
    clampSidebarWidth(
      (dragPreview && !dragPreview.collapsed ? dragPreview.width : null) ??
        displayPrefs.sidebarWidth ??
        SIDEBAR_DEFAULT_PX,
      viewportWidth
    )
  );
  /**
   * A window too narrow for any range (a phone, a small tablet) has no
   * handle. Not tied to `collapsed`: the handle sits on the rail's edge too,
   * and must stay the same element while a drag flips the sidebar between
   * the two, or its pointer capture (and the drag) would go with it.
   */
  const resizable = $derived(sidebarMaxWidth(viewportWidth) > SIDEBAR_MIN_PX);

  // ── Shared classes ────────────────────────────────────────────────────────

  const focusRing =
    "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
  const rowFocus =
    "outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
  const iconButton = `inline-flex size-8 max-sm:size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground cursor-pointer ${focusRing}`;
  const badge =
    "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold leading-none text-primary-foreground tabular-nums";
  /** A muted channel's count: still there, as a muted room's is, but quiet. */
  const quietBadge =
    "inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full bg-sidebar-accent px-1.5 text-[10px] font-bold leading-none text-muted-foreground tabular-nums";
  const railBadge =
    "pointer-events-none absolute -top-1 right-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground tabular-nums ring-2 ring-sidebar";
  const tile = `relative flex size-12 sm:size-11 shrink-0 items-center justify-center text-sm font-bold transition-[border-radius,background-color,color] duration-150 cursor-pointer ${focusRing}`;
  const sectionTitle = "select-none px-2 text-[11px] font-semibold text-muted-foreground";
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svelte:window
  bind:innerWidth={viewportWidth}
  onpointerdown={() => (keepMenuOnce = false)}
  onclick={() => {
    if (keepMenuOnce) {
      keepMenuOnce = false;
      return;
    }
    closeMenu(false);
  }}
  onkeydown={(e) => {
    onDragKeydown(e);
    if (e.key === "Escape") closeMenu(true);
  }}
/>

<!-- Mobile backdrop -->
{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-30 bg-black/50 sm:hidden"
    onclick={onClose}
    aria-hidden="true"
  ></div>
{/if}

<!-- sm:relative, not static: the resize handle sits on its right edge.
     The width animates on collapse and on a key press, not under a drag
     (including a drag that folds it to the rail and back). -->
<aside
  id="{uid}-sidebar"
  aria-label="Sidebar"
  style="--sidebar-w: {sidebarWidth}px"
  class="flex h-dvh w-80 max-w-[calc(100vw-3rem)] shrink-0 flex-col border-r border-sidebar-border bg-sidebar
      fixed inset-y-0 left-0 z-40 transition-transform duration-200
      sm:relative sm:max-w-none sm:translate-x-0 sm:z-auto {dragPreview === null ? 'sm:transition-[width] sm:duration-200' : ''}
      {collapsed ? 'sm:w-14' : 'sm:w-(--sidebar-w)'}
      {isOpen ? 'translate-x-0' : '-translate-x-full'}"
>
  <div class="flex min-h-0 flex-1">
    <!-- The rail. Not selectable, and no iOS callout: a long press is the
         touch way to open a tile's menu, and it also selected its text. -->
    <nav
      bind:this={railEl}
      aria-label="Rooms"
      class="flex shrink-0 flex-col bg-background/40 select-none [-webkit-touch-callout:none] {collapsed
        ? 'w-14'
        : 'w-16 border-r border-sidebar-border'}"
    >
      {#if collapsed}
        <!-- Level with the chat header (h-13 plus the safe area), as before. -->
        <div
          class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center justify-center border-b border-sidebar-border pt-[env(safe-area-inset-top)]"
        >
          <Tip text="Expand sidebar" side="right">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={onToggleCollapsed}
                aria-label="Expand sidebar"
                class={iconButton}
              >
                <PanelLeftOpen class="size-4" />
              </button>
            {/snippet}
          </Tip>
        </div>
      {/if}

      <div
        class="flex shrink-0 flex-col items-center gap-2 {collapsed
          ? 'pt-3'
          : 'pt-[calc(0.75rem+env(safe-area-inset-top))]'}"
      >
        <div class="group relative flex w-full justify-center">
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height] duration-150 {dmsPill ===
            'selected'
              ? 'h-8'
              : dmsPill === 'unread'
                ? 'h-2 group-hover:h-5'
                : 'h-0 group-hover:h-5'}"
          ></span>
          <Tip text={collapsed && dmsSelected ? "Back to rooms" : "Direct messages"} side="right">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                data-rail-item
                aria-current={dmsSelected ? "true" : undefined}
                onclick={chain(props, "onclick", selectDms)}
                onkeydown={(e) => onRailKeydown(e)}
                class="{tile} rounded-2xl {dmsSelected
                  ? 'bg-foreground text-background'
                  : 'bg-sidebar-accent text-muted-foreground hover:text-foreground'}"
              >
                <MessageCircle class="size-5" aria-hidden="true" />
                <span class="sr-only">
                  Direct messages{dmUnreadTotal > 0 ? `, ${dmUnreadTotal} unread` : ""}
                </span>
              </button>
            {/snippet}
          </Tip>
          {#if dmUnreadTotal > 0}
            <span aria-hidden="true" class={railBadge}>{badgeText(dmUnreadTotal)}</span>
          {/if}
        </div>
        <div class="h-px w-7 bg-sidebar-border" aria-hidden="true"></div>
      </div>

      <!-- Many rooms scroll here; the bottom of the sidebar stays put. -->
      <div
        bind:this={listEl}
        class="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden pt-2 pb-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {#snippet roomTile(room: Room, canDrag: boolean, props: Record<string, unknown>)}
          {@const code = room.roomCode}
          {@const selected = selectedRoomCode === code}
          {@const unread = unreadOf(code)}
          {@const live = liveRoomCodes.has(code)}
          {@const lifted = drag?.code === code}
          {@const picture = pictures.get(code)}
          <button
            {...props}
            type="button"
            data-rail-item
            aria-current={selected ? "true" : undefined}
            aria-keyshortcuts={canDrag ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
            onclick={chain(props, "onclick", () => onTileClick(code))}
            oncontextmenu={(e) => onTileContextMenu(e, code, canDrag)}
            onkeydown={(e) => onRailKeydown(e, code)}
            onpointerdown={chain(props, "onpointerdown", (e: PointerEvent) => {
              if (canDrag) onTilePointerDown(e, code);
            })}
            onpointermove={chain(props, "onpointermove", (e: PointerEvent) => {
              if (canDrag) onTilePointerMove(e);
            })}
            onpointerup={chain(props, "onpointerup", (e: PointerEvent) => {
              if (canDrag) onTilePointerUp(e);
            })}
            onpointercancel={canDrag ? onTilePointerUp : undefined}
            class="{tile} {selected
              ? 'rounded-2xl bg-foreground text-background'
              : 'rounded-[50%] bg-sidebar-accent text-muted-foreground hover:text-foreground'} {lifted
              ? 'cursor-grabbing shadow-lg ring-1 ring-border'
              : ''} {picture ? 'overflow-hidden' : ''}"
          >
            {#if picture}
              <GifImage src={picture} alt="" class="size-full object-cover" animate="hover" />
            {:else}
              <span aria-hidden="true" class="max-w-full truncate px-1">{roomInitials(room.name, room.roomCode)}</span>
            {/if}
            <!-- The name, for screen readers and for anything that reads the
                 tile's text. -->
            <span class="sr-only">
              {roomName(room)}{room.pinnedAt != null ? ", pinned" : ""}{unread > 0
                ? `, ${unread} unread`
                : ""}{live ? ", call going on" : ""}
            </span>
          </button>
          {#if live}
            <span
              aria-hidden="true"
              class="pointer-events-none absolute -bottom-0.5 right-1.5 flex size-4 items-center justify-center rounded-full bg-sidebar text-primary"
            >
              <Volume2 class="size-2.5" strokeWidth={3} />
            </span>
          {/if}
          {#if unread > 0}
            <span aria-hidden="true" class={railBadge}>{badgeText(unread)}</span>
          {/if}
        {/snippet}

        {#snippet pill(room: Room)}
          {@const p = railPill(selectedRoomCode === room.roomCode, unreadOf(room.roomCode))}
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height] duration-150 {p ===
            'selected'
              ? 'h-8'
              : p === 'unread'
                ? 'h-2 group-hover:h-5'
                : 'h-0 group-hover:h-5'}"
          ></span>
        {/snippet}

        <!-- Collapsed with direct messages selected: the conversations, as
             the column lists them (sections, badges, menus), above the rooms. -->
        {#if collapsed && dmsSelected}
          {#each dmGroups as group, gi (group.title ?? "")}
            {#if gi > 0}
              <div class="h-px w-7 shrink-0 bg-sidebar-border" aria-hidden="true"></div>
            {/if}
            {#each group.entries as entry (entry.peerId)}
              {@render dmTile(entry, group.title)}
            {/each}
          {/each}
          {#if phonebook.length > 0 && rooms.length > 0}
            <div class="h-px w-7 shrink-0 bg-sidebar-border" aria-hidden="true"></div>
          {/if}
        {/if}

        <!-- Pinned: on top, in pin order, and not draggable. -->
        {#each pinnedList as room (room.roomCode)}
          <div
            class="group relative flex w-full shrink-0 justify-center"
            animate:flip={{ duration: FLIP_MS, easing: cubicOut }}
          >
            {@render pill(room)}
            <Tip text={roomTip(room)} side="right">
              {#snippet children(props)}
                {@render roomTile(room, false, props)}
              {/snippet}
            </Tip>
          </div>
        {/each}
        {#if pinnedList.length > 0 && displayRooms.length > 0}
          <div class="h-px w-7 shrink-0 bg-sidebar-border" aria-hidden="true"></div>
        {/if}
        {#each displayRooms as room (room.roomCode)}
          {@const lifted = drag?.code === room.roomCode}
          <div
            data-drag-row
            animate:flip={{ duration: lifted ? 0 : FLIP_MS, easing: cubicOut }}
            style={rowStyle(room.roomCode)}
            class="group relative flex w-full shrink-0 justify-center {lifted ? 'z-10' : ''}"
          >
            {@render pill(room)}
            <Tip text={roomTip(room)} side="right">
              {#snippet children(props)}
                {@render roomTile(room, true, props)}
              {/snippet}
            </Tip>
          </div>
        {/each}

        {#if onOpenCreateJoin}
          <Tip text="Create or join a room" side="right">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                data-rail-item
                onclick={chain(props, "onclick", () => onOpenCreateJoin?.())}
                onkeydown={(e) => onRailKeydown(e)}
                aria-label="Create or join a room"
                class="{tile} rounded-2xl border border-dashed border-sidebar-border text-muted-foreground hover:border-solid hover:bg-sidebar-accent hover:text-foreground"
              >
                <Plus class="size-5" aria-hidden="true" />
              </button>
            {/snippet}
          </Tip>
        {/if}
      </div>
    </nav>

    {#if !collapsed}
      <div bind:this={columnEl} class="flex min-w-0 flex-1 flex-col">
        <!-- h-13 is shared with the chat header (ChatView) so they align.
             The safe-area inset is ADDED to that height rather than eaten out
             of it: the sidebar is `fixed inset-y-0` on a phone, so with a
             translucent status bar its first row sat under the clock. -->
        <div
          class="flex h-[calc(3.25rem+env(safe-area-inset-top))] shrink-0 items-center gap-1 border-b border-sidebar-border px-2 pt-[env(safe-area-inset-top)]"
        >
          <Tip text="Collapse sidebar" side="bottom">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={onToggleCollapsed}
                aria-label="Collapse sidebar"
                class={iconButton}
              >
                <PanelLeftClose class="size-4" />
              </button>
            {/snippet}
          </Tip>
          <h2 class="min-w-0 flex-1 truncate px-1 text-sm font-bold">
            {#if column.kind === "room"}
              {roomName(roomsByCode.get(column.roomCode)!)}
            {:else if column.kind === "dms"}
              Direct messages
            {:else}
              Rooms
            {/if}
          </h2>
          {#if column.kind === "room"}
            {@const code = column.roomCode}
            {@const open = menu?.kind === "room" && menu.code === code}
            <Tip text="Room options" side="bottom">
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  aria-label="Room options"
                  aria-haspopup="menu"
                  aria-expanded={open}
                  onclick={chain(props, "onclick", (e: MouseEvent) => {
                    if (open) {
                      e.stopPropagation();
                      closeMenu(false);
                    } else {
                      openMenu(e, { kind: "room", code }, true);
                    }
                  })}
                  class={iconButton}
                >
                  <ChevronDown class="size-4 transition-transform {open ? 'rotate-180' : ''}" />
                </button>
              {/snippet}
            </Tip>
          {:else if column.kind === "dms" && onOpenPhonebook}
            <Tip text="Phonebook" side="bottom">
              {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  onclick={onOpenPhonebook}
                  aria-label="Open phonebook"
                  class={iconButton}
                >
                  <Users class="size-4" />
                </button>
              {/snippet}
            </Tip>
          {/if}
        </div>

        <!-- Many channels or conversations scroll here. -->
        <div class="min-h-0 flex-1 overflow-y-auto px-2 py-3 select-none [-webkit-touch-callout:none]">
          {#if column.kind === "room" && channels}
            {@render channelList()}
          {:else if column.kind === "dms"}
            {@render dmList()}
          {:else if column.kind === "rooms"}
            {@render roomList()}
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if !collapsed}
    <PluginWidgetSlots />
  {/if}
  <CallStatus {collapsed} />
  <SidebarControls {collapsed} />

  {#if resizable}
    <!-- Collapses and expands through the same saved setting as the
         collapse button and Ctrl+B, so the three never disagree. -->
    <SidebarResizeHandle
      width={sidebarWidth}
      {collapsed}
      {viewportWidth}
      controls="{uid}-sidebar"
      onpreview={(state) => (dragPreview = state)}
      onwidth={setSidebarWidth}
      oncollapse={setSidebarCollapsed}
    />
  {/if}
</aside>

{#snippet dmTile(entry: PhonebookEntry, section: string | null)}
  {@const selected = activeDmPeerId === entry.peerId}
  {@const unread = dmUnreadCounts.get(entry.peerId) ?? 0}
  {@const color = colorForPeer(entry.peerId)}
  {@const p = railPill(selected, unread)}
  <div class="group relative flex w-full shrink-0 justify-center">
    <span
      aria-hidden="true"
      class="pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height] duration-150 {p ===
      'selected'
        ? 'h-8'
        : p === 'unread'
          ? 'h-2 group-hover:h-5'
          : 'h-0 group-hover:h-5'}"
    ></span>
    <Tip text={entry.nickname} side="right">
      {#snippet children(props)}
        <button
          {...props}
          type="button"
          data-rail-item
          aria-current={selected ? "page" : undefined}
          aria-haspopup={entry.blocked ? "menu" : undefined}
          onclick={chain(props, "onclick", (e: MouseEvent) => selectDmEntry(e, entry))}
          oncontextmenu={(e) => openMenu(e, { kind: "dm", peerId: entry.peerId })}
          onkeydown={(e) => onRailKeydown(e)}
          style={color ? `color: ${color}` : ""}
          class="{tile} overflow-hidden bg-secondary text-secondary-foreground {selected
            ? 'rounded-2xl'
            : 'rounded-[50%]'} {entry.blocked ? 'opacity-60 grayscale' : ''}"
        >
          {#if entry.avatarUrl}
            <GifImage src={entry.avatarUrl} alt="" class="size-full object-cover" animate="hover" />
          {:else}
            <span aria-hidden="true">{(entry.nickname || "?").charAt(0).toUpperCase()}</span>
          {/if}
          <span class="sr-only">
            {entry.nickname}{section === "Requests" ? ", message request" : ""}{entry.blocked
              ? ", blocked"
              : ""}{unread > 0 ? `, ${unread} unread` : ""}
          </span>
        </button>
      {/snippet}
    </Tip>
    {#if unread > 0}
      <span aria-hidden="true" class={railBadge}>{badgeText(unread)}</span>
    {/if}
  </div>
{/snippet}

{#snippet sectionHeader(id: string, title: string, kind: ChannelKind, first: boolean)}
  <div class="flex items-center pr-1 {first ? 'pb-1.5' : 'pt-4 pb-1.5'}">
    <h3 {id} class="{sectionTitle} flex-1">{title}</h3>
    {#if channels?.onCreateChannel}
      <Tip text="Create a {kind} channel" side="top">
        {#snippet children(props)}
          <!-- The visible glyph is small; on a phone its hit area is not. -->
          <button
            {...props}
            type="button"
            data-create={kind}
            aria-label="Add a {kind} channel"
            aria-expanded={creating === kind}
            onclick={chain(props, "onclick", () => (creating === kind ? void endCreate(false, false) : startCreate(kind)))}
            class="relative inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground cursor-pointer max-sm:after:absolute max-sm:after:-inset-3 {focusRing}"
          >
            <Plus class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
    {/if}
  </div>
{/snippet}

{#snippet renameInput(kind: ChannelKind)}
  <input
    type="text"
    bind:value={renameValue}
    aria-label="Channel name"
    maxlength={MAX_CHANNEL_NAME}
    {@attach focusAndSelect}
    onkeydown={(e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void endRename(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        void endRename(false, true);
      }
    }}
    onblur={() => void endRename(true, false)}
    class="h-8 max-sm:h-11 w-full rounded-md border border-input bg-background pr-2 text-sm text-foreground select-text {kind ===
    'voice'
      ? 'pl-8'
      : 'pl-7'} {rowFocus}"
  />
{/snippet}

{#snippet createInput(kind: ChannelKind)}
  <li class="relative">
    {#if kind === "voice"}
      <Volume2 class="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    {:else}
      <Hash class="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    {/if}
    <input
      type="text"
      bind:value={createValue}
      aria-label="New {kind} channel name"
      placeholder="new-channel"
      maxlength={MAX_CHANNEL_NAME}
      {@attach focusAndSelect}
      onkeydown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void endCreate(true, true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          void endCreate(false, true);
        }
      }}
      onblur={() => void endCreate(true, false)}
      class="h-8 max-sm:h-11 w-full rounded-md border border-input bg-background pr-2 text-sm text-foreground select-text placeholder:text-muted-foreground/60 {kind ===
      'voice'
        ? 'pl-8'
        : 'pl-7'} {rowFocus}"
    />
  </li>
{/snippet}

{#snippet channelList()}
  {@const ch = channels!}
  <section aria-labelledby="{uid}-text">
    {@render sectionHeader(`${uid}-text`, "Text", "text", true)}
    <ul class="flex flex-col gap-0.5">
      {#each ch.text as channel (channel.id)}
        {@const selected = ch.selectedTextId === channel.id}
        {@const unread = selected ? 0 : channel.unread}
        <li class="relative">
          {#if renaming?.kind === "text" && renaming.id === channel.id}
            <Hash class="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            {@render renameInput("text")}
          {:else}
            <button
              type="button"
              data-channel="text:{channel.id}"
              aria-current={selected ? "page" : undefined}
              onclick={() => ch.onSelectChannel(channel.id)}
              oncontextmenu={channelMenus
                ? (e) => openMenu(e, { kind: "channel", channelKind: "text", id: channel.id })
                : undefined}
              onkeydown={(e) => onChannelKeydown(e, "text", channel.id)}
              class="flex h-8 max-sm:h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors cursor-pointer {rowFocus} {selected
                ? 'bg-sidebar-accent font-semibold text-foreground'
                : unread > 0 && !channel.muted
                  ? 'font-bold text-foreground hover:bg-sidebar-accent/50'
                  : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'}"
            >
              <Hash class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate">{channel.name}</span>
              {#if channel.muted}
                <BellOff class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span class="sr-only">, muted</span>
              {/if}
              {#if unread > 0}
                <span class={channel.muted ? quietBadge : badge}>
                  <span aria-hidden="true">{badgeText(unread)}</span>
                  <span class="sr-only">, {unread} unread</span>
                </span>
              {/if}
            </button>
          {/if}
        </li>
      {/each}
      {#if creating === "text"}
        {@render createInput("text")}
      {/if}
    </ul>
  </section>

  <section aria-labelledby="{uid}-voice">
    {@render sectionHeader(`${uid}-voice`, "Voice", "voice", false)}
    <ul class="flex flex-col gap-0.5">
      {#each ch.voice as channel (channel.id)}
        <li class="relative">
          {#if renaming?.kind === "voice" && renaming.id === channel.id}
            <Volume2 class="pointer-events-none absolute left-2 top-4 max-sm:top-5.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            {@render renameInput("voice")}
          {:else}
            <button
              type="button"
              data-channel="voice:{channel.id}"
              aria-current={channel.joined ? "true" : undefined}
              onclick={() => ch.onJoinVoice(channel.id)}
              oncontextmenu={channelMenus
                ? (e) => openMenu(e, { kind: "channel", channelKind: "voice", id: channel.id })
                : undefined}
              onkeydown={(e) => onChannelKeydown(e, "voice", channel.id)}
              class="flex h-8 max-sm:h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors cursor-pointer {rowFocus} {channel.joined
                ? 'bg-primary/10 text-foreground hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground'}"
            >
              <Volume2
                class="size-4 shrink-0 {channel.joined ? 'text-primary' : 'text-muted-foreground'}"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate">{channel.name}</span>
              {#if channel.people.length > 0}
                <span class="shrink-0 text-[11px] text-muted-foreground tabular-nums" aria-hidden="true">
                  {channel.people.length}
                </span>
              {/if}
              <span class="sr-only">
                {channel.joined
                  ? ", you are in this call"
                  : channel.people.length > 0
                    ? `, ${channel.people.length} in the call, join`
                    : ", join the call"}
              </span>
            </button>
          {/if}
          {#if channel.people.length > 0}
            <!-- Flush against the channel's row the first person read as
                 cramped. The same 2px as between channels, between the row
                 and its people and between them, keeps one rhythm down the
                 section. -->
            <ul aria-label="In {channel.name}" class="mt-0.5 flex flex-col gap-0.5">
              {#each channel.people as person (person.peerId)}
                <li class="flex h-7 items-center gap-2 pl-8 pr-2 text-xs text-sidebar-foreground/80">
                  <span
                    class="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-[10px] font-bold text-secondary-foreground ring-2 transition-[box-shadow] duration-150 {person.speaking
                      ? 'ring-primary'
                      : 'ring-transparent'}"
                    aria-hidden="true"
                  >
                    {#if person.avatarUrl}
                      <GifImage
                        src={person.avatarUrl}
                        alt=""
                        class="size-full rounded-full object-cover"
                        animate={person.speaking}
                      />
                    {:else}
                      {(person.name || "?").charAt(0).toUpperCase()}
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1 truncate">{person.name}</span>
                  {#if person.muted}
                    <MicOff class="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                    <span class="sr-only">, muted</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </li>
      {/each}
      {#if creating === "voice"}
        {@render createInput("voice")}
      {/if}
    </ul>
  </section>
{/snippet}

{#snippet dmList()}
  {#if phonebook.length === 0}
    <div class="flex h-full select-none flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <User class="size-8 opacity-50" aria-hidden="true" />
      <p class="whitespace-nowrap">No DMs yet</p>
    </div>
  {:else}
    {#each dmGroups as group (group.title ?? "")}
      <section aria-label={group.title ?? "Conversations"}>
        {#if group.title}
          <h3 class="{sectionTitle} pt-3.5 pb-1.5">{group.title}</h3>
        {/if}
        <ul class="flex flex-col gap-0.5">
          {#each group.entries as entry (entry.peerId)}
            {@const selected = activeDmPeerId === entry.peerId}
            {@const unread = dmUnreadCounts.get(entry.peerId) ?? 0}
            {@const color = colorForPeer(entry.peerId)}
            {@const ts = dmPreviews.get(entry.peerId)?.ts}
            <li>
              <button
                type="button"
                aria-current={selected ? "page" : undefined}
                aria-haspopup={entry.blocked ? "menu" : undefined}
                onclick={(e) => selectDmEntry(e, entry)}
                oncontextmenu={(e) => openMenu(e, { kind: "dm", peerId: entry.peerId })}
                class="flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors cursor-pointer {rowFocus} {selected
                  ? 'bg-sidebar-accent'
                  : 'hover:bg-sidebar-accent/50'} {entry.blocked ? 'opacity-60 grayscale' : ''}"
              >
                <span
                  class="flex size-7.5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-xs font-bold text-secondary-foreground"
                  style={color ? `color: ${color}` : ""}
                  aria-hidden="true"
                >
                  {#if entry.avatarUrl}
                    <GifImage
                      src={entry.avatarUrl}
                      alt=""
                      class="size-full rounded-full object-cover"
                      animate="hover"
                    />
                  {:else}
                    {(entry.nickname || "?").charAt(0).toUpperCase()}
                  {/if}
                </span>
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span
                    class="truncate text-sm {unread > 0
                      ? 'font-bold text-foreground'
                      : selected
                        ? 'font-semibold text-foreground'
                        : 'font-medium text-sidebar-foreground/85'}"
                    style={color ? `color: ${color}` : ""}
                  >
                    {entry.nickname}
                  </span>
                  <span class="truncate text-[11px] text-muted-foreground">
                    {entry.blocked
                      ? "Blocked"
                      : dmPreviews.get(entry.peerId)?.text || entry.peerId.slice(0, 16)}
                  </span>
                </span>
                {#if unread > 0}
                  <span class={badge}>
                    <span aria-hidden="true">{badgeText(unread)}</span>
                    <span class="sr-only">, {unread} unread</span>
                  </span>
                {:else if !entry.blocked && ts}
                  <span class="shrink-0 text-[10px] text-muted-foreground tabular-nums">{timeAgo(ts)}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/each}
  {/if}
{/snippet}

<!-- The rooms view with no room open (the app's home): every room by name,
     with its last activity, since the rail only shows letters. -->
{#snippet roomList()}
  {#if rooms.length === 0}
    <div class="flex h-full select-none flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Hash class="size-8 opacity-50" aria-hidden="true" />
      <p class="whitespace-nowrap">No rooms yet</p>
      {#if onOpenCreateJoin}
        <!-- Short enough for one line in the narrowest column (208px), so the
             icon and the label stay one centred unit. The name keeps the
             visible words and says what is created or joined. -->
        <button
          type="button"
          onclick={onOpenCreateJoin}
          aria-label="Create or join a room"
          class="inline-flex h-9 max-sm:h-11 items-center justify-center gap-2 whitespace-nowrap rounded-md border border-sidebar-border px-3 text-sm text-foreground hover:bg-sidebar-accent cursor-pointer {focusRing}"
        >
          <Plus class="size-4 shrink-0" aria-hidden="true" />
          Create or join
        </button>
      {/if}
    </div>
  {:else}
    <ul class="flex flex-col gap-0.5">
      {#each rooms as room (room.roomCode)}
        {@const code = room.roomCode}
        {@const unread = unreadOf(code)}
        {@const live = liveRoomCodes.has(code)}
        <li>
          <button
            type="button"
            onclick={() => onSelectRoom(code)}
            oncontextmenu={(e) => openMenu(e, { kind: "room", code })}
            class="flex h-12 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors cursor-pointer hover:bg-sidebar-accent/50 {rowFocus}"
          >
            <span
              class="flex size-7.5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sidebar-accent text-[11px] font-bold text-muted-foreground"
              aria-hidden="true"
            >
              {#if pictures.get(code)}
                <GifImage src={pictures.get(code)!} alt="" class="size-full object-cover" animate="hover" />
              {:else}
                {roomInitials(room.name, code)}
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                class="truncate text-sm {unread > 0
                  ? 'font-bold text-foreground'
                  : 'font-medium text-sidebar-foreground/85'}"
              >
                {roomName(room)}
              </span>
              <span class="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                {#if room.pinnedAt != null}
                  <Pin class="size-3 shrink-0" aria-hidden="true" />
                  <span class="sr-only">Pinned,</span>
                {/if}
                <span class="truncate">{timeAgo(roomActivity.get(code) ?? room.createdAt)}</span>
              </span>
            </span>
            {#if live}
              <Volume2 class="size-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span class="sr-only">, call going on</span>
            {/if}
            {#if unread > 0}
              <span class={badge}>
                <span aria-hidden="true">{badgeText(unread)}</span>
                <span class="sr-only">, {unread} unread</span>
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}

{#if menu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="menu"
    tabindex="-1"
    aria-label={menuLabel}
    class="fixed z-50 min-w-44 select-none rounded-md border border-border bg-popover py-1 shadow-xl"
    style="top: {menu.y}px; left: {menu.x}px"
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
    onkeydown={onMenuKeydown}
    {@attach focusFirstItem}
  >
    {#each menuItems as item (item.id)}
      {@const Icon = item.icon}
      <button
        type="button"
        role="menuitem"
        tabindex="-1"
        onclick={() => runItem(item)}
        class="flex w-full items-center gap-2 px-3 py-1.5 max-sm:py-3 text-sm font-mono hover:bg-muted focus-visible:bg-muted focus-visible:outline-none cursor-pointer {item.destructive
          ? 'text-destructive'
          : 'text-foreground'} {confirming === item.id ? 'bg-destructive/10' : ''}"
      >
        <Icon class="size-4" aria-hidden="true" />
        {confirming === item.id ? "Click again to confirm" : item.label}
      </button>
    {/each}
  </div>
{/if}
