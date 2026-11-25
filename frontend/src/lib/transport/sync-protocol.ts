/**
 * sync-protocol.ts - the rules of the device-sync wire protocol that need no
 * transport: the version both ends must agree on, the code a person compares
 * before a sync is allowed, the window that paces the export on the
 * receiver's acknowledgments, and the manifest the receiver checks before it
 * writes anything.
 *
 * Apart from sync.svelte.ts, which builds a libp2p node, so each rule can be
 * tested on its own.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "../utils";

/**
 * Bumped whenever a frame changes meaning. Version 2: the source asks before
 * it sends anything, names its account in a merge, paces itself on acks and
 * closes with a manifest. A version 1 build never looks at this field, so
 * each side checks the other's and refuses with SYNC_VERSION_MISMATCH rather
 * than half-understanding the other.
 *
 * Version 3: the data can hold channels (messages tagged with one, rooms'
 * channel lists). A version 2 build would show every channel's messages
 * mixed in the room's one chat, so the two refuse each other.
 */
export const SYNC_PROTOCOL_VERSION = 3;

export const SYNC_VERSION_MISMATCH =
  "The two devices run different versions of the app. Update both, then generate a new code.";

/**
 * The six digits both devices show before a sync is allowed.
 *
 * Built from what each end knows for itself: the two peer ids the Noise
 * handshake authenticated, the pairing token from the QR, and a nonce the
 * source picks for this one request. Someone who saw the QR can join the
 * sync room and ask first, but their peer id is not the new device's, so the
 * source shows them a code the new device does not - and a new device only
 * shows a code at all once the source has told it that its request is the
 * one waiting. The nonce makes every request's code fresh, so no peer id
 * can be ground in advance to collide with one.
 */
export function syncComparisonCode(
  sourcePeerId: string,
  targetPeerId: string,
  token: string,
  nonce: string
): string {
  const digest = sha256(
    utf8(`awful.chat device-sync confirm v1\n${sourcePeerId}\n${targetPeerId}\n${token}\n${nonce}`)
  );
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, "0");
}

