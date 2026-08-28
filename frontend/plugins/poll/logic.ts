/**
 * Pure poll logic, separated from the Svelte component so tests exercise
 * the REAL reducer.
 */
import type { UpdateCtx } from "$lib/plugins/api";

export interface PollState {
  question: string;
  options: string[];
  votes: Map<string, { did: string; name: string; vote: number }>;
}

/**
 * Split "/poll Question? A, B" on the FIRST "?" only - options are allowed
 * to contain question marks. Returns null when the input has no question or
 * fewer than two options.
 */
export function parsePollArgs(
  args: string
): { question: string; options: string[] } | null {
  const qIndex = args.indexOf("?");
  if (qIndex < 0) return null;
  const question = args.slice(0, qIndex).trim();
  const options = args
    .slice(qIndex + 1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (options.length < 2) return null;
  return { question, options };
}

export const initialState = (cardData: unknown) => {
    const data = (cardData ?? {}) as { question?: unknown; options?: unknown };
    return {
      question:
        typeof data.question === "string" ? data.question.slice(0, 200) : "",
      options: Array.isArray(data.options)
        ? data.options.filter((o): o is string => typeof o === "string")
        : [],
      votes: new Map<string, { did: string; name: string; vote: number }>(),
    };
  };

export const reduce = function (state: unknown, update: { data: unknown }, ctx: UpdateCtx) {
    const pollState = state as PollState;
    // Peer-supplied: data can be anything, null included.
    const data = update.data;
    if (typeof data !== "object" || data === null) return state;

    // Only handle vote actions
    if ((data as Record<string, unknown>).action !== "vote") return state;

    const { vote } = data as Record<string, unknown>;

    // Peer-supplied: NaN slips past < and >= checks, so integers only.
    if (
      typeof vote !== "number" ||
      !Number.isInteger(vote) ||
      vote < 0 ||
      vote >= pollState.options.length
    ) {
      return state;
    }

    // Keep last vote per senderDid: replace if they already voted
    const newVotes = new Map(pollState.votes);
    newVotes.set(ctx.senderDid, {
      did: ctx.senderDid,
      name: ctx.senderName,
      vote,
    });

    return {
      ...pollState,
      votes: newVotes,
    };
  };
