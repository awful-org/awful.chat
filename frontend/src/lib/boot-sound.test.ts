import { beforeEach, describe, expect, it, vi } from "vitest";

const playWafuruSound = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./sounds", () => ({ playWafuruSound }));

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

function fire(type: "pointerdown" | "keydown", target: unknown): void {
  const event = new Event(type);
  Object.defineProperty(event, "target", { value: target });
  win.dispatchEvent(event);
}

const press = (times: number, type: "pointerdown" | "keydown" = "pointerdown", on: unknown = icon) => {
  for (let i = 0; i < times; i++) {
    fire(type, on);
    pressDmsButton(button);
  }
};
const played = async () => {
  await vi.dynamicImportSettled();
  return playWafuruSound.mock.calls.length;
};

beforeEach(() => {
  store.clear();
  playWafuruSound.mockClear();
  fire("pointerdown", other);
});

describe("boot sound", () => {
  it("plays and turns on at the seventh press in a row", async () => {
    press(6);
    expect(await played()).toBe(0);
    expect(bootSoundOn()).toBe(false);
    press(1);
    expect(await played()).toBe(1);
    expect(bootSoundOn()).toBe(true);
  });

  it("turns off at seven more, without a sound", async () => {
    press(7);
    press(6);
    expect(bootSoundOn()).toBe(true);
    press(1);
    expect(bootSoundOn()).toBe(false);
    expect(await played()).toBe(1);
  });

  it("starts again when anything else is pressed or typed", () => {
    press(6);
    fire("pointerdown", other);
    press(6);
    fire("keydown", other);
    press(6);
    expect(bootSoundOn()).toBe(false);
    press(1);
    expect(bootSoundOn()).toBe(true);
  });

  it("counts Enter and Space on the button itself", () => {
    press(7, "keydown", button);
    expect(bootSoundOn()).toBe(true);
  });

  it("plays when the app loads only while it is on", async () => {
    playBootSound();
    expect(await played()).toBe(0);
    press(7);
    playWafuruSound.mockClear();
    playBootSound();
    expect(await played()).toBe(1);
  });
});
