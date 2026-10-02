import { afterEach, expect, it, vi } from "vitest";
import { newRoomSecret } from "./keys";

/**
 * The OPAQUE library decodes and compiles its wasm while it loads. Every page
 * that reads or shows a short code imports this module, so a static import
 * paid for that on every load; only creating or redeeming a code needs it.
 */
afterEach(() => {
  vi.doUnmock("@serenity-kit/opaque");
  vi.resetModules();
});

async function counted() {
  vi.resetModules();
  const loads = { count: 0 };
  vi.doMock("@serenity-kit/opaque", async (importOriginal) => {
    loads.count++;
    return await importOriginal();
  });
  return loads;
}

it("does not load OPAQUE to read, show or bound a code", async () => {
  const loads = await counted();
  const pairing = await import("./invitation-pairing");
  // invite.ts parses pasted links with it, and the relay client imports the
  // host class: neither may pull the library in by being imported.
  await import("../invite");
  await import("../invite-pairing");
  expect(pairing.parsePairingCode("k5t-8r5")).toEqual({ locator: "k5", password: "t8r5" });
  expect(pairing.formatPairingCode("k5", "t8r5")).toBe("k5t-8r5");
  expect(pairing.pairingLimits({ uses: 2 }).uses).toBe(2);
  expect(loads.count).toBe(0);
});

it("loads OPAQUE once, on the first pairing, and pairs with it", async () => {
  const loads = await counted();
  const pairing = await import("./invitation-pairing");
  const secret = newRoomSecret();
  const host = await pairing.InvitationPairingHost.create(secret);
  expect(loads.count).toBe(1);
  const join = await pairing.startPairingJoin(pairing.formatPairingCode(host.locator, host.password));
  const proof = join.respond(host.start(join.attempt, join.request));
  expect(await join.open(await host.finish(join.attempt, proof))).toBe(secret);
  expect(loads.count).toBe(1);
});

// A code being redeemed shows its error as it is, and the browser's text for a
// chunk that did not download means nothing to the person holding the code.
it("says plainly when OPAQUE could not be downloaded, and tries again next time", async () => {
  vi.resetModules();
  let loads = 0;
  vi.doMock("@serenity-kit/opaque", async (importOriginal) => {
    if (loads++ === 0) throw new TypeError("Failed to fetch dynamically imported module");
    return await importOriginal();
  });
  const pairing = await import("./invitation-pairing");
  await expect(pairing.startPairingJoin("k5t-8r5")).rejects.toThrow(
    "Couldn't load short codes. Check your connection and try again."
  );
  const host = await pairing.InvitationPairingHost.create(newRoomSecret());
  expect(host.locator).toHaveLength(2);
  expect(loads).toBe(2);
});
