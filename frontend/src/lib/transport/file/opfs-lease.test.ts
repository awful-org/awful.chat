import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fakeLocks, fakeOPFS } from "./opfs-test-helper";
import { OPFSLease, PIECES_DIR, STAGING_DIR } from "./opfs-lease";
import { OPFSChunkStore } from "./opfs-store";

let disk: ReturnType<typeof fakeOPFS>;
let locks: ReturnType<typeof fakeLocks>;
beforeEach(() => {
  disk = fakeOPFS();
  locks = fakeLocks();
  vi.stubGlobal("navigator", { storage: disk.storage, locks });
});
afterEach(() => vi.unstubAllGlobals());

const paths = () => [...disk.entries.keys()].sort();
async function write(path: string, text: string) {
  disk.entries.set(path, new Blob([text]));
}
async function put(store: OPFSChunkStore, index: number, text: string) {
  await new Promise<void>((resolve, reject) =>
    store.put(index, new TextEncoder().encode(text), (e) => (e ? reject(e) : resolve())));
}

it("keeps its files under a directory of its own, held by a lock, and takes both away on end", async () => {
  const lease = new OPFSLease();
  const store = new OPFSChunkStore(16, { lease });
  await put(store, 0, "ciphertext piece");
  const staging = await lease.directory(STAGING_DIR);
  await (await (await staging.getFileHandle("send", { create: true })).createWritable()).close();
  expect(paths().every((p) => p.split("/")[1] === lease.id)).toBe(true);
  expect(paths().some((p) => p.startsWith(`${PIECES_DIR}/`))).toBe(true);
  expect(locks.held.has(`awful:opfs:${lease.id}`)).toBe(true);

  await lease.end();
  expect(paths()).toEqual([]);
  expect(locks.held.has(`awful:opfs:${lease.id}`)).toBe(false);
  await expect(lease.directory(PIECES_DIR)).rejects.toThrow();
});

it("sweeps what closed sessions left and never a running session's files", async () => {
  // A tab that crashed: its lease directory is there, its lock went with it.
  await write(`${PIECES_DIR}/0123456789abcdef/0`, "orphaned piece");
  await write(`${STAGING_DIR}/0123456789abcdef/x.bin`, "orphaned staging");
  // A tab still running, and this one.
  const running = new OPFSLease();
  await put(new OPFSChunkStore(16, { lease: running }), 0, "live piece");
  const self = new OPFSLease();
  await put(new OPFSChunkStore(16, { lease: self }), 0, "our piece");

  await self.sweep();
  const owners = paths().map((p) => p.split("/")[1]);
  expect(owners.sort()).toEqual([running.id, self.id].sort());
});

it("removes what older builds left - decrypted attachments included - once no other page can be using it", async () => {
  await write(`${STAGING_DIR}/3a1392f4-7763-43e2-a8a9-7cd8fb556978`, "PLAINTEXT scanned passport");
  await write(`${PIECES_DIR}/9b2c63f1-1f0b-4a51-9d6a-4f7c0f0a1b2c/0`, "older piece");
  const self = new OPFSLease();

  // An older build's main page may still be running: it holds the node lock.
  locks.held.set("awful:node", "another-page");
  await self.sweep();
  expect(paths()).toHaveLength(2);
  // ...or a quick call, which holds its storage lock.
  locks.held.delete("awful:node");
  locks.held.set("awful-quick-0011223344556677", "another-page");
  await self.sweep();
  expect(paths()).toHaveLength(2);

  // A Lock Manager that does not say whose lock is whose: every one counts
  // as another page's.
  locks.held.delete("awful-quick-0011223344556677");
  locks.held.set("awful:node", "this-page");
  const query = locks.query;
  locks.query = async () => {
    const { held, pending } = await query();
    return { held: held.map(({ name, mode }) => ({ name, mode, clientId: undefined as never })), pending };
  };
  await self.sweep();
  expect(paths()).toHaveLength(2);
  locks.query = query;

  // This page's own node lock, and a quick call's storage lock it holds
  // itself, are not somebody else's - even for a lease nothing has used yet,
  // which holds no lock of its own to tell this page by. That is the lease
  // every sweep runs on: a page starting, and a lock.
  locks.held.set("awful-quick-8899aabbccddeeff", "this-page");
  await self.sweep();
  expect(paths()).toEqual([]);
  // The lock that told which page this is went with the sweep.
  expect([...locks.held.keys()].sort()).toEqual(["awful-quick-8899aabbccddeeff", "awful:node"]);
});

it("holds no lock until it is first used", async () => {
  const lease = new OPFSLease();
  await lease.sweep();
  expect(locks.held.size).toBe(0);
  await lease.end();
  expect(locks.held.size).toBe(0);
});

it("touches nothing when it cannot tell who is running", async () => {
  vi.stubGlobal("navigator", { storage: disk.storage });
  await write(`${STAGING_DIR}/3a1392f4-7763-43e2-a8a9-7cd8fb556978`, "older staging");
  await write(`${PIECES_DIR}/0123456789abcdef/0`, "someone's piece");
  await new OPFSLease().sweep();
  expect(paths()).toHaveLength(2);
});

it("refuses outright without browser storage support", async () => {
  vi.stubGlobal("navigator", { storage: {}, locks });
  await expect(new OPFSLease().directory(STAGING_DIR)).rejects.toThrow("browser storage support");
});
