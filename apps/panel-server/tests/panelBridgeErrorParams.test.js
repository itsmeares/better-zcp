import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


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

  describe("POST /command action=airdrop", () => {
    beforeEach(() => {
      bridge.bridgePath = "/fake/bridge/path";
      bridge.isRunning = true;
    });

    afterEach(() => {
      bridge.bridgePath = null;
      bridge.isRunning = false;
    });

    it("PANELBRIDGE_AIRDROP_INVALID_PRESET sends { presets } listing the valid set", async () => {
      const res = await runHandler("/command", "post", {
        body: { action: "airdrop", args: { x: 100, y: 100, preset: "not-a-real-preset" } },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.code).toBe("PANELBRIDGE_AIRDROP_INVALID_PRESET");
      expect(body.params.presets).toEqual(expect.any(String));
      expect(body.params.presets).toContain("military");
    });

    it("PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID sends the offending, truncated { itemType }", async () => {
      const badItemType = "not valid! ".repeat(10);
      const res = await runHandler("/command", "post", {
        body: {
          action: "airdrop",
          args: {
            x: 100,
            y: 100,
            preset: "military",
            items: [{ itemType: badItemType, count: 1 }],
          },
        },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "PANELBRIDGE_AIRDROP_ITEM_TYPE_INVALID",
          params: { itemType: badItemType.slice(0, 60) },
        }),
      );
    });
  });

  it("PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION (POST /character/import) sends { sections }", async () => {
    bridge.isRunning = true;
    try {
      const res = await runHandler("/character/import", "post", {
        body: { username: "TestPlayer", data: { notARecognizedSection: true } },
      });
      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.code).toBe("PANELBRIDGE_CHARACTER_DATA_NO_VALID_SECTION");
      expect(body.params.sections).toEqual(expect.any(String));
      expect(body.params.sections).toContain("inventory");
    } finally {
      bridge.isRunning = false;
    }
  });
});
