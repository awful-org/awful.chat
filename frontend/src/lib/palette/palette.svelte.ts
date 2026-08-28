import { loadMru, saveMru, type Mru } from "./mru";
import { parseQuery } from "./query";
import { RECENT_GROUP, flatten, rank } from "./rank";
import { SIGILS, type Cmd, type Page, type RankedCmd, type Sigil } from "./types";

/**
 * Which command groups each scope prefix admits.
 *
 * `?` maps to no group because it renders synthetic help rows instead of
 * filtering the catalog.
 */
const SIGIL_GROUPS: Record<Sigil, readonly string[] | null> = {
  "#": ["Rooms"],
  "@": ["People"],
  ">": ["Settings", "Plugins"],
  "?": null,
};

/** Rows to jump per PageUp/PageDown when the viewport has not been measured. */
const DEFAULT_PAGE_SIZE = 8;

/**
 * The palette's state machine.
 *
 * Every transition is an explicit method. There is deliberately no `$effect`
 * here: an effect that resets the selection would run a tick after the query
 * changed, which is long enough for `Enter` to fire against the row the user
 * was already looking away from. Writing the reset into `setQuery` makes the
 * ordering impossible to get wrong.
 *
 * All ranking decisions live in plain, tested modules (`scorer`, `rank`,
 * `query`, `mru`). This class only sequences them, matching the codebase's own
 * note that runes are not testable here.
 */
export class PaletteState {
  readonly #catalog: () => Cmd[];
  /**
   * Asks the owner to close the palette.
   *
   * Visibility is deliberately NOT held here. The dialog above this class owns
   * it, and mirroring a boolean in both places means two effects writing each
   * other's dependency. One direction, one owner.
   */
  readonly #requestClose: () => void;

  query = $state("");
  /** Empty means the root page. */
  stack = $state<Page[]>([]);
  /**
   * The active row, tracked by id rather than index. An index goes stale the
   * moment ranking reorders the list, which is how palettes end up running the
   * wrong command.
   */
  selectedId = $state<string | null>(null);
  /** Rows supplied by the current list page. */
  pageRows = $state<Cmd[]>([]);
  loading = $state(false);
  /** Load failure, or a prompt's validation message. */
  error = $state<string | null>(null);
  /** An action is running. Keeps the row from being fired twice. */
  busy = $state(false);
  /** Text typed into a prompt page, kept apart from the search query. */
  promptValue = $state("");

  #mru: Mru = loadMru();
  /**
   * Bumped on every recency write. `#mru` is a plain class, so results would not
   * recompute without an explicit reactive read.
   */
  #mruVersion = $state(0);
  /** Cancels a stale async page load. */
  #loadToken = 0;

  constructor(catalog: () => Cmd[], requestClose: () => void) {
    this.#catalog = catalog;
    this.#requestClose = requestClose;
  }

  readonly page = $derived<Page | null>(this.stack.at(-1) ?? null);

  readonly crumbs = $derived(this.stack.map((page) => page.title));

  readonly onPrompt = $derived(this.page?.kind === "prompt");

  /** A prompt page captures free text, so it must not be parsed as a search. */
  readonly parsed = $derived(parseQuery(this.onPrompt ? "" : this.query));

  readonly scope = $derived<Sigil | null>(
    this.stack.length === 0 ? this.parsed.sigil : null,
  );

  /** The commands the current page and scope expose, before ranking. */
  readonly source = $derived.by<Cmd[]>(() => {
    const page = this.page;
    if (page?.kind === "list") return this.pageRows;
    if (page?.kind === "confirm") return confirmRows(page, () => this.pop());
    if (page?.kind === "prompt") return [];

    if (this.scope === "?") return helpRows((sigil) => this.setQuery(sigil));
    const catalog = this.#catalog();
    if (this.scope === null) return catalog;

    const groups = SIGIL_GROUPS[this.scope];
    if (groups === null) return catalog;
    return catalog.filter((cmd) => groups.includes(cmd.group));
  });

