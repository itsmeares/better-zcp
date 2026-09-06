import { afterEach, describe, expect, it, vi } from "vitest";

// 2026-09-04, overnight bug hunt (Angela's fence: update*/panelUpdate*):
// scheduleAutoUpdate() used to be called only on the RISING EDGE of
// updateInfo.updateAvailable (checkForUpdates()'s own `if (!wasAvailable)`
// gate) -- the first check that finds an update transitioning false/null ->
// true. Once this.updateAvailable.updateAvailable is true, it stays true on
// every later periodic check until the installed build catches up (a
// completely separate, unrelated update-check outcome), so `wasAvailable`
// is permanently true for the whole rest of that update's lifetime. Two real
// consequences: (1) an operator who enables serverAutoUpdate AFTER an update
// was already detected while the setting was off gets nothing -- the panel
// already "saw" the update and will never reconsider scheduling it, only a
// NEWER build shipping (or a process restart, which resets updateAvailable
// to null in the constructor) would ever trigger it again; (2) a scheduled
// auto-update that FAILS (SteamCMD error, stop timeout, build didn't
// advance) never retries on the next periodic check either, for the exact
// same reason -- indistinguishable from auto-update being silently broken
// to an operator watching it fail once and never try again.
//
// Fix: checkForUpdates() now calls scheduleAutoUpdate() unconditionally
// whenever updateInfo.updateAvailable is true, decoupled from the socket
// notification's own `!wasAvailable || forceEmit` spam-control gate.
// scheduleAutoUpdate() is already its own re-entrancy guard
// (this.autoUpdateRunning || this.autoUpdateTimer, both correctly reset once
// a warning countdown or SteamCMD run finishes, success or failure) so this
// does not double-schedule or double-announce while one is already pending.

vi.mock("../services/managedContainer.js", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

let autoUpdateEnabled;
vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async (key) => {
    if (key === "serverAutoUpdate") return autoUpdateEnabled;
    if (key === "steamcmdPath") return "/opt/steamcmd";
    if (key === "serverPath") return "/opt/pzserver";
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({
    id: "server-1",
    installPath: "/opt/pzserver",
    isRemote: false,
  })),
}));

const { UpdateChecker } = await import("../services/updateChecker.js");

function buildChecker() {
  const io = { emit: vi.fn() };
  const rconService = { connected: false };
  const serverManager = {};
  const checker = new UpdateChecker(io, { rconService, serverManager });
  // Bypass real fs/steamcmd access entirely -- this test is about the
  // scheduling gate in checkForUpdates(), not build-info parsing (already
  // covered by updateCheckerBuildVerification.test.js).
  vi.spyOn(checker, "getInstalledBuildInfo").mockResolvedValue({
    buildId: "100",
    branch: "public",
    lastUpdated: null,
  });
  vi.spyOn(checker, "getGameVersion").mockResolvedValue(null);
  vi.spyOn(checker, "getLatestBuildInfo").mockResolvedValue({
    branch: "public",
    buildId: "200",
    timeUpdated: null,
    description: null,
  });
  return { checker, io };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UpdateChecker.checkForUpdates re-considers scheduling on every check while an update is outstanding", () => {
  it("schedules the pending update once the operator enables auto-update, without waiting for a newer build", async () => {
    autoUpdateEnabled = false;
    const { checker } = buildChecker();

    const first = await checker.checkForUpdates();
    expect(first.updateAvailable).toBe(true);
    // scheduleAutoUpdate() bailed on the disabled setting -- nothing armed.
    expect(checker.autoUpdateTimer).toBeNull();
    expect(checker.autoUpdateRunning).toBe(false);

    autoUpdateEnabled = true;
    const second = await checker.checkForUpdates();
    // Same outstanding update both times -- this is the exact case the old
    // `if (!wasAvailable) await this.scheduleAutoUpdate(...)` gate missed.
    expect(second.updateAvailable).toBe(true);
    expect(checker.autoUpdateTimer).not.toBeNull();

    clearTimeout(checker.autoUpdateTimer);
  });

  it("re-invokes scheduleAutoUpdate on every check while an update is outstanding, not just the first", async () => {
    autoUpdateEnabled = true;
    const { checker } = buildChecker();
    const scheduleSpy = vi.spyOn(checker, "scheduleAutoUpdate");

    await checker.checkForUpdates();
    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    clearTimeout(checker.autoUpdateTimer);
    // Simulate the warning countdown having already fired and the
    // subsequent SteamCMD run failing -- both guard flags reset, exactly
    // what runAutoUpdate()'s own `finally` block guarantees.
    checker.autoUpdateTimer = null;
    checker.autoUpdateRunning = false;

    await checker.checkForUpdates();
    // Still the same outstanding update (installed/latest build info are
    // stubbed identically) -- must be reconsidered, not skipped a second
    // time just because updateAvailable was already true.
    expect(scheduleSpy).toHaveBeenCalledTimes(2);
    clearTimeout(checker.autoUpdateTimer);
  });

  it("does not re-emit server:updateAvailable on the second check (notification spam control is unaffected by the scheduling fix)", async () => {
    autoUpdateEnabled = true;
    const { checker, io } = buildChecker();

    await checker.checkForUpdates();
    clearTimeout(checker.autoUpdateTimer);
    checker.autoUpdateTimer = null;
    checker.autoUpdateRunning = false;
    io.emit.mockClear();

    await checker.checkForUpdates(false);
    expect(io.emit).not.toHaveBeenCalledWith(
      "server:updateAvailable",
      expect.anything(),
    );
    clearTimeout(checker.autoUpdateTimer);
  });
});
