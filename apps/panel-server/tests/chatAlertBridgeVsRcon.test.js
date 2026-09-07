import { afterEach, describe, expect, it, vi } from "vitest";


vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
}));

const { default: bridge } = await import("../services/panelBridge.ts");
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

describe("POST /panel-bridge/chat/alert -- RCON has no alert styling, so it must not claim one", () => {
  afterEach(() => {
    bridge.isRunning = false;
    vi.restoreAllMocks();
  });

  it("prefers PanelBridge when an alert is actually requested and running -- RCON is never consulted", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
      success: true,
      data: { message: "Message sent to server chat", isAlert: true, method: "ChatServer" },
    });
    const serverMessage = vi.fn();
    const rconService = { connected: true, serverMessage };

    await getHandler("/chat/alert", "post")(
      { body: { message: "Zombies incoming!", alert: true }, app: fakeApp(rconService) },
      createResponse(),
      () => {},
    );

    expect(sendCommand).toHaveBeenCalledWith("sendToServerChat", {
      message: "Zombies incoming!",
      alert: true,
    });
    expect(serverMessage).not.toHaveBeenCalled();
  });

  it("falls back to RCON honestly when PanelBridge is unavailable -- isAlert must be false, never echo the request back unverified", async () => {
    bridge.isRunning = false;
    const serverMessage = vi.fn().mockResolvedValue({ success: true, response: "ok" });
    const rconService = { connected: true, serverMessage };

    const res = createResponse();
    await getHandler("/chat/alert", "post")(
      { body: { message: "Zombies incoming!", alert: true }, app: fakeApp(rconService) },
      res,
      () => {},
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ isAlert: false, method: "RCON" }),
      }),
    );
  });

  it("non-alert messages are unaffected -- RCON-first behaviour is unchanged when alert is not requested", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand");
    const serverMessage = vi.fn().mockResolvedValue({ success: true, response: "ok" });
    const rconService = { connected: true, serverMessage };

    const res = createResponse();
    await getHandler("/chat/alert", "post")(
      { body: { message: "just a note", alert: false }, app: fakeApp(rconService) },
      res,
      () => {},
    );

    expect(serverMessage).toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isAlert: false, method: "RCON" }) }),
    );
  });
});
