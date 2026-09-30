import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const active = {
  id: "a", name: "World A", serverName: "WorldA", installPath: "/pz-server",
  zomboidDataPath: "/zomboid", dockerContainerName: "zomboid-game-a",
};
const peer = { ...active, id: "b", name: "World B", dockerContainerName: "zomboid-game-b" };
const getServers = vi.fn(async () => [active, peer]);
const getSetting = vi.fn(async (key) => key === "serverAutoUpdate" ? true : key === "steamcmdPath" ? "/tmp/unused-steamcmd" : null);
vi.mock("../database/init.ts", () => ({
  getCurrentServer: vi.fn(async () => active),
  getServer: vi.fn(async (id) => id === "a" ? active : peer),
  getServers: (...args) => getServers(...args),
  getSetting: (...args) => getSetting(...args),
  setSetting: vi.fn(async () => {}),
}));

const { UpdateChecker } = await import("../services/updateChecker.ts");
const { setDockerClient } = await import("../services/managedContainer.ts");
const previousKind = process.env.PANEL_DOCKER_INSTALL_KIND;
let tempDir = "";

afterEach(() => {
  setDockerClient(null);
  getServers.mockResolvedValue([active, peer]);
  getSetting.mockImplementation(async (key) => key === "serverAutoUpdate" ? true : key === "steamcmdPath" ? "/tmp/unused-steamcmd" : null);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
  if (previousKind === undefined) delete process.env.PANEL_DOCKER_INSTALL_KIND;
  else process.env.PANEL_DOCKER_INSTALL_KIND = previousKind;
});

describe("automatic PZ update in the split Docker stack", () => {
  it.skipIf(process.platform === "win32")("saves, stops, updates, then restarts only the selected game container", async () => {
    process.env.PANEL_DOCKER_INSTALL_KIND = "split";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-split-update-"));
    fs.writeFileSync(path.join(tempDir, "steamcmd.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    getSetting.mockImplementation(async (key) => key === "serverAutoUpdate" ? true : key === "steamcmdPath" ? tempDir : null);
    getServers.mockResolvedValue([active]);
    let running = true;
    const inspectManagedContainer = vi.fn(async () => ({ State: { Running: running } }));
    const runManagedAction = vi.fn(async (_name, action) => {
      running = action === "start";
      return { success: true };
    });
    setDockerClient({ enabled: true, available: true, inspectManagedContainer, runManagedAction });
    const save = vi.fn(async () => ({ success: true }));
    const quit = vi.fn(async () => ({ success: true }));
    const serverManager = { getServerProcessDetails: vi.fn(), startServer: vi.fn() };
    const checker = new UpdateChecker({ emit: vi.fn() }, {
      rconService: {
        connected: true,
        getPlayers: vi.fn(async () => ({ success: true, players: [] })),
        serverMessage: vi.fn(async () => ({ success: true })), save, quit,
      }, serverManager,
    });
    checker.getInstalledBuildInfo = vi.fn(async () => ({ buildId: "2", branch: "stable", lastUpdated: null }));

    await checker.runAutoUpdate({ installed: { branch: "stable", buildId: "1" } });

    expect(save).toHaveBeenCalledTimes(1);
    expect(runManagedAction.mock.calls.map((call) => call[1])).toEqual(["stop", "start"]);
    expect(running).toBe(true);
    expect(quit).not.toHaveBeenCalled();
    expect(serverManager.startServer).not.toHaveBeenCalled();
  });

  it("does not stop the active world or run SteamCMD while a peer uses the shared install", async () => {
    process.env.PANEL_DOCKER_INSTALL_KIND = "split";
    const inspectManagedContainer = vi.fn(async (name) => ({
      State: { Running: name === "zomboid-game-b" },
    }));
    const runManagedAction = vi.fn(async () => ({ success: true }));
    setDockerClient({ enabled: true, available: true, inspectManagedContainer, runManagedAction });
    const save = vi.fn(async () => ({ success: true }));
    const serverManager = { getServerProcessDetails: vi.fn(async () => ({ running: false })), startServer: vi.fn() };
    const checker = new UpdateChecker({ emit: vi.fn() }, {
      rconService: { connected: true, getPlayers: vi.fn(), serverMessage: vi.fn(), save, quit: vi.fn() },
      serverManager,
    });

    await expect(checker.runAutoUpdate({ installed: { branch: "stable", buildId: "1" } })).rejects.toThrow(/another server.*uses this game install/i);
    expect(save).not.toHaveBeenCalled();
    expect(runManagedAction).not.toHaveBeenCalled();
    expect(serverManager.getServerProcessDetails).not.toHaveBeenCalled();
  });
});
