/**
 * Ground truth about the network, measured OUTSIDE the app's own machinery.
 *
 * Every other probe in this bundle observes the app observing the network, so
 * every one of them fails in the same two ways at once: "no candidate pair
 * succeeded" is what a broken ICE path looks like AND what a bug that never
 * applied its ICE servers looks like. Nothing already recorded can separate
 * them, and that is the whole of the question a user asks when a call fails:
 * is it my internet or is it the app.
 *
 * A TURN allocation is the one measurement that answers it. It uses nothing
 * from the transport layer - no libp2p, no mediasoup, no signalling, no peer -
 * so its verdict is independent of every bug those can have. With
 * `iceTransportPolicy: "relay"` the browser gathers relay candidates and
 * NOTHING else, which makes the outcome unambiguous: a relay candidate means
 * the TURN server accepted an allocation from this network right now; zero
 * candidates at gathering-complete means it did not.
 */

/** How long an allocation may take before the network is the answer. */
export const TURN_PROBE_TIMEOUT_MS = 5000;

export interface TurnProbeResult {
  ok: boolean;
  /** Wall time until the verdict. */
  ms: number;
  /** Relay candidates gathered. Zero with `ok: false` is the useful case. */
  relayCandidates: number;
  /** Why it ended: a gathered candidate, an empty gathering, or the clock. */
  outcome: "candidate" | "gathered-none" | "timeout" | "threw";
  err?: string;
}

type PcFactory = (config: RTCConfiguration) => RTCPeerConnection;

/** Only entries that can actually allocate: a TURN url with a credential. */
export function turnOnly(servers: readonly RTCIceServer[]): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  for (const s of servers) {
    const urls = typeof s.urls === "string" ? [s.urls] : (s.urls ?? []);
    const turn = urls.filter((u) => /^turns?:/i.test(u));
    if (turn.length === 0) continue;
    if (typeof s.username !== "string" || typeof s.credential !== "string") {
      continue;
    }
    out.push({ ...s, urls: turn });
  }
  return out;
}

/**
 * Ask the TURN server for an allocation and time it.
 *
 * Returns null when there is nothing to ask - no credentialled TURN entry, or
 * no WebRTC at all. That is not a failure: the credential path reports a
 * missing credential itself, and reporting it twice would double-count it in
 * every rule that reads these events.
 */
export async function probeTurnAllocation(
  servers: readonly RTCIceServer[],
  opts: {
    createPc?: PcFactory;
    timeoutMs?: number;
    now?: () => number;
  } = {}
): Promise<TurnProbeResult | null> {
  const iceServers = turnOnly(servers);
  if (iceServers.length === 0) return null;

  const g = globalThis as unknown as { RTCPeerConnection?: PcFactory };
  const create =
    opts.createPc ??
    (typeof g.RTCPeerConnection === "function"
      ? (config: RTCConfiguration) =>
          new (g.RTCPeerConnection as unknown as new (
            c: RTCConfiguration
          ) => RTCPeerConnection)(config)
      : null);
  if (!create) return null;

  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? TURN_PROBE_TIMEOUT_MS;
  const startedAt = now();
  let pc: RTCPeerConnection | null = null;
  let relayCandidates = 0;

  try {
    pc = create({ iceServers, iceTransportPolicy: "relay" });
    const settled = new Promise<TurnProbeResult["outcome"]>((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      const done = (outcome: TurnProbeResult["outcome"]) => {
        clearTimeout(timer);
        resolve(outcome);
      };
      pc!.onicecandidate = ({ candidate }) => {
        // The end-of-candidates signal, not a candidate.
        if (!candidate || !candidate.candidate) {
          done(relayCandidates > 0 ? "candidate" : "gathered-none");
          return;
        }
        // With a relay-only policy every candidate IS a relay candidate, but
        // read the type rather than trust the policy: a browser that ignores
        // the policy would otherwise turn a host candidate into a passing
        // TURN probe, which is the one wrong answer that matters here.
        if (candidate.type === "relay" || / typ relay /.test(candidate.candidate)) {
          relayCandidates++;
          done("candidate");
        }
      };
      pc!.onicegatheringstatechange = () => {
        if (pc?.iceGatheringState !== "complete") return;
        done(relayCandidates > 0 ? "candidate" : "gathered-none");
      };
    });

    // A data channel is what gives the offer something to gather for; no
    // media, no getUserMedia, no permission prompt.
    pc.createDataChannel("turn-probe");
    await pc.setLocalDescription(await pc.createOffer());

    const outcome = await settled;
    return {
      ok: outcome === "candidate",
      ms: now() - startedAt,
      relayCandidates,
      outcome,
    };
  } catch (err) {
    return {
      ok: false,
      ms: now() - startedAt,
      relayCandidates,
      outcome: "threw",
      err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  } finally {
    // The probe must never be the thing that exhausts the connection budget
    // it exists to help diagnose.
    try {
      pc?.close();
    } catch {
      // Nothing left to do about it.
    }
  }
}