  readonly groups = $derived.by(() => {
    // Read the version so a recency write recomputes the ordering.
    void this.#mruVersion;
    return rank(this.source, this.parsed, this.#mru);
  });

  readonly rows = $derived(flatten(this.groups));

  /**
   * The active row. Falls back to the first row so there is always a target for
   * `Enter`, and so an empty `selectedId` never leaves the list inert.
   */
  readonly selected = $derived<RankedCmd | null>(
    this.rows.find((row) => row.cmd.id === this.selectedId) ?? this.rows[0] ?? null,
  );

  readonly placeholder = $derived.by(() => {
    const page = this.page;
    if (page?.kind === "prompt") return page.placeholder ?? "";
    if (page?.kind === "list") return page.placeholder ?? `Search ${page.title}…`;
    if (page?.kind === "confirm") return "";
    if (this.scope !== null) return `Search ${SIGILS[this.scope].toLowerCase()}…`;
    return "Search rooms, settings and actions… try # @ > or ?";
  });

  readonly recentGroupName = RECENT_GROUP;

  // ---------------------------------------------------------------- lifecycle

  /**
   * Return to the root page with an empty query.
   *
   * Called when the palette opens, not when it closes. Resetting on close would
   * swap the visible page back to the root during the exit animation, so the
   * user watches the palette change its mind on the way out.
   */
  reset(): void {
    this.stack = [];
    this.query = "";
    this.promptValue = "";
    this.selectedId = null;
    this.pageRows = [];
    this.loading = false;
    this.error = null;
    // Abandon any in-flight page load, so it cannot land into the new session.
    this.#loadToken++;
  }

  /** Dismiss the palette. The owner drops the dialog. */
  close(): void {
    this.#requestClose();
  }

  // ------------------------------------------------------------------ typing

  setQuery(value: string): void {
    if (this.onPrompt) {
      this.promptValue = value;
      // Clear a stale validation message as soon as the user edits.
      this.error = null;
      return;
    }
    this.query = value;
    // Never leave the selection on a row that ranking is about to move. The
    // user is not tracking a moving row, so the first result is the only
    // defensible target.
    this.selectedId = null;
  }

  /** The text the input element should display. */
  readonly inputValue = $derived(this.onPrompt ? this.promptValue : this.query);

  // ------------------------------------------------------------------- pages

  push(page: Page): void {
    this.stack = [...this.stack, page];
    this.query = "";
    this.selectedId = null;
    this.error = null;
    this.promptValue = page.kind === "prompt" ? (page.initial ?? "") : "";
    if (page.kind === "list") void this.#loadPage(page);
    else this.pageRows = [];
  }

  pop(): void {
    if (this.stack.length === 0) return;
    this.stack = this.stack.slice(0, -1);
    this.query = "";
    this.selectedId = null;
    this.error = null;
    this.#loadToken++;
    const page = this.page;
    this.promptValue = page?.kind === "prompt" ? (page.initial ?? "") : "";
    if (page?.kind === "list") void this.#loadPage(page);
    else this.pageRows = [];
  }

  /**
   * Load a list page's rows.
   *
   * A newer load invalidates an older one by token rather than by debouncing:
   * cancelling is correct, whereas delaying only makes a slow enumeration feel
   * slower.
   */
  async #loadPage(page: Extract<Page, { kind: "list" }>): Promise<void> {
    const token = ++this.#loadToken;
    this.loading = true;
    this.error = null;
    try {
      const items = await page.items();
      if (token !== this.#loadToken) return;
      this.pageRows = items;
    } catch (err) {
      if (token !== this.#loadToken) return;
      this.pageRows = [];
      this.error = err instanceof Error ? err.message : "Could not load that list.";
    } finally {
      if (token === this.#loadToken) this.loading = false;
    }
  }

  // -------------------------------------------------------------- navigation

  /** Move the selection by `delta`, clamped. Short lists make wrapping disorienting. */
  move(delta: number): void {
    const rows = this.rows;
    if (rows.length === 0) return;
    const current = rows.findIndex((row) => row.cmd.id === this.selected?.cmd.id);
    const next = Math.min(Math.max(current + delta, 0), rows.length - 1);
    this.selectedId = rows[next].cmd.id;
  }

  moveToStart(): void {
    this.selectedId = this.rows[0]?.cmd.id ?? null;
  }

  moveToEnd(): void {
    this.selectedId = this.rows.at(-1)?.cmd.id ?? null;
  }

  movePage(direction: 1 | -1, pageSize = DEFAULT_PAGE_SIZE): void {
    this.move(direction * Math.max(1, pageSize));
  }

  /** Select via the pointer. The caller MUST have confirmed real pointer movement. */
  hover(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
  }

  // ---------------------------------------------------------------- accepting

  /**
   * Run the active row, or submit the prompt.
   *
   * Recency is recorded before the action runs, so a command that closes the
   * palette or navigates away still counts as used.
   */
  async accept(): Promise<void> {
    if (this.busy) return;

    const page = this.page;
    if (page?.kind === "prompt") {
      await this.#submitPrompt(page);
      return;
    }

    const row = this.selected;
    if (!row) return;
    await this.run(row.cmd);
  }

  async run(cmd: Cmd): Promise<void> {
    // A destructive command never earns recency. Recording it would float it
    // into the recents group, which is the first thing the palette shows and
    // where Enter already rests. "Erase all local data" MUST NOT be one
    // keystroke from an empty query, and merely opening its confirm page and
    // backing out MUST NOT promote it either.
    if (!cmd.danger) this.#touch(cmd.id);

    if (cmd.action.kind === "page") {
      this.push(cmd.action.open());
      return;
    }

    const keepOpen = cmd.action.keepOpen === true;
    if (!keepOpen) this.close();

    this.busy = true;
    try {
      await cmd.action.perform();
    } catch (err) {
      console.warn(`[palette] "${cmd.title}" failed`, err);
      if (keepOpen) {
        this.error = err instanceof Error ? err.message : "That did not work.";
      }
    } finally {
      this.busy = false;
    }
  }

  async #submitPrompt(page: Extract<Page, { kind: "prompt" }>): Promise<void> {
    const value = this.promptValue.trim();
    const message = page.validate ? page.validate(value) : null;
    if (message !== null) {
      this.error = message;
      return;
    }

    this.close();
    this.busy = true;
    try {
      await page.submit(value);
    } catch (err) {
      console.warn(`[palette] "${page.title}" failed`, err);
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------ dismiss

  /**
   * One decision for `Escape`, made here so the dialog cannot also act on it.
   * Two independent Escape listeners is why palettes close everything at once.
   * The dialog is configured with `escapeKeydownBehavior="ignore"` so that this
   * really is the only handler.
   *
   * Clears the query first, then steps back a page, and only then closes. Each
   * press undoes exactly one thing.
   */
  escape(): void {
    if (this.inputValue.length > 0) {
      this.setQuery("");
      return;
    }
    if (this.stack.length > 0) {
      this.pop();
      return;
    }
    this.close();
  }

  /**
   * `Backspace` on an empty input steps back a page.
   *
   * @param liveValue The input element's current value. Read it from the event
   *   target, never from state: on a key repeat the state write lags a tick,
   *   which pops a page the user was still typing in.
   * @returns `true` when the palette handled it.
   */
  backspace(liveValue: string): boolean {
    if (liveValue.length > 0) return false;
    if (this.stack.length === 0) return false;
    this.pop();
    return true;
  }

  // --------------------------------------------------------------------- mru

  #touch(id: string): void {
    this.#mru.touch(id);
    this.#mruVersion++;
    saveMru(this.#mru);
  }

  /** Drop a row from the recency list without running it. */
  forget(id: string): void {
    if (!this.#mru.forget(id)) return;
    this.#mruVersion++;
    saveMru(this.#mru);
  }
}

/**
 * Turn a confirm page into two rows so it reuses the same keyboard, selection,
 * and ARIA machinery as every other page. Cancel comes first, and is therefore
 * selected by default: a destructive action must cost a deliberate keystroke.
 */
function confirmRows(
  page: Extract<Page, { kind: "confirm" }>,
  cancel: () => void,
): Cmd[] {
  // The warning text is NOT the group name. Group names render as short
  // uppercase headings, and a full sentence set in caps is the last thing a
  // destructive prompt needs. The palette renders `page.message` itself.
  return [
    {
      id: `${page.id}:cancel`,
      title: "Cancel",
      group: "Confirm",
      action: { kind: "act", perform: cancel, keepOpen: true },
    },
    {
      id: `${page.id}:confirm`,
      title: page.confirmLabel,
      group: "Confirm",
      danger: true,
      action: { kind: "act", perform: page.confirm },
    },
  ];
}

/** Rows for the `?` scope, so the prefixes are discoverable rather than folklore. */
function helpRows(apply: (sigil: Sigil) => void): Cmd[] {
  return (Object.keys(SIGILS) as Sigil[]).map((sigil) => ({
    id: `help:${sigil}`,
    title: `${sigil}  ${SIGILS[sigil]}`,
    subtitle: `Search only ${SIGILS[sigil].toLowerCase()}`,
    group: "Prefixes",
    // Accepting a help row types the prefix, so the user learns it by using it.
    action: { kind: "act", perform: () => apply(sigil), keepOpen: true },
  }));
}
