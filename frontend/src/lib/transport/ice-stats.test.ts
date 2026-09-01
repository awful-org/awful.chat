import { describe, expect, it } from "vitest";
import { succeededPair } from "./ice-stats";

/** Chrome: the pair carries ids, and the types live on separate entries. */
const chrome = [
  { id: "I-local", type: "local-candidate", candidateType: "relay", protocol: "udp" },
  { id: "I-remote", type: "remote-candidate", candidateType: "srflx", protocol: "udp" },
  {
    id: "CP1",
    type: "candidate-pair",
    state: "succeeded",
    nominated: true,
    localCandidateId: "I-local",
    remoteCandidateId: "I-remote",
    currentRoundTripTime: 0.042,
  },
];

/** Firefox: the types are on the pair itself. */
const firefox = [
  {
    id: "CP1",
    type: "candidate-pair",
    state: "succeeded",
    nominated: true,
    localCandidateType: "host",
    remoteCandidateType: "host",
    currentRoundTripTime: 0.002,
  },
];

describe("succeededPair", () => {
  it("dereferences the candidate ids Chrome reports", () => {
    // The bug this exists to kill: reading pair.localCandidateType here gives
    // undefined, so a call relayed through TURN reported itself as direct.
    expect(succeededPair(chrome)).toEqual({
      local: "relay",
      remote: "srflx",
      relayed: true,
      rttMs: 42,
    });
  });

  it("reads the inline types Firefox reports", () => {
    expect(succeededPair(firefox)).toEqual({
      local: "host",
      remote: "host",
      relayed: false,
      rttMs: 2,
    });
  });

  it("prefers the nominated pair when several have succeeded", () => {
    const rows = [
      { id: "A", type: "candidate-pair", state: "succeeded", localCandidateType: "host", remoteCandidateType: "host" },
      { id: "B", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateType: "relay", remoteCandidateType: "relay" },
    ];
    expect(succeededPair(rows)?.relayed).toBe(true);
  });

  it("returns null when nothing has succeeded", () => {
    // Not the same as "types unknown": no pair at all is the answer to why
    // there is no audio, and the caller must be able to tell them apart.
    const rows = [{ id: "CP1", type: "candidate-pair", state: "in-progress" }];
    expect(succeededPair(rows)).toBeNull();
  });

  it("accepts a real RTCStatsReport, which is a Map", () => {
    const report = new Map(chrome.map((r) => [r.id, r]));
    expect(succeededPair(report)?.relayed).toBe(true);
  });

  it("survives a report with no types anywhere", () => {
    const rows = [
      { id: "CP1", type: "candidate-pair", state: "succeeded", localCandidateId: "gone" },
    ];
    expect(succeededPair(rows)).toEqual({
      local: null,
      remote: null,
      relayed: false,
      rttMs: null,
    });
  });
});
