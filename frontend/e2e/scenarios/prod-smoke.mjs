/**
 * Black-box delivery probe against a DEPLOYED instance (no __awful handle):
 * two fresh identities, a throwaway room, and wall-clock timing of how long
 * a sent message takes to appear in the other peer's DOM.
 *
 *   AWFUL_URL=https://awful.frav.in node scenarios/prod-smoke.mjs
 */
import { Peer, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("deployed instance delivers messages promptly");
const ports = [9307, 9308];
const names = ["ProbeA", "ProbeB"];
const peers = [];

for (let i = 0; i < 2; i++) {
  const p = new Peer(ports[i], names[i]);
  await p.start({ wipe: true });
  await p.signUp(names[i]);
  peers.push(p);
}
const [alice, bob] = peers;

const domHas = (p, needle) => p.eval(
  `document.body.textContent.includes(${JSON.stringify(needle)}) || null`);

try {
  // Alice creates a room through the UI only.
  await alice.waitFor("create form", () => alice.fill("Room name (optional)", "probe"));
  await alice.waitFor("room created", async () => {
    await alice.clickText("Create Room");
    return alice.eval(`/Share this code/i.test(document.body.innerText)`);
  });
  await alice.waitFor("room entered", async () => {
    await alice.clickText("Join Room");
    return alice.eval(`location.pathname.startsWith('/r/') ? location.pathname : null`);
  });
  const code = await alice.eval(`location.pathname.split('/r/')[1]`);
  console.log("room:", code);

  // Bob joins by code through the UI.
  await bob.waitFor("join field", () => bob.fill("Room code, short code or link", code));
  await bob.waitFor("room joined", async () => {
    await bob.fill("Room code, short code or link", code);
    await bob.clickText("Join Room");
    return bob.eval(`location.pathname.startsWith('/r/') ? true : null`);
  });

  // Wait until each side counts 2 members and reports a connected peer.
  const meshed = (p) => p.eval(
    `/1 peer/.test(document.body.textContent) ? true : null`);
  await alice.waitFor("alice meshed", () => meshed(alice), { timeout: 60000 });
  await bob.waitFor("bob meshed", () => meshed(bob), { timeout: 60000 });
  check.ok(true, "both peers report a connected peer (presence works)");

  // Timed delivery, several rounds.
  const latencies = [];
  for (let i = 1; i <= 5; i++) {
    const text = `probe-msg-${i}-${code}`;
    const t0 = Date.now();
    await alice.say(text);
    const arrived = await bob.waitFor(`msg ${i} on bob`, () => domHas(bob, text),
      { timeout: 30000, interval: 250 }).then(() => true).catch(() => false);
    const dt = Date.now() - t0;
    latencies.push({ i, arrived, ms: arrived ? dt : ">30000" });
    console.log(`msg ${i}: arrived=${arrived} in ${dt}ms`);
  }
  const failed = latencies.filter((l) => !l.arrived);
  const slow = latencies.filter((l) => l.arrived && l.ms > 5000);
  check.ok(failed.length === 0, "every message arrived within 30s", latencies);
  check.ok(slow.length === 0, "no message took over 5s", latencies);

  // Reverse direction.
  const rt = `probe-reverse-${code}`;
  const t0 = Date.now();
  await bob.say(rt);
  const revArrived = await alice.waitFor("reverse msg", () => domHas(alice, rt),
    { timeout: 30000, interval: 250 }).then(() => true).catch(() => false);
  check.ok(revArrived, `reverse direction arrived (${Date.now() - t0}ms)`);

  check.finish();
} finally {
  await closeAll(peers);
}
