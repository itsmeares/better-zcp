import { describe, expect, it, vi } from "vitest";
import { PanelBridge } from "../services/panelBridge.ts";

const leakyStatus = {
  alive: true,
  serverName: "Test Server",
  players: ["PlayerOne"],
  path: "/srv/zomboid/Lua/panelbridge/Test Server",
  filePath: "/var/lib/panel/bridge/status.json",
  stats: { processed: 10 },
};

function buildBridge(modStatus = leakyStatus) {
  const bridge = new PanelBridge();
  bridge.isRunning = true;
  bridge.modStatus = modStatus;
  return bridge;
}

describe("PanelBridge.ping() returns an allow-listed mod status", () => {
  it("keeps player names and filesystem paths out of the response", async () => {
    const bridge = buildBridge();
    bridge.sendCommand = vi.fn().mockResolvedValue({ success: true });

    const result = await bridge.ping();

    expect(result.modStatus).toEqual({ serverName: "Test Server" });
    expect(result.modStatus).not.toHaveProperty("players");
    expect(result.modStatus).not.toHaveProperty("path");
    expect(result.modStatus).not.toHaveProperty("filePath");
    expect(bridge.modStatus).toBe(leakyStatus);
  });

  it("also narrows the mod-not-connected response", async () => {
    const bridge = buildBridge({ ...leakyStatus, alive: false });

    const result = await bridge.ping();

    expect(result.modStatus).toEqual({ serverName: "Test Server" });
  });

  it("returns a stable empty view before the first status file", async () => {
    const bridge = buildBridge(null);

    const result = await bridge.ping();

    expect(result.modStatus).toEqual({ serverName: null });
  });
});
