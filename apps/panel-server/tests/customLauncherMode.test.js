import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveLaunchMode } from "../services/serverManager.ts";

const getActiveServer = vi.fn();
vi.mock("../database/init.ts", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { logSpy } = vi.hoisted(() => ({
  logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../utils/logger.ts", () => ({
  createLogger: () => logSpy,
}));

const { refreshLaunchTargetBeforeStart } = await import("../routes/server.ts");

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

    expect(scriptBackupWarnings).toEqual([]);
    expect(fs.readFileSync(launcherPath, "utf8")).toBe(
      "@echo off\r\nREM operator's own script\r\n",
    );
    const entries = fs.readdirSync(root);
    expect(entries).toEqual(["MyCustomLauncher.bat"]);

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
