import { expect, it, vi } from "vitest";
import { activateSecurityCutover, installSecurityCutover, navigateSecurityCutoverWindows } from "./pwa-cutover";

function storage() {
  const entries = new Map<string, Response>();
  return { open: async () => ({
    match: async (key: string) => entries.get(key),
    put: async (key: string, value: Response) => { entries.set(key, value); },
    delete: async (key: string) => entries.delete(key),
  }) } as unknown as CacheStorage;
}

it("activates and reloads an installed legacy app exactly once", async () => {
  const cache = storage();
  const skip = vi.fn(async () => {});
  const reload = vi.fn(async () => {});
  await installSecurityCutover(cache, true, skip);
  expect(skip).toHaveBeenCalledOnce();
  await activateSecurityCutover(cache, reload);
  expect(reload).toHaveBeenCalledOnce();
  await installSecurityCutover(cache, true, skip);
  await activateSecurityCutover(cache, reload);
  expect(skip).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledOnce();
});

it("does not reload a fresh installation or force its later routine update", async () => {
  const cache = storage();
  const skip = vi.fn(async () => {});
  const reload = vi.fn(async () => {});
  await installSecurityCutover(cache, false, skip);
  await activateSecurityCutover(cache, reload);
  await installSecurityCutover(cache, true, skip);
  expect(skip).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

it("does not reload-loop when a window cannot navigate", async () => {
  const cache = storage();
  await installSecurityCutover(cache, true, async () => {});
  await expect(activateSecurityCutover(cache, async () => { throw new Error("closed"); }))
    .rejects.toThrow("closed");
  const reload = vi.fn(async () => {});
  await activateSecurityCutover(cache, reload);
  expect(reload).not.toHaveBeenCalled();
});

it("finishes activation while client navigations wait for the worker to activate", async () => {
  const cache = storage();
  await installSecurityCutover(cache, true, async () => {});
  let finishNavigation!: () => void;
  const pending = new Promise<void>((resolve) => { finishNavigation = resolve; });
  const first = { url: "https://app.test/app", navigate: vi.fn(() => pending) };
  const closed = { url: "https://app.test/r/old", navigate: vi.fn(async () => { throw new Error("closed"); }) };
  await activateSecurityCutover(cache, async () => {
    navigateSecurityCutoverWindows([first, closed]);
  });
  expect(first.navigate).toHaveBeenCalledWith(first.url);
  expect(closed.navigate).toHaveBeenCalledWith(closed.url);
  finishNavigation();
  const reload = vi.fn(async () => {});
  await activateSecurityCutover(cache, reload);
  expect(reload).not.toHaveBeenCalled();
});
