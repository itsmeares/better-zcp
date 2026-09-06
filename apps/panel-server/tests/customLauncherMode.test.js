import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveLaunchMode } from "../services/serverManager.js";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

// regenerateStartupScriptsWithBackup() swallows every filesystem error it
// can hit (ENOTDIR included -- see server.js's own try/catch around each
// write) and returns [] either way, so asserting on the filesystem alone
// cannot tell "never attempted a write, mode-aware" apart from "attempted
// and every write silently failed" -- both produce zero artifacts. The log
// line is the one real observable difference between the two, so it's
// mocked and asserted on rather than treated as incidental.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/logger.js", () => ({
  createLogger: () => logSpy,
}));

const { refreshLaunchTargetBeforeStart } = await import("../routes/server.js");

// Operator ruling 2026-08-27 (card custom-launcher-as-a-real-supported-mode-
// not-an-accident): a serverPath/installPath ending in .bat/.sh/.exe is a
// real, supported CUSTOM LAUNCHER mode, not an accident to guess at or an
// error to reject. resolveLaunchMode() (serverManager.js) is the ONE
// predicate every caller asks -- loadConfig() (to resolve serverBat),
// refreshLaunchTargetBeforeStart() below (to decide whether to regenerate),
// and servers.js's PUT/POST validation (serverPathValidation.test.js). This
// pins the predicate's own contract and refreshLaunchTargetBeforeStart's use
// of it; loadConfig()'s use of it is unchanged behavior already covered by
// serverManager.test.js/serverManagerLegacyServerNameGuard.test.js.
describe("resolveLaunchMode()", () => {
  it("a directory-shaped installPath is MANAGED", () => {
    expect(resolveLaunchMode({ installPath: "D:\\PZServer" })).toEqual({
      mode: "managed",
      launcherPath: null,
    });
  });

  it("an installPath ending in .bat/.sh/.exe is CUSTOM, case-insensitively", () => {
    for (const ext of [".bat", ".BAT", ".sh", ".Sh", ".exe", ".EXE"]) {
      const launcherPath = `D:\\PZServer\\launch${ext}`;
      expect(resolveLaunchMode({ installPath: launcherPath })).toEqual({
        mode: "custom",
        launcherPath,
      });
    }
  });

  it("serverPath wins over installPath when both are set", () => {
    const result = resolveLaunchMode({
      installPath: "D:\\PZServer",
      serverPath: "D:\\PZServer\\custom.sh",
    });
    expect(result).toEqual({ mode: "custom", launcherPath: "D:\\PZServer\\custom.sh" });
  });

  it("no server, or neither field set, is MANAGED (the safe default)", () => {
    expect(resolveLaunchMode(null)).toEqual({ mode: "managed", launcherPath: null });
    expect(resolveLaunchMode({})).toEqual({ mode: "managed", launcherPath: null });
    expect(resolveLaunchMode({ installPath: "" })).toEqual({
      mode: "managed",
      launcherPath: null,
    });
  });

  it("a file with an unrecognized extension is NOT custom -- it's a validation problem for servers.js, not a launch mode", () => {
    expect(resolveLaunchMode({ installPath: "D:\\PZServer\\readme.txt" })).toEqual({
      mode: "managed",
      launcherPath: null,
    });
  });
});

describe("refreshLaunchTargetBeforeStart() in CUSTOM LAUNCHER mode", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    getActiveServer.mockReset();
    logSpy.info.mockReset();
    logSpy.warn.mockReset();
  });

  it("does not attempt to write a launch script at all -- no broken nested path, no silent no-op", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-custom-launcher-"));
    const launcherPath = path.join(root, "MyCustomLauncher.bat");
    fs.writeFileSync(launcherPath, "@echo off\r\nREM operator's own script\r\n", "utf8");

    const server = {
      serverName: "TestServer",
      installPath: launcherPath,
      zomboidDataPath: path.join(root, "ZomboidData"),
      rconPassword: "secret123",
      rconPort: 27015,
    };

    const { scriptBackupWarnings } = await refreshLaunchTargetBeforeStart(server);

    // No backup/regeneration warnings -- the write was never attempted.
    expect(scriptBackupWarnings).toEqual([]);
    // The operator's own file is untouched, byte for byte.
    expect(fs.readFileSync(launcherPath, "utf8")).toBe(
      "@echo off\r\nREM operator's own script\r\n",
    );
    // Nothing else got created in the directory (no orphaned
    // StartServer_TestServer.bat, no broken nested-path artifact).
    const entries = fs.readdirSync(root);
    expect(entries).toEqual(["MyCustomLauncher.bat"]);

    // The real distinguishing signal: regenerateStartupScriptsWithBackup()
    // catches every filesystem error it can hit and returns [] either way,
    // so the assertions above alone can't tell "never attempted, mode-aware"
    // apart from "attempted against a broken nested path and every write
    // silently failed" -- the pre-fix behavior for exactly this scenario.
    // The log line is what actually differs.
    const allMessages = [...logSpy.info.mock.calls, ...logSpy.warn.mock.calls].map(
      (call) => call[0],
    );
    expect(allMessages.some((m) => /custom launcher mode/i.test(m))).toBe(true);
    expect(allMessages.some((m) => /regenerated startup scripts/i.test(m))).toBe(
      false,
    );
    expect(
      allMessages.some((m) => /could not regenerate startup scripts/i.test(m)),
    ).toBe(false);
  });
});
