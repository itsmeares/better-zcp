import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand: vi.fn(async () => {}),
}));

const { getServer } = await import("../database/init.ts");
const { default: bridge } = await import("../services/panelBridge.ts");
const { default: router } = await import("../routes/panelBridge.ts");

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

async function runHandler(routePath, method, req) {
  const res = createResponse();
  await getHandler(routePath, method)(req, res, () => {});
  return res;
}

describe("panelBridge.js: previously-PARTIAL error codes now carry params on the wire", () => {
  it.each([
    'airdrop', 'getWeather', 'getVehiclesDetailed', 'getSafehouses',
    'exportPlayerData', 'spawnHordeNearPlayer',
  ])('rejects removed generic command %s', async (action) => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, 'sendCommand');
    try {
      const res = await runHandler('/command', 'post', {
        user: { role: 'admin' }, body: { action, args: {} },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(sendCommand).not.toHaveBeenCalled();
    } finally {
      sendCommand.mockRestore();
      bridge.isRunning = false;
    }
  });

  it("returns the action-required error for a missing command body", async () => {
    const res = await runHandler("/command", "post", { body: null });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "PANELBRIDGE_ACTION_REQUIRED" }),
    );
  });

  it("rejects a string godmode toggle instead of converting it to false", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
      success: true,
    });
    try {
      const res = await runHandler("/players/:username/godmode", "post", {
        params: { username: "TestPlayer" },
        body: { enabled: "false" },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(sendCommand).not.toHaveBeenCalled();
    } finally {
      sendCommand.mockRestore();
      bridge.isRunning = false;
    }
  });

  it("rejects a missing debug-mode toggle instead of disabling debug mode", async () => {
    bridge.isRunning = true;
    const sendCommand = vi.spyOn(bridge, "sendCommand").mockResolvedValue({
      success: true,
    });
    try {
      const res = await runHandler("/debug/mode", "post", { body: {} });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(sendCommand).not.toHaveBeenCalled();
    } finally {
      sendCommand.mockRestore();
      bridge.isRunning = false;
    }
  });

  it("PANELBRIDGE_SERVER_ID_NOT_FOUND (GET /scan-server/:serverId) sends { serverId }", async () => {
    getServer.mockReset().mockResolvedValue(null);
    const res = await runHandler("/scan-server/:serverId", "get", {
      params: { serverId: "no-such-server" },
    });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "PANELBRIDGE_SERVER_ID_NOT_FOUND",
        params: { serverId: "no-such-server" },
      }),
    );
  });


});
