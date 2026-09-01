/**
 * Can this lab carry media at all?
 *
 * Ask before trusting any result the lab produces. The e2e harness next door
 * cannot: Firefox headless never completes an ICE handshake there, so its
 * call tests asserts counters and no test in this repo has ever asserted that
 * audio arrived. If the lab has the same hole, every green run it prints is
 * worthless, and worse than worthless - it looks like proof.
 *
 * So: two real browsers, a real offer/answer carried by this script, a real
 * ICE handshake between two container network namespaces, and a real Opus
 * stream. It passes only when bytes actually arrive at the far end.
 *
 * No app, no relay, no SFU. A failure here is the lab, never the product.
 */
import { Cdp } from "./cdp.mjs";

const ORIGIN = process.env.LAB_ORIGIN ?? "http://lab-page:8000/blank.html";
const PORTS = (process.env.LAB_PORTS ?? "9331,9332").split(",").map(Number);

const a = await new Cdp(PORTS[0]).open();
const b = await new Cdp(PORTS[1]).open();

try {
  await a.goto(ORIGIN);
  await b.goto(ORIGIN);

  // A synthetic tone, not getUserMedia: it needs no permission and no fake
  // device, and it proves the same path - an encoder, SRTP, and a decoder.
  const makePc = (extra = "") => `(async () => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    window.__lab = { pc: new RTCPeerConnection(${JSON.stringify({ iceServers: [] })}), cands: [] };
    const pc = window.__lab.pc;
    for (const track of dest.stream.getAudioTracks()) pc.addTrack(track, dest.stream);
    pc.onicecandidate = (e) => { if (e.candidate) window.__lab.cands.push(e.candidate.toJSON()); };
    pc.ontrack = (e) => { window.__lab.remote = e.streams[0] ?? null; };
    ${extra}
    return true;
  })()`;

  await a.eval(makePc());
  await b.eval(makePc());

  const offer = await a.eval(`(async () => {
    const pc = window.__lab.pc;
    const o = await pc.createOffer();
    await pc.setLocalDescription(o);
    return pc.localDescription.sdp;
  })()`);

  const answer = await b.eval(`(async () => {
    const pc = window.__lab.pc;
    await pc.setRemoteDescription({ type: "offer", sdp: ${JSON.stringify(offer)} });
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    return pc.localDescription.sdp;
  })()`);

  await a.eval(`window.__lab.pc.setRemoteDescription({ type: "answer", sdp: ${JSON.stringify(answer)} }).then(() => true)`);

  // Trickle both ways. Host candidates are container IPs on one bridge, so
  // there is a real path here without STUN.
  const drain = async (from, to) => {
    const cands = await from.eval(`window.__lab.cands.splice(0)`);
    for (const c of cands) {
      await to.eval(`window.__lab.pc.addIceCandidate(${JSON.stringify(c)}).then(() => true).catch(() => false)`);
    }
    return cands.length;
  };

  const deadline = Date.now() + 30_000;
  let connected = false;
  while (Date.now() < deadline) {
    await drain(a, b);
    await drain(b, a);
    const [sa, sb] = await Promise.all([
      a.eval(`window.__lab.pc.connectionState`),
      b.eval(`window.__lab.pc.connectionState`),
    ]);
    if (sa === "connected" && sb === "connected") { connected = true; break; }
    if (sa === "failed" || sb === "failed") break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const state = await Promise.all([
    a.eval(`window.__lab.pc.connectionState`),
    b.eval(`window.__lab.pc.connectionState`),
  ]);
  console.log(`ice: a=${state[0]} b=${state[1]}`);
  if (!connected) throw new Error("ICE never completed - the lab cannot carry media");

  // The assertion the e2e harness could never make: bytes, at the far end,
  // growing.
  const bytesAt = async (peer) => peer.eval(`(async () => {
    const stats = await window.__lab.pc.getStats();
    for (const r of stats.values()) {
      if (r.type === "inbound-rtp" && r.kind === "audio") return r.bytesReceived ?? 0;
    }
    return 0;
  })()`);

  const first = await bytesAt(b);
  await new Promise((r) => setTimeout(r, 3000));
  const second = await bytesAt(b);
  console.log(`inbound audio bytes at b: ${first} -> ${second}`);
  if (!(second > first && second > 0)) {
    throw new Error("ICE connected but no audio arrived - a green lab run would be a lie");
  }

  // Dereference the candidate ids rather than reading a type off the pair:
  // Chrome puts no candidate type there, which is the bug this lab found in
  // the app itself on its first run. The wrong pattern must not live here.
  const pair = await a.eval(`(async () => {
    const stats = await window.__lab.pc.getStats();
    const cands = {}; let best = null;
    for (const r of stats.values()) {
      if (r.type === "local-candidate" || r.type === "remote-candidate") cands[r.id] = r;
      if (r.type === "candidate-pair" && r.state === "succeeded" && (!best || r.nominated)) best = r;
    }
    if (!best) return "none";
    const t = (inline, id) => inline ?? cands[id]?.candidateType ?? "?";
    return t(best.localCandidateType, best.localCandidateId) + "/" +
           t(best.remoteCandidateType, best.remoteCandidateId);
  })()`);
  console.log(`path: ${pair}`);
  console.log("LAB SELF-CHECK PASSED: two browsers, real ICE, real RTP");
} finally {
  a.close();
  b.close();
}
