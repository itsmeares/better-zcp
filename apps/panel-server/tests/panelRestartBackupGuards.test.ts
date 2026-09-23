import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";

const events = vi.hoisted(() => []);

vi.mock("../database/init.ts", () => ({
  getDatabaseFilePath: () => "/unused/db.json",
  setSetting: vi.fn(async (key) => { events.push(key); }),
  flushWrites: vi.fn(async () => {}),
  logServerEvent: vi.fn(),
}));
vi.mock("../utils/paths.ts", () => ({ getDataPaths: () => ({ dataDir: "/unused" }) }));
vi.mock("../services/panelUpdateChecker.ts", () => ({
  createUpdateDataBackup: vi.fn(() => {
    events.push("backup");
    return "/unused/pre-update.json";
  }),
}));
vi.mock("../services/updateBundle.ts", () => ({
  applyUpdateBundle: vi.fn(() => ({ paths: { binary: "/unused/binary" } })),
  recoverInterruptedUpdateBundle: vi.fn(),
}));
vi.mock("../utils/restartSupervisor.ts", () => ({ isLinuxPanelSupervisor: () => false }));

const { handlePanelRestart } = await import("../http/panelUpdateHandlers.ts");
const { createUpdateDataBackup } = await import("../services/panelUpdateChecker.ts");
const { setSetting } = await import("../database/init.ts");

function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

async function restart(checker) {
  const res = response();
  await handlePanelRestart({ app: { get: () => checker } }, res);
  return res;
}

describe("packaged panel restart backup guards", () => {
  let originalPlatform;
  let originalPkg;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    originalPkg = Object.getOwnPropertyDescriptor(process, "pkg");
    Object.defineProperty(process, "pkg", { configurable: true, value: {} });
    vi.useFakeTimers();
    events.length = 0;
    vi.clearAllMocks();
    vi.spyOn(fs.promises, "chmod").mockResolvedValue(undefined);
    vi.spyOn(fs.promises, "access").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", originalPlatform);
    if (originalPkg) Object.defineProperty(process, "pkg", originalPkg);
    else delete process.pkg;
  });

  function setPlatform(platform) {
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
  }

  function stagedChecker(overrides = {}) {
    return {
      getStagedUpdate: () => ({ version: "2.0.0", journalPath: "/unused/journal" }),
      isSupervisorAvailable: () => true,
      isApplying: false,
      writeSupervisorMarker: vi.fn(),
      ...overrides,
    };
  }

  it("rejects a Windows update without its supervisor without touching the backup", async () => {
    setPlatform("win32");
    const res = await restart(stagedChecker({ isSupervisorAvailable: () => false }));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(createUpdateDataBackup).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("rejects an in-progress %s update without overwriting the backup", async (platform) => {
    setPlatform(platform);
    const res = await restart(stagedChecker({ isApplying: true }));
    expect(res.status).toHaveBeenCalledWith(409);
    expect(createUpdateDataBackup).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(["win32", "linux"])("backs up an accepted %s update before recording the pending version", async (platform) => {
    setPlatform(platform);
    const res = await restart(stagedChecker());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(events).toEqual(["backup", "preUpdateDataBackupPath", "pendingPanelUpdate"]);
  });
});
