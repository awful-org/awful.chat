import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The camera list is the whole fix, so the things worth pinning are the two
 * that made an iPhone invisible: a list that goes stale, and a remembered
 * choice that outlives the device it names.
 */

let deviceList: { kind: string; deviceId: string; label: string }[] = [];
let listeners: (() => void)[] = [];
const prefs: Record<string, unknown> = {};
const transportState = { cameraOff: true };

vi.mock("$lib/transport/audio-prefs", () => ({
  loadAudioPrefs: () => ({ cameraDevice: prefs.cameraDevice ?? null }),
  saveAudioPrefs: (patch: Record<string, unknown>) =>
    void Object.assign(prefs, patch),
}));
vi.mock("$lib/transport/call.svelte", () => ({
  onCameraStarted: vi.fn(),
  startCamera: vi.fn(async () => {}),
  stopCamera: vi.fn(),
}));
vi.mock("$lib/transport/transport.svelte", () => ({ transportState }));

function installMediaDevices() {
  listeners = [];
  vi.stubGlobal("navigator", {
    mediaDevices: {
      enumerateDevices: async () => deviceList,
      addEventListener: (_type: string, fn: () => void) => listeners.push(fn),
    },
  });
}

async function load() {
  vi.resetModules();
  installMediaDevices();
  return import("./cameras.svelte");
}

const CAM = (deviceId: string, label = "") => ({
  kind: "videoinput",
  deviceId,
  label,
});

describe("cameras", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    deviceList = [];
    for (const k of Object.keys(prefs)) delete prefs[k];
    transportState.cameraOff = true;
  });

  it("lists video inputs and nothing else", async () => {
    deviceList = [
      CAM("cam-1", "FaceTime HD"),
      { kind: "audioinput", deviceId: "mic-1", label: "Mic" },
      CAM("cam-2", "Flavio's iPhone"),
    ];
    const m = await load();
    await m.refreshCameras();
    expect(m.cameras.devices.map((d) => d.deviceId)).toEqual(["cam-1", "cam-2"]);
  });

  it("notices a camera that arrives while the page is open", async () => {
    // The iPhone case: a Continuity Camera attaches when the phone is
    // unlocked and nearby, long after any list read at mount.
    deviceList = [CAM("cam-1", "FaceTime HD")];
    const m = await load();
    m.watchCameras();
    await Promise.resolve();
    expect(m.cameras.devices).toHaveLength(1);

    deviceList = [CAM("cam-1", "FaceTime HD"), CAM("cam-2", "Flavio's iPhone")];
    for (const fire of listeners) fire();
    await vi.waitFor(() => expect(m.cameras.devices).toHaveLength(2));
    expect(m.cameras.devices[1].label).toBe("Flavio's iPhone");
  });

  it("forgets a remembered camera once it is gone", async () => {
    prefs.cameraDevice = "cam-2";
    deviceList = [CAM("cam-1", "FaceTime HD")];
    const m = await load();
    expect(m.cameras.selected).toBe("cam-2");
    await m.refreshCameras();
    // Otherwise the picker shows a selection that does not exist and
    // getUserMedia quietly hands back something else.
    expect(m.cameras.selected).toBeNull();
    expect(prefs.cameraDevice).toBeNull();
  });

  it("keeps a remembered camera that is still there", async () => {
    prefs.cameraDevice = "cam-2";
    deviceList = [CAM("cam-1"), CAM("cam-2", "Flavio's iPhone")];
    const m = await load();
    await m.refreshCameras();
    expect(m.cameras.selected).toBe("cam-2");
  });

  it("says when the browser is withholding the names", async () => {
    deviceList = [CAM("cam-1"), CAM("cam-2")];
    const m = await load();
    await m.refreshCameras();
    expect(m.cameras.unnamed).toBe(true);
    expect(m.cameraLabel(m.cameras.devices[0], 0)).toBe("Camera 1");

    deviceList = [CAM("cam-1", "FaceTime HD"), CAM("cam-2")];
    await m.refreshCameras();
    expect(m.cameras.unnamed).toBe(false);
  });

  it("restarts a running camera when the choice changes", async () => {
    deviceList = [CAM("cam-1", "FaceTime HD"), CAM("cam-2", "iPhone")];
    const m = await load();
    const { startCamera, stopCamera } = await import(
      "$lib/transport/call.svelte"
    );
    transportState.cameraOff = false;

    await m.setCamera("cam-2");

    // Stop and start is what republishes the track, which is the only way
    // the other side sees the new picture.
    expect(stopCamera).toHaveBeenCalled();
    expect(startCamera).toHaveBeenCalled();
    expect(prefs.cameraDevice).toBe("cam-2");
  });

  it("does not start a camera that was off", async () => {
    deviceList = [CAM("cam-1"), CAM("cam-2")];
    const m = await load();
    const { startCamera } = await import("$lib/transport/call.svelte");
    await m.setCamera("cam-2");
    expect(startCamera).not.toHaveBeenCalled();
    expect(prefs.cameraDevice).toBe("cam-2");
  });

  it("survives a browser with no media devices at all", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", {});
    const m = await import("./cameras.svelte");
    await expect(m.refreshCameras()).resolves.toBeUndefined();
    expect(() => m.watchCameras()).not.toThrow();
  });
});
