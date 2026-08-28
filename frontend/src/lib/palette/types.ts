import type { Component } from "svelte";
import type { IconProps } from "@lucide/svelte";
import type { MatchRange } from "./scorer";

/** A `@lucide/svelte` icon component, rendered as `<cmd.icon class="size-4" />`. */
export type PaletteIcon = Component<IconProps>;

/**
 * Relevance tiers.
 *
 * These are baselines added to a command's character score, spaced far enough
 * apart that character points can never lift a weaker tier past a stronger one.
 * That is the whole trick behind "it always puts the thing I meant first":
 * a prefix hit on a title must never lose to a brilliant fuzzy hit inside a
 * subtitle, no matter how the characters land. Blending weights instead of
 * tiering is what makes a palette feel random.
 *
 * Borrowed from VS Code's fuzzy scorer, which uses the same 1<<N spacing.
 */
export const TIER_EXACT = 1 << 20;
export const TIER_PREFIX = 1 << 18;
export const TIER_TITLE = 1 << 16;
export const TIER_KEYWORD = 1 << 14;
export const TIER_SUBTITLE = 1 << 12;

/**
 * What happens when the user accepts a command.
 *
 * `act` runs it. `page` pushes a nested page, which is how a command that needs
 * an argument asks for one ("Join room" then which room).
 */
export type CmdAction =
  | {
      kind: "act";
      perform: () => void | Promise<void>;
      /**
       * Keep the palette open after running. Use for commands a user repeats,
       * such as adjusting a volume, so they do not reopen it each time.
       */
      keepOpen?: boolean;
    }
  | { kind: "page"; open: () => Page };

/** One row in the palette. */
export interface Cmd {
  /**
   * Stable and unique. This keys the `{#each}` block, the MRU record, and the
   * `aria-activedescendant` target, so it must not be derived from the title:
   * two rooms can share a name.
   */
  id: string;
  /** Primary label. Matched at the highest tiers. */
  title: string;
  /** Secondary label, shown dimmed. Matched at the lowest tier. */
  subtitle?: string;
  /** Aliases. Matched below the title so a keyword hit cannot outrank a title hit. */
  keywords?: string[];
  /** Heading this row appears under. Groups sort by their best member. */
  group: string;
  icon?: PaletteIcon;
  /** Current value, shown right-aligned. For example "On" for a toggle. */
  badge?: string;
  /** Keys that trigger this command outside the palette, rendered as `<kbd>`. */
  shortcut?: string[];
  /**
   * Destructive. Styled as such, and MUST be paired with a `confirm` page
   * rather than acting straight from `Enter`.
   */
  danger?: boolean;
  action: CmdAction;
}

/**
 * A palette page. The stack of these is the palette's navigation model:
 * `[]` is the root, and each push narrows to one argument.
 */
export type Page =
  | {
      kind: "list";
      id: string;
      /** Breadcrumb text. */
      title: string;
      placeholder?: string;
      /**
       * Rows for this page. May be async, for example enumerating audio
       * devices. The caller cancels a stale load rather than debouncing.
       */
      items: () => Cmd[] | Promise<Cmd[]>;
      /** Shown when `items` yields nothing. */
      emptyText?: string;
    }
  | {
      kind: "prompt";
      id: string;
      title: string;
      placeholder?: string;
      /** Prefilled text. Selected on open so typing replaces it. */
      initial?: string;
      /** Returns an error message, or `null` when the value is acceptable. */
      validate?: (value: string) => string | null;
      submit: (value: string) => void | Promise<void>;
      submitLabel?: string;
    }
  | {
      kind: "confirm";
      id: string;
      title: string;
      message: string;
      confirmLabel: string;
      confirm: () => void | Promise<void>;
    };

/** A command that survived filtering, with everything the row needs to render. */
export interface RankedCmd {
  cmd: Cmd;
  /** Tier baseline plus character score. Only meaningful within one query. */
  score: number;
  /** The weakest tier any query term matched at. Drives the comparator. */
  tier: number;
  titleRanges: MatchRange[];
  subtitleRanges: MatchRange[];
  /** Total span of the title match. Tie-break: tighter wins. */
  titleSpan: number;
}

/** Rows under one heading. Groups sort by their best member's score. */
export interface RankedGroup {
  name: string;
  items: RankedCmd[];
}

/**
 * Query scope prefixes. The sigil stays in the input text and the ranker strips
 * it, so deleting the character returns to the root scope with no extra state.
 */
export const SIGILS = {
  "#": "Rooms",
  "@": "People",
  ">": "Settings",
  "?": "Help",
} as const;

export type Sigil = keyof typeof SIGILS;

/** One whitespace-separated piece of the query. All pieces must match. */
export interface QueryTerm {
  /** Lowercased. The matcher requires this. */
  text: string;
  /** Came from a quoted segment, so it must match contiguously. */
  exact: boolean;
}

export interface ParsedQuery {
  /** Exactly what the user typed. */
  raw: string;
  /** The scope prefix, or `null` at the root. */
  sigil: Sigil | null;
  /** The query with the sigil removed, trimmed. */
  body: string;
  /** Terms to match. Empty means "show everything". */
  terms: QueryTerm[];
}
