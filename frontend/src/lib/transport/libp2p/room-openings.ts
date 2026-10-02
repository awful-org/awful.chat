/**
 * Turns at opening room channels: so many at once, the rest in line.
 *
 * Every (room, peer) pair a rendezvous reply names opens a channel, all at
 * once, and the transport used to refuse everything past 64 in flight with
 * no retry - at startup that could be most of them, and those pairs stayed
 * deaf to each other until the relay happened to list them again. A turn is
 * waited for instead. The line has a length too, so a relay listing peers by
 * the thousand gets refusals rather than memory.
 */
export class RoomOpenings {
  #active = 0;
  #queue: Array<(release: (() => void) | null) => void> = [];
  #generation = 0;

  constructor(
    private readonly concurrent: number,
    private readonly queued: number,
  ) {}

  /**
   * Resolves once it is this caller's turn, with the function that ends it -
   * or with null when the line is full, or is cleared while waiting.
   */
  enter(): Promise<(() => void) | null> {
    const now = this.tryEnter();
    if (now) return Promise.resolve(now);
    if (this.#queue.length >= this.queued) return Promise.resolve(null);
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  /** A turn right now, or null without queueing. */
  tryEnter(): (() => void) | null {
    return this.#active < this.concurrent ? this.#take() : null;
  }

  /** Everyone waiting gets null, and turns already handed out stop counting. */
  clear(): void {
    this.#generation++;
    this.#active = 0;
    for (const waiter of this.#queue.splice(0)) waiter(null);
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#queue.length;
  }

  /**
   * No turn free and no place left in line: enter() would refuse. Asked
   * first, so that a null from enter() can only mean the line was cleared -
   * which is a session ending, not a refusal worth reporting.
   */
  get full(): boolean {
    return this.#active >= this.concurrent && this.#queue.length >= this.queued;
  }

  #take(): () => void {
    this.#active++;
    const generation = this.#generation;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (generation !== this.#generation) return;
      this.#active--;
      this.#queue.shift()?.(this.#take());
    };
  }
}
