import { expect, it } from "vitest";
import { RoomOpenings } from "./room-openings";

it("lets so many open at once and queues the rest in order, refusing none", async () => {
  const gate = new RoomOpenings(2, 10);
  const order: number[] = [];
  const turns = [1, 2, 3, 4, 5].map((n) => gate.enter().then((end) => { order.push(n); return end; }));
  await Promise.resolve();
  const [first, second] = await Promise.all(turns.slice(0, 2));
  expect(order).toEqual([1, 2]);
  expect(gate.active).toBe(2);
  expect(gate.waiting).toBe(3);
  first!();
  first!(); // ending a turn twice frees one place, not two
  await turns[2];
  expect(order).toEqual([1, 2, 3]);
  expect(gate.active).toBe(2);
  second!();
  (await turns[2])!();
  for (const end of await Promise.all(turns.slice(3))) end!();
  expect(order).toEqual([1, 2, 3, 4, 5]);
  expect(gate.active).toBe(0);
});

it("refuses once the line is full, so a flood costs a refusal and not memory", async () => {
  const gate = new RoomOpenings(1, 2);
  const held = gate.tryEnter();
  expect(held).not.toBeNull();
  expect(gate.tryEnter()).toBeNull(); // no free turn, and trying does not queue
  expect(gate.waiting).toBe(0);
  const waiting = [gate.enter(), gate.enter()];
  expect(await gate.enter()).toBeNull();
  held!();
  (await waiting[0])!();
  (await waiting[1])!();
  expect(gate.active).toBe(0);
});

it("clears for a new session: waiters get no turn, and old turns stop counting", async () => {
  const gate = new RoomOpenings(1, 5);
  const old = await gate.enter();
  const waiter = gate.enter();
  gate.clear();
  expect(await waiter).toBeNull();
  const fresh = await gate.enter();
  expect(fresh).not.toBeNull();
  old!(); // a turn from before the clear frees nothing now
  expect(gate.active).toBe(1);
  const next = gate.enter();
  fresh!();
  expect(await next).not.toBeNull();
});

it("says it is full only with no turn free and no place in line, so a clear's null is told from a refusal", async () => {
  const gate = new RoomOpenings(1, 1);
  expect(gate.full).toBe(false);
  const held = gate.tryEnter();
  expect(gate.full).toBe(false); // a place in line is left
  const waiting = gate.enter();
  expect(gate.full).toBe(true);
  expect(await gate.enter()).toBeNull();
  held!();
  expect(gate.full).toBe(false);
  (await waiting)!();
  expect(gate.active).toBe(0);
});
