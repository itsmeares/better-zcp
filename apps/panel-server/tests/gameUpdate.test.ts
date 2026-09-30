import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../database/init.ts";
import { runForServer } from "../utils/serverScope.ts";
import { setPanelRuntime, setServerRuntime, removeServerRuntime } from "../utils/panelRuntime.ts";
import { ServerMaintenance } from "../services/serverMaintenance.ts";
import { UpdateChecker } from "../services/updateChecker.ts";
import { steamInstallKey, getActiveSteamOperations } from "../services/activeSteamOperations.ts";
let directory: string | undefined;
const runtimes: string[] = [];
afterEach(() => { for (const id of runtimes.splice(0)) removeServerRuntime(id); getActiveSteamOperations().clear(); if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
async function fixture(exit = 0) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-game-update-"));
  const install = path.join(directory, "Game"), steamcmd = path.join(directory, "Steam"), data = path.join(directory, "Zomboid");
  fs.mkdirSync(path.join(install, "steamapps"), { recursive: true }); fs.mkdirSync(steamcmd);
  fs.mkdirSync(path.join(data, "Saves", "Multiplayer", "Fixture"), { recursive: true });
  const manifest = path.join(install, "steamapps", "appmanifest_380870.acf");
  fs.writeFileSync(manifest, '"buildid" "100"\n"BetaKey" "public"');
  const exe = path.join(steamcmd, process.platform === "win32" ? "steamcmd.exe" : "steamcmd.sh");
  fs.writeFileSync(exe, `#!/bin/sh\nprintf '"buildid" "200"\\n"BetaKey" "public"' > "$2/steamapps/appmanifest_380870.acf"\nprintf "Success! App '380870' fully installed.\\n"\nexit ${exit}\n`, { mode: 0o755 });
  const server = await createServer({ serverName: "Fixture", installPath: install, zomboidDataPath: data, startCommand: "fixture-only", rconPassword: "fixture" });
  let running = true; const actions: string[] = [];
  const io = { emit: vi.fn() };
  const rcon = { connected: true, getPlayers: async () => ({ success: true, players: [] }), save: async () => { actions.push("save"); return { success: true }; },
    quit: async () => { actions.push("stop"); running = false; rcon.connected = false; return { success: true }; },
    setServerStarting: vi.fn(), connect: async () => { rcon.connected = true; },
  };
  const manager = { getServerProcessDetails: async () => ({ running, scanFailed: false }), usesManagedServiceLifecycle: () => false,
    startServer: async () => { expect(getActiveSteamOperations().has(steamInstallKey(install))).toBe(false); actions.push("start"); running = true; return { success: true }; },
  };
  const maintenance = new ServerMaintenance(server.id, rcon, manager, io);
  const checker = new UpdateChecker(io, { rconService: rcon as any, serverManager: manager, maintenance });
  setPanelRuntime({}); setServerRuntime(server.id, { maintenance }); runtimes.push(server.id);
  return { server, checker, io, actions, maintenance, manager, install, steamcmd, isRunning: () => running };
}
describe("user initiated game update", () => {
  it("refuses unknown or running peers sharing the install before saving or stopping its own game", async () => {
    const f = await fixture(); const peer = await createServer({ serverName: "Peer", installPath: f.install });
    await runForServer(f.server.id, async () => {
      await expect(f.checker.beginUpdate({ steamcmdPath: f.steamcmd })).rejects.toThrow("Stop Peer");
      expect(f.actions).toEqual([]); expect(getActiveSteamOperations().size).toBe(0);
      setServerRuntime(peer.id, { maintenance: { state: async () => ({ running: true }) } }); runtimes.push(peer.id);
      await expect(f.checker.beginUpdate({ steamcmdPath: f.steamcmd })).rejects.toThrow("Stop Peer");
      expect(f.actions).toEqual([]);
    });
  });
  it("rejects a different installation and unsupported branch", async () => {
    const f = await fixture(); await runForServer(f.server.id, async () => {
      await expect(f.checker.beginUpdate({ installPath: f.steamcmd })).rejects.toThrow("does not match");
      await expect(f.checker.beginUpdate({ steamcmdPath: f.steamcmd, branch: "41.78.16" })).rejects.toThrow("Build 42");
      expect(f.actions).toEqual([]);
    });
  });
  it.skipIf(process.platform === "win32")("runs the real SteamCMD child while stopped, verifies its manifest and restarts only on success", async () => {
    for (const exit of [0, 1]) {
      const f = await fixture(exit);
      await runForServer(f.server.id, async () => {
        expect((await f.checker.beginUpdate({ steamcmdPath: f.steamcmd })).success).toBe(true);
        await vi.waitFor(() => expect(f.checker.updating).toBe(false));
        expect(f.checker.lastUpdateResult?.success).toBe(exit === 0);
        expect(f.actions).toEqual(exit === 0 ? ["save", "stop", "start"] : ["save", "stop"]);
        expect(f.isRunning()).toBe(exit === 0); expect(getActiveSteamOperations().has(steamInstallKey(f.install))).toBe(false);
      });
      fs.rmSync(directory!, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")("cancellation kills SteamCMD's own child tree before releasing its install", async () => {
    const f = await fixture(), exe = path.join(f.steamcmd, "steamcmd.sh"), marker = path.join(f.steamcmd, "child-wrote");
    fs.writeFileSync(exe, '#!/bin/sh\n(sleep 0.3; touch child-wrote) &\necho ready\nwait\n', { mode: 0o755 });
    const controller = new AbortController(), key = steamInstallKey(f.install);
    getActiveSteamOperations().set(key, { type: "update", startTime: Date.now(), lastOutputAt: Date.now() });
    const run = (f.checker as any).runSteamCmd(exe, f.steamcmd, [], key, controller.signal);
    await vi.waitFor(() => expect(f.io.emit).toHaveBeenCalledWith("steam:log", expect.objectContaining({ text: expect.stringContaining("ready") })));
    controller.abort(); await expect(run).rejects.toThrow("cancelled");
    await new Promise(resolve => setTimeout(resolve, 400)); expect(fs.existsSync(marker)).toBe(false);
  });

});