/** "123456" as people read it out: "123 456". */
export function formatComparisonCode(code: string): string {
  return code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/** A fresh request nonce, hex. */
export function newSyncNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/**
 * How far the export may run ahead of the receiver's acknowledgments.
 *
 * The receiving channel closes the whole stream once it holds more than 32
 * frames or 4MB that it has not processed yet, and the source used to pace
 * itself with a 10ms sleep that knew nothing about either. An ack is sent
 * only after a frame was taken in, so bounding what is unacknowledged bounds
 * what the receiver can be holding.
 */
export class SendWindow {
  private readonly inFlight = new Map<number, { bytes: number; frame: Uint8Array | null }>();
  private bytes = 0;
  private failure: Error | null = null;
  private waiters: (() => void)[] = [];

  constructor(
    readonly maxFrames: number,
    readonly maxBytes: number
  ) {}

  get pending(): number {
    return this.inFlight.size;
  }

  /**
   * Resolves once a frame of `bytes` may go. Always at once when nothing is
   * in flight, so a frame bigger than the byte budget still moves, alone.
   * Throws the failure once fail() was called.
   */
  async reserve(bytes: number): Promise<void> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (
        this.inFlight.size === 0 ||
        (this.inFlight.size < this.maxFrames && this.bytes + bytes <= this.maxBytes)
      ) {
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  sent(seq: number, bytes: number, frame: Uint8Array | null = null): void {
    this.inFlight.set(seq, { bytes, frame });
    this.bytes += bytes;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  /** The frames nothing has been heard about, oldest first, to send again. */
  unacked(): Uint8Array[] {
    return [...this.inFlight.values()].flatMap(({ frame }) => (frame ? [frame] : []));
  }

  /** True when `seq` was a frame still waiting for its ack. */
  ack(seq: unknown): boolean {
    if (typeof seq !== "number") return false;
    const entry = this.inFlight.get(seq);
    if (entry === undefined) return false;
    this.inFlight.delete(seq);
    this.bytes -= entry.bytes;
    this.wake();
    return true;
  }

  /** Resolves once every frame sent so far was acknowledged. */
  async drained(): Promise<void> {
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.inFlight.size === 0) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Stop: whoever waits on the window, and whoever asks next, gets `error`. */
  fail(error: Error): void {
    if (!this.failure) this.failure = error;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** The slowest link a frame is given time to cross, in bytes a second. */
const SLOWEST_LINK = 128 * 1024;
/** What a byte of a frame becomes on the wire: it is base64 in an envelope, twice. */
const WIRE_OVERHEAD = 1.8;

/**
 * How long nothing may be heard of `bytes` before they are taken for lost. A
 * write that resolved is in a buffer, not across, so this is the whole way.
 */
export function silenceFor(bytes: number): number {
  return 8_000 + Math.ceil((bytes * WIRE_OVERHEAD * 1000) / SLOWEST_LINK);
}

/**
 * What to do when something sent goes unanswered.
 *
 * Every answer restarts it, so it measures silence and nothing else: how long
 * a sync takes does not matter to it. It is the one clock there has to be. A
 * path that stops carrying frames says nothing - a write to it succeeds, and
 * it can stay open for minutes - so the missing answer is the only sign.
 *
 * Each try in a row waits twice as long as the one before, in case it is the
 * other device that is slow. What gives up is the caller's own watchdog.
 */
export class SilenceTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tries = 0;
  private stopped = true;

  /** `act` answers false when it was not the time, which is no try. */
  constructor(
    private readonly act: () => Promise<boolean | void> | boolean | void,
    private readonly wait: () => number = () => 8_000
  ) {}

  /** Something was answered, or just sent with nothing outstanding before it. */
  restart(): void {
    this.stopped = false;
    this.tries = 0;
    this.arm();
  }

  /** Something more was sent: the clock already running stands. */
  ensure(): void {
    if (this.stopped) this.restart();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), this.wait() * 2 ** Math.min(this.tries, 2));
  }

  private async fire(): Promise<void> {
    this.timer = null;
    try {
      if ((await this.act()) !== false) this.tries++;
    } finally {
      // Unless it was answered, or given up on, meanwhile.
      if (!this.stopped && !this.timer) this.arm();
    }
  }
}

/** What the source says it sent of one section. */
export interface SectionManifestEntry {
  items: number;
  batches: number;
}

export type SyncManifest = Record<string, SectionManifestEntry>;

/** What the receiver actually took in of one section. */
export interface ReceivedSection {
  items: number;
  batches: Set<number>;
  /** totalBatches as the frames announced it. */
  announced?: number;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Everything that does not add up between the manifest and what arrived,
 * as short labels for the error; empty when the transfer is whole.
 *
 * The batch counts on the frames alone could not catch a section that went
 * missing entirely - a one-batch section whose frame was lost announced
 * nothing, so nothing was found short. The manifest names every section,
 * and `required` is every section a source of this version always lists.
 */
export function manifestProblems(
  manifest: unknown,
  received: ReadonlyMap<string, ReceivedSection>,
  required: readonly string[]
): string[] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return ["no manifest"];
  }
  const listed = manifest as Record<string, unknown>;
  const problems: string[] = [];
  for (const name of required) {
    if (!Object.hasOwn(listed, name)) problems.push(`${name} (not listed)`);
  }
  for (const [name, raw] of Object.entries(listed)) {
    const entry = raw as Partial<SectionManifestEntry> | null;
    if (!entry || !count(entry.items) || !count(entry.batches)) {
      problems.push(`${name} (bad manifest entry)`);
      continue;
    }
    const got = received.get(name);
    const items = got?.items ?? 0;
    const batches = got?.batches.size ?? 0;
    if (
      items !== entry.items ||
      batches !== entry.batches ||
      (got?.announced !== undefined && got.announced !== entry.batches)
    ) {
      problems.push(`${name} (${items}/${entry.items})`);
    }
  }
  for (const name of received.keys()) {
    if (!Object.hasOwn(listed, name)) problems.push(`${name} (not listed)`);
  }
  return problems;
}
