import { beforeEach, describe, expect, it, vi } from "vitest";

const { playWafuruSound, playWafuruOffSound } = vi.hoisted(() => ({
  playWafuruSound: vi.fn(async () => {}),
  playWafuruOffSound: vi.fn(async () => {}),
}));
vi.mock("./sounds", () => ({ playWafuruSound, playWafuruOffSound }));

import { bootSoundOn, playBootSound, pressDmsButton } from "./boot-sound";

// No DOM in these tests: a window that takes events, and a button holding an icon.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});
const win = new EventTarget();
vi.stubGlobal("window", win);
const icon = {};
const other = {};
const button = { contains: (node: unknown) => node === icon || node === button } as unknown as Element;

function fire(type: string, target: unknown, repeat = false): void {
  const event = Object.assign(new Event(type), { repeat });
  Object.defineProperty(event, "target", { value: target });
  win.dispatchEvent(event);
}

const press = (times: number, type: "pointerdown" | "keydown" = "pointerdown", on: unknown = icon) => {
  for (let i = 0; i < times; i++) {
    fire(type, on);
    pressDmsButton(button);
  }
};
const played = () => playWafuruSound.mock.calls.length;

let now = 10_000;
vi.spyOn(performance, "now").mockImplementation(() => now);

beforeEach(() => {
  store.clear();
  playWafuruSound.mockClear();
  playWafuruOffSound.mockClear();
  fire("pointerdown", other);
});

describe("boot sound", () => {
  it("plays and turns on at the seventh press in a row", () => {
    press(6);
    expect(played()).toBe(0);
    expect(bootSoundOn()).toBe(false);
    press(1);
    expect(played()).toBe(1);
    expect(bootSoundOn()).toBe(true);
  });

  it("turns off at seven more, with its own small sound", () => {
    press(7);
    press(6);
    expect(bootSoundOn()).toBe(true);
    press(1);
    expect(bootSoundOn()).toBe(false);
    expect(played()).toBe(1);
    expect(playWafuruOffSound).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("starts again after a second without a press (on: %s)", (on) => {
    if (on) press(7);
    press(6);
    now += 1000;
    press(6);
    expect(bootSoundOn()).toBe(on);
    press(1);
    expect(bootSoundOn()).toBe(!on);
  });

  it("allows just under a second between presses", () => {
    for (let i = 0; i < 7; i++) {
      now += 999;
      press(1);
    }
    expect(bootSoundOn()).toBe(true);
  });

  it.each(["pointerdown", "keydown"])("starts again at a %s elsewhere", (type) => {
    press(6);
    fire(type, other);
    press(6);
    expect(bootSoundOn()).toBe(false);
    press(1);
    expect(bootSoundOn()).toBe(true);
  });

  it("counts a held Enter as one press", () => {
    for (let i = 0; i < 30; i++) {
      fire("keydown", button, i > 0);
      pressDmsButton(button);
    }
    expect(bootSoundOn()).toBe(false);
  });

  it("counts Enter and Space on the button itself", () => {
    press(7, "keydown", button);
    expect(bootSoundOn()).toBe(true);
  });

  it("plays when the app loads only while it is on", () => {
    playBootSound();
    expect(played()).toBe(0);
    press(7);
    playWafuruSound.mockClear();
    playBootSound();
    expect(played()).toBe(1);
  });
});
