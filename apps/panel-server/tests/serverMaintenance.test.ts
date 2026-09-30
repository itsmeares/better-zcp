import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { runForServer } from "../utils/serverScope.ts";
const profile = { id: "maintenance-game", serverName: "fixture", lifecycleProvider: "native" };
vi.mock("../database/init.ts", () => ({ getServer: vi.fn(async () => profile) }));
vi.mock("../services/managedContainer.ts", () => ({
  resolveDockerHostSignal: vi.fn(async () => ({ running: false, scanFailed: true })),
  runManagedLifecycle: vi.fn(async () => ({ handled: false })),
  isBundledGameProfile: vi.fn(() => false), ensureBundledGameContainer: vi.fn(),
}));
const { ensureGameIntegrationInstalled } = vi.hoisted(() => ({
  ensureGameIntegrationInstalled: vi.fn(),
}));
vi.mock("../services/gameIntegrationInstaller.ts", () => ({ ensureGameIntegrationInstalled }));
vi.mock("../services/serverLaunch.ts", () => ({ candidateIniPaths: vi.fn(() => []), isFirstBootMissingAdminPassword: vi.fn(() => false), refreshLaunchTargetBeforeStart: vi.fn(async () => {}) }));
vi.mock("../utils/panelRuntime.ts", () => ({ getPanelRuntime: () => ({}) }));
const { ServerMaintenance } = await import("../services/serverMaintenance.ts");
function fixture(running = true) {
  let active = running;
  const rcon = {
    connected: running, getPlayers: vi.fn(async () => ({ success: true, players: [] as string[] })),
    save: vi.fn(async () => ({ success: true })), quit: vi.fn(async () => { active = false; rcon.connected = false; return { success: true }; }),
    setServerStarting: vi.fn(), connect: vi.fn(async () => {}), serverMessage: vi.fn(async () => ({ success: true })),
  };
  const manager = { getServerProcessDetails: vi.fn(async () => ({ running: active, scanFailed: false })),
    usesManagedServiceLifecycle: () => false, markServerStopped: vi.fn(),
    startServer: vi.fn(async () => { active = true; return { success: true }; }),
  };
  const maintenance = new ServerMaintenance(profile.id, rcon, manager, { emit: vi.fn() });
  return { maintenance, rcon, manager };
}
afterEach(() => {
  vi.restoreAllMocks();
  ensureGameIntegrationInstalled.mockReset();
});
describe("server maintenance", () => {
  it("saves, verifies stopped, does the work and resumes a running game even if a backup fails", async () => {
    const { maintenance, rcon, manager } = fixture();
    const work = vi.fn(async () => { expect((await maintenance.state()).running).toBe(false); return { success: false, message: "Disk full" }; });
    const result = await maintenance.run({ kind: "backup", label: "Full backup", automatic: true, work });
    expect(result.success).toBe(false); expect(rcon.save).toHaveBeenCalledOnce(); expect(work).toHaveBeenCalledOnce(); expect(ensureGameIntegrationInstalled).toHaveBeenCalledOnce(); expect(manager.startServer).toHaveBeenCalledOnce();
  });
  it("leaves a partially updated game stopped", async () => {
    const { maintenance, manager } = fixture();
    const result = await maintenance.run({ kind: "pz-update", label: "Update", work: async () => { throw new Error("SteamCMD failed"); } });
    expect(result.success).toBe(false); expect(manager.startServer).not.toHaveBeenCalled();
  });
  it("does not stop or run work when players cannot be verified or the save fails", async () => {
    for (const failure of ["players", "save", "state"]) {
      const { maintenance, rcon, manager } = fixture(); const work = vi.fn();
      if (failure === "players") rcon.getPlayers.mockResolvedValue({ success: false, players: [] });
      if (failure === "save") rcon.save.mockResolvedValue({ success: false });
      if (failure === "state") manager.getServerProcessDetails.mockResolvedValue({ running: false, scanFailed: true });
      expect((await maintenance.run({ kind: "backup", label: "Backup", automatic: true, work })).success).toBe(false);
      expect(rcon.quit).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled(); expect(manager.startServer).not.toHaveBeenCalled();
    }
  });
  it("defers if a player query completes after the waiting window, even when it returns empty", async () => {
    const { maintenance, rcon } = fixture(); let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    rcon.getPlayers.mockImplementation(async () => { clock = 60001; return { success: true, players: [] }; });
    const result = await maintenance.run({ kind: "restart", label: "Restart", automatic: true, policy: { waitMinutes: 1, forceAfterDeadline: false, warningMinutes: 1 } });
    expect(result.deferred).toBe(true); expect(rcon.quit).not.toHaveBeenCalled();
  });
  it("only cancels before stopping and rejects concurrent maintenance", async () => {
    const { maintenance, rcon } = fixture(); rcon.getPlayers.mockResolvedValue({ success: true, players: ["alice"] });
    const pending = maintenance.run({ kind: "backup", label: "Backup", automatic: true });
    expect((await maintenance.run({ kind: "restart", label: "Restart" })).deferred).toBe(true);
    expect(maintenance.cancel()).toBe(true); expect((await pending).cancelled).toBe(true); expect(rcon.quit).not.toHaveBeenCalled();
    expect(maintenance.active).toBeNull();
  });
  it("does not start a stopped game after automatic Workshop maintenance or a stopped backup", async () => {
    for (const kind of ["workshop", "backup"] as const) {
      const { maintenance, manager } = fixture(false);
      expect((await runForServer(profile.id, () => maintenance.run({ kind, label: "Maintenance", automatic: true }))).success).toBe(true);
      expect(manager.startServer).not.toHaveBeenCalled();
    }
  });
  it("keeps an occupied server running if its forced deadline warning cannot be delivered", async () => {
    const { maintenance, rcon } = fixture();
    rcon.getPlayers.mockResolvedValue({ success: true, players: ["alice"] });
    rcon.serverMessage.mockResolvedValue({ success: false });
    const result = await maintenance.run({ kind: "restart", label: "Restart", automatic: true, policy: { waitMinutes: 1, warningMinutes: 1, forceAfterDeadline: true } });
    expect(result.success).toBe(false); expect(result.message).toContain("could not be warned"); expect(rcon.quit).not.toHaveBeenCalled();
  });

  it("requires a known player count for manual backups too and preserves the game if its config backup fails", async () => {
    for (const failure of ["players", "config"]) {
      const { maintenance, rcon } = fixture();
      if (failure === "players") rcon.getPlayers.mockResolvedValue({ success: false, players: [] });
      else vi.spyOn(maintenance as any, "backupConfig").mockRejectedValue(new Error("Config backup failed"));
      expect((await maintenance.run({ kind: "backup", label: "Backup" })).success).toBe(false);
      expect(rcon.quit).not.toHaveBeenCalled();
    }
  });
  it("uses Docker host state and refuses an unknown container instead of the panel's local process scan", async () => {
    const { getServer } = await import("../database/init.ts");
    const { resolveDockerHostSignal } = await import("../services/managedContainer.ts");
    const { maintenance, manager } = fixture(false);
    vi.mocked(getServer).mockResolvedValue({ ...profile, dockerContainerName: "fixture-container" } as any);
    try {
      vi.mocked(resolveDockerHostSignal).mockResolvedValueOnce({ running: true, scanFailed: false });
      expect(await maintenance.state()).toEqual({ running: true });
      await expect(maintenance.state()).rejects.toThrow("could not be verified");
      expect(manager.getServerProcessDetails).not.toHaveBeenCalled();
    } finally { vi.mocked(getServer).mockResolvedValue(profile as any); }
  });

});
