import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginConfirmBusyError,
  clearPluginConfirms,
  pluginConfirmState,
  requestPluginConfirm,
  resolvePluginConfirm,
} from "./confirm.svelte";

const plugin = { id: "demo", name: "Demo", icon: "lucide:shield-alert" };
const other = { id: "other", name: "Other", icon: "lucide:dices" };
const ask = (over: Record<string, unknown> = {}) =>
  requestPluginConfirm(plugin, { title: "t", message: "m", ...over });

afterEach(() => {
  clearPluginConfirms();
  vi.useRealTimers();
});

describe("plugin confirm queue", () => {
  it("resolves accepted / declined from the user's answer", async () => {
    const pending = ask();
    resolvePluginConfirm(pluginConfirmState.queue[0].id, true);
    await expect(pending).resolves.toBe("accepted");

    const second = ask();
    resolvePluginConfirm(pluginConfirmState.queue[0].id, false);
    await expect(second).resolves.toBe("declined");
    expect(pluginConfirmState.queue).toHaveLength(0);
  });

  it("REJECTS a second request from the same plugin - never a silent decline", async () => {
    const first = ask();
    await expect(ask()).rejects.toBeInstanceOf(PluginConfirmBusyError);
    // The first is untouched and still answerable.
    expect(pluginConfirmState.queue).toHaveLength(1);
    resolvePluginConfirm(pluginConfirmState.queue[0].id, true);
    await expect(first).resolves.toBe("accepted");
  });

  it("lets a DIFFERENT plugin queue behind it", async () => {
    const mine = ask();
    const theirs = requestPluginConfirm(other, { title: "t", message: "m" });
    expect(pluginConfirmState.queue).toHaveLength(2);
    resolvePluginConfirm(pluginConfirmState.queue[0].id, false);
    await expect(mine).resolves.toBe("declined");
    // The other plugin's question is now the head, still pending.
    expect(pluginConfirmState.queue[0].pluginId).toBe("other");
    resolvePluginConfirm(pluginConfirmState.queue[0].id, true);
    await expect(theirs).resolves.toBe("accepted");
  });

  it("times out with its own result and drops the dialog", async () => {
    vi.useFakeTimers();
    const pending = ask({ timeoutMs: 5_000 });
    expect(pluginConfirmState.queue[0].expiresAt).toBeGreaterThan(0);
    vi.advanceTimersByTime(5_001);
    await expect(pending).resolves.toBe("timeout");
    expect(pluginConfirmState.queue).toHaveLength(0);
  });

  it("an answered request never fires its timeout afterwards", async () => {
    vi.useFakeTimers();
    const pending = ask({ timeoutMs: 5_000 });
    resolvePluginConfirm(pluginConfirmState.queue[0].id, true);
    vi.advanceTimersByTime(10_000);
    await expect(pending).resolves.toBe("accepted");
  });

  it("withdraws on abort, before or during", async () => {
    const controller = new AbortController();
    const pending = ask({ signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toBe("withdrawn");
    expect(pluginConfirmState.queue).toHaveLength(0);

    const already = new AbortController();
    already.abort();
    await expect(ask({ signal: already.signal })).resolves.toBe("withdrawn");
  });

  it("teardown withdraws pending questions rather than declining them", async () => {
    const pending = ask();
    clearPluginConfirms();
    await expect(pending).resolves.toBe("withdrawn");
  });

  it("clamps text and carries a host-verified peer name only", async () => {
    void requestPluginConfirm(plugin, {
      title: "t".repeat(300),
      message: "m".repeat(900),
      fromPeerName: "Bob",
    });
    const req = pluginConfirmState.queue[0];
    expect(req.title).toHaveLength(120);
    expect(req.message).toHaveLength(500);
    expect(req.fromPeerName).toBe("Bob");
  });
});
