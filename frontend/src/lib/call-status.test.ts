import { describe, expect, it } from "vitest";
import { MAX_ACTIVITIES, NO_CALL_STATUS, parseCallStatus, wireCallStatus } from "./call-status";

const waffle = { plugin: "waffle-party", label: "In Waffle Party" };
const app = { plugin: "app", label: "Playing Jeopardy" };

describe("a call status on the wire", () => {
  it("says what is so and leaves out what is not", () => {
    expect(wireCallStatus(NO_CALL_STATUS)).toEqual({});
    expect(wireCallStatus({ sharing: true, activities: [] })).toEqual({ sharing: true });
    expect(wireCallStatus({ sharing: false, activities: [waffle] })).toEqual({ activities: [waffle] });
  });

  it("comes back as it went", () => {
    for (const status of [NO_CALL_STATUS, { sharing: true, activities: [waffle, app] }]) {
      expect(parseCallStatus(JSON.parse(JSON.stringify(wireCallStatus(status))))).toEqual(status);
    }
  });

  it("tells nothing said from a build that says nothing", () => {
    expect(parseCallStatus({})).toEqual(NO_CALL_STATUS);
    for (const raw of [undefined, null, "sharing", [], 1]) expect(parseCallStatus(raw)).toBeNull();
  });

  it("takes nothing a peer sends on faith", () => {
    const status = parseCallStatus({
      sharing: "yes",
      activities: [
        null,
        "x",
        { plugin: "../evil", label: "no" },
        { plugin: "app", label: 5 },
        { plugin: "app", label: "line\none‮" + "x".repeat(200) },
      ],
    })!;
    expect(status.sharing).toBe(false);
    expect(parseCallStatus({ activities: [{ plugin: "app", label: " a\n‮b " }] })!.activities).toEqual([
      { plugin: "app", label: "a b" },
    ]);
    // Bounded, and one line a plugin, however many are sent.
    const many = Array.from({ length: 50 }, (_, i) => ({ plugin: `p-${i}`, label: "x".repeat(500) }));
    const bounded = parseCallStatus({ activities: many })!.activities;
    expect(bounded).toHaveLength(MAX_ACTIVITIES);
    expect(bounded[0].label).toHaveLength(48);
    expect(parseCallStatus({ activities: [app, { ...app, label: "again" }] })!.activities).toEqual([app]);
    expect(parseCallStatus({ activities: "nope" })).toEqual(NO_CALL_STATUS);
  });
});
