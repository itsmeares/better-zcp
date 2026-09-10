import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

const steamcmdPath = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-updatechecker-watchdog-"));
fs.writeFileSync(path.join(steamcmdPath, "steamcmd.sh"), "");
const installPath = path.join(os.tmpdir(), "zcp-watchdog-install");
const normalizedInstallPath = path.normalize(installPath).toLowerCase();

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async (key: string) => {
    if (key === "serverAutoUpdate") return true;
    if (key === "steamcmdPath") return steamcmdPath;
    return null;
  }),
  setSetting: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => ({ id: "server-1", installPath })),
}));

vi.mock("../services/managedContainer.ts", () => ({
  resolveManagedContainer: vi.fn(async () => ({ handled: false })),
}));

const { UpdateChecker } = await import("../services/updateChecker.ts");
const { clearActiveSteamOperation, getActiveSteamOperations } = await import(
  "../services/activeSteamOperations.ts"
);

afterEach(() => {
  vi.useRealTimers();
  clearActiveSteamOperation(normalizedInstallPath);
  spawnMock.mockReset();
});

describe("UpdateChecker unattended SteamCMD watchdog", () => {
  it("stops a SteamCMD process that produces no output for the idle timeout", async () => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00Z") });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
    spawnMock.mockReturnValue(child);

    const checker = new UpdateChecker(
      { emit: vi.fn() },
      {
        rconService: {
          connected: false,
          save: vi.fn(async () => ({ success: true })),
          quit: vi.fn(async () => ({ success: true })),
        },
        serverManager: {
          serverName: null,
          getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
          startServer: vi.fn(async () => ({ success: true })),
        },
      },
    );

    const update = expect(
      checker.runAutoUpdate({
        updateAvailable: true,
        installed: { branch: "stable", buildId: "1", lastUpdated: null },
        latest: { branch: "stable", buildId: "2", timeUpdated: null, description: null },
        lastCheck: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      autoUpdateReason: "STEAMCMD_STALLED",
      autoUpdateParams: { minutes: 10 },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 30_000);

    await update;
    expect(child.kill).toHaveBeenCalledOnce();
    expect(getActiveSteamOperations().has(normalizedInstallPath)).toBe(false);
  });
});
