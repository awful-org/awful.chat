import { afterEach, expect, it, vi } from "vitest";
import { hostInvitationPairing, joinInvitationPairing } from "./invite-pairing";
import { newRoomSecret } from "./room-security/keys";
import { parsePairingCode } from "./room-security/invitation-pairing";

vi.mock("./runtime-config", () => ({ apiUrl: () => "https://relay.example" }));
afterEach(() => { vi.restoreAllMocks(); });

interface Msg { attempt: string; kind: string; payload: string }
function mailbox() {
  const inbox: Msg[] = [];
  const replies = new Map<string, Msg[]>();
  const requests: { url: string; body: Record<string, string>; signal?: AbortSignal | null }[] = [];
  let closed = false;
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    options?.signal?.throwIfAborted();
    const b = JSON.parse(options!.body as string);
    requests.push({ url: String(url), body: b, signal: options?.signal });
    let result: object = { messages: [] };
    if (b.action === "create") result = { token: "T".repeat(43) };
    else if (b.action === "cancel") closed = true;
    else if (closed) return new Response("{}", { status: 404 });
    else if (b.action === "host-poll") result = { messages: inbox.splice(0) };
    else if (b.action === "join-poll") { result = { messages: replies.get(b.attempt) ?? [] }; replies.delete(b.attempt); }
    else if (b.action === "start" || b.action === "finish") inbox.push({ attempt: b.attempt, kind: b.kind, payload: b.payload });
    else if (b.action === "reply") replies.set(b.attempt, [{ attempt: b.attempt, kind: b.kind, payload: b.payload }]);
    return Response.json(result);
  });
  return { requests, fetchSpy };
}

it("runs real OPAQUE through the UI network adapters without exposing the capability or password", async () => {
  const relay = mailbox();
  const secret = newRoomSecret();
  const status = vi.fn();
  const pair = await hostInvitationPairing(secret, status);
  try {
    expect(await joinInvitationPairing(pair.code, new AbortController().signal)).toBe(secret);
    expect(status).toHaveBeenCalledWith("Invitation delivered. This code is now used.");
    const password = parsePairingCode(pair.code)!.password;
    for (const req of relay.requests) {
      expect(req.url).toBe("https://relay.example/invite");
      const wire = JSON.stringify(req.body);
      expect(wire).not.toContain(secret);
      expect(wire).not.toContain(password);
      expect(wire).not.toContain("registrationRecord");
      expect(wire).not.toContain("serverSetup");
    }
  } finally { pair.cancel(); }
}, 15000);

it("draws a new locator when the relay says the first is in use", async () => {
  const relay = mailbox();
  const creates: string[] = [];
  const real = relay.fetchSpy.getMockImplementation()!;
  relay.fetchSpy.mockImplementation(async (url, options) => {
    const b = JSON.parse(options!.body as string);
    if (b.action === "create") {
      creates.push(b.locator);
      if (creates.length === 1) return new Response("{}", { status: 409 });
    }
    return real(url, options);
  });
  const secret = newRoomSecret();
  const pair = await hostInvitationPairing(secret, vi.fn());
  try {
    expect(creates).toHaveLength(2);
    expect(parsePairingCode(pair.code)!.locator).toBe(creates[1]);
    expect(await joinInvitationPairing(pair.code, new AbortController().signal)).toBe(secret);
  } finally { pair.cancel(); }
}, 15000);

it("gives up on a relay that refuses for any other reason", async () => {
  const relay = mailbox();
  let creates = 0;
  relay.fetchSpy.mockImplementation(async () => {
    creates++;
    return new Response("{}", { status: 429 });
  });
  await expect(hostInvitationPairing(newRoomSecret(), vi.fn())).rejects.toThrow("Pairing unavailable");
  expect(creates).toBe(1);
});

it("aborts preparation before publishing a code and does not start polling", async () => {
  const controller = new AbortController();
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
    const b = JSON.parse(options!.body as string); calls.push(b.action);
    if (b.action === "create") controller.abort();
    return Response.json({ token: "T".repeat(43), messages: [] });
  });
  await expect(hostInvitationPairing(newRoomSecret(), vi.fn(), controller.signal)).rejects.toThrow();
  expect(calls).not.toContain("host-poll");
  expect(calls).toContain("cancel");
});

it("cancels in-flight host polling on dialog close and suppresses stale status", async () => {
  const relay = mailbox(); const status = vi.fn(); const controller = new AbortController();
  const pair = await hostInvitationPairing(newRoomSecret(), status, controller.signal);
  controller.abort(); pair.cancel();
  expect(relay.requests.filter(r => r.body.action === "cancel")).toHaveLength(1);
  expect(relay.requests.find(r => r.body.action === "host-poll")!.signal!.aborted).toBe(true);
  expect(status).not.toHaveBeenCalled();
});

it("rejects oversized relay responses while reading and cancels the stream", async () => {
  const cancel = vi.fn();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(16385)); }, cancel,
  })));
  await expect(hostInvitationPairing(newRoomSecret(), vi.fn())).rejects.toThrow("Invalid pairing response");
  expect(cancel).toHaveBeenCalled();
});

it("does not contact the relay for an already cancelled join", async () => {
  const spy = vi.spyOn(globalThis, "fetch"); const controller = new AbortController(); controller.abort();
  await expect(joinInvitationPairing("1234-5678 ABCD-EFGH", controller.signal)).rejects.toThrow();
  expect(spy).not.toHaveBeenCalled();
});
