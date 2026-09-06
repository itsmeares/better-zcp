import { afterEach, describe, expect, it, vi } from "vitest";

// 2026-08-30, panelbridge-total-audit-2026-08-30 (Finding B): chat/admin and
// chat/general both check `result?.data?.method !== "player:Say"` before
// accepting a PanelBridge response, falling back to RCON when the alert API
// silently degrades to per-player overhead text (handlers.sendToServerChat's
// own fallback: chat.server missing/failing -> Say() to each online player).
// chat/alert lacked that check -- it accepted any `result?.success`, so a
// degraded alert (no banner styling at all, visible only over players'
// heads) was returned to the caller as an ordinary successful alert, with
// RCON's honest fallback path never even tried.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function fakeApp(rconService) {
  return { get: (key) => (key === "rconService" ? rconService : undefined) };
}

describe("POST /panel-bridge/chat/alert -- a degraded player:Say response must not be accepted as a real alert", () => {
  afterEach(() => {
    bridge.isRunning = false;
    vi.restoreAllMocks();
  });

  it("falls back to RCON when PanelBridge degrades to player:Say, instead of returning the degraded response as success", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
      success: true,
      data: { message: "Message sent via player:Say (overhead text only)", isAlert: true, method: "player:Say" },
    });
    const serverMessage = vi.fn().mockResolvedValue({ success: true, response: "ok" });
    const rconService = { connected: true, serverMessage };

    const res = createResponse();
    await getHandler("/chat/alert", "post")(
      { body: { message: "Zombies incoming!", alert: true }, app: fakeApp(rconService) },
      res,
      () => {},
    );

    expect(sendCommand).toHaveBeenCalledWith("sendToServerChat", {
      message: "Zombies incoming!",
      alert: true,
    });
    // The bug this proves: pre-fix, a degraded player:Say result short-circuited
    // the route via `if (result?.success) return res.json(result)`, so RCON's
    // honest fallback was never consulted even though it was available.
    expect(serverMessage).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ isAlert: false, method: "RCON" }),
      }),
    );
  });

  it("still accepts a genuine ChatServer alert delivery unchanged (no regression to the non-degraded path)", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
      success: true,
      data: { message: "Message sent to server chat", isAlert: true, method: "ChatServer" },
    });
    const serverMessage = vi.fn();
    const rconService = { connected: true, serverMessage };

    const res = createResponse();
    await getHandler("/chat/alert", "post")(
      { body: { message: "Zombies incoming!", alert: true }, app: fakeApp(rconService) },
      res,
      () => {},
    );

    expect(serverMessage).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ method: "ChatServer" }),
      }),
    );
  });
});
