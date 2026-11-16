import { describe, expect, it, vi } from "vitest";
import { LibP2PVoice } from "./voice";

/** A sender that remembers which track it carries, like RTCRtpSender. */
function fakeSender(track: MediaStreamTrack) {
  const sender = {
    track,
    replaceTrack: vi.fn(async (next: MediaStreamTrack) => { sender.track = next; }),
  };
  return sender;
}

/** The outgoing voice track; clone() is how the silent stand-in is made. */
function fakeTrack(id: string): MediaStreamTrack {
  const track = {
    kind: "audio", id, enabled: true, stop: vi.fn(),
    clone: () => fakeTrack(`${id}-clone`),
  };
  return track as unknown as MediaStreamTrack;
}

function setup(peers: string[]) {
  const mic = fakeTrack("mic");
  const voice = new LibP2PVoice({ selfId: () => "self", peers: () => peers, on() {}, off() {} } as never, null);
  const internals = voice as never as Record<string, unknown>;
  internals.processedStream = { getAudioTracks: () => [mic] };
  const senders = new Map<string, ReturnType<typeof fakeSender>>();
  for (const peerId of peers) {
    const sender = fakeSender(mic);
    senders.set(peerId, sender);
    (internals.remotePeers as Map<string, unknown>).set(peerId, { peerId, pc: { getSenders: () => [sender], close: vi.fn() } });
  }
  return { voice, senders, mic };
}

describe("withholding voice from one person", () => {
  it("sends that person silence, never the microphone, and everyone else the voice", async () => {
    const { voice, senders, mic } = setup(["ana", "ben"]);
    voice.setWithholdPolicy((peerId) => peerId === "ana");
    await voice.refreshWithheld();
    const ana = senders.get("ana")!.track;
    // A disabled copy: the link keeps carrying packets, of silence.
    expect(ana).not.toBe(mic);
    expect(ana.enabled).toBe(false);
    expect(senders.get("ben")!.track).toBe(mic);
  });

  it("gives the voice back when the choice is undone", async () => {
    const { voice, senders, mic } = setup(["ana"]);
    let withheld = true;
    voice.setWithholdPolicy(() => withheld);
    await voice.refreshWithheld();
    expect(senders.get("ana")!.track).not.toBe(mic);
    withheld = false;
    await voice.refreshWithheld();
    expect(senders.get("ana")!.track).toBe(mic);
  });

  it("makes one silent copy for every withheld person, and leaves untouched links alone", async () => {
    const { voice, senders } = setup(["ana", "ben", "cy"]);
    voice.setWithholdPolicy((peerId) => peerId !== "cy");
    await voice.refreshWithheld();
    expect(senders.get("ana")!.track).toBe(senders.get("ben")!.track);
    expect(senders.get("cy")!.replaceTrack).not.toHaveBeenCalled();
  });
});
