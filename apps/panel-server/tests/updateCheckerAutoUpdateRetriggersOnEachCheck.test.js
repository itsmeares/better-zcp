import { afterEach, describe, expect, it, vi } from "vitest";


vi.mock("../services/managedContainer.ts", () => ({
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
    expect(checker.autoUpdateTimer).toBeNull();
    expect(checker.autoUpdateRunning).toBe(false);

    autoUpdateEnabled = true;
    const second = await checker.checkForUpdates();
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
    checker.autoUpdateTimer = null;
    checker.autoUpdateRunning = false;

    await checker.checkForUpdates();
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
