import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const describeWindowsOnly = process.platform === "win32" ? describe : describe.skip;

async function freshPathsModule() {
  vi.resetModules();
  return import("../utils/paths.ts");
}

function setExecPath(p) {
  Object.defineProperty(process, "execPath", { value: p, configurable: true });
}

describeWindowsOnly("Windows Program Files ownership trap (getDataPaths)", () => {
  let originalExecPath;
  let originalPathsConfigEnv;
  let tmpRoot;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalExecPath) setExecPath(originalExecPath);
    if (originalPathsConfigEnv === undefined) {
      delete process.env.PANEL_PATHS_CONFIG_PATH;
    } else {
      process.env.PANEL_PATHS_CONFIG_PATH = originalPathsConfigEnv;
    }
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  });

  it("control: a genuinely writable install directory creates data/logs normally", async () => {
    originalExecPath = process.execPath;
    originalPathsConfigEnv = process.env.PANEL_PATHS_CONFIG_PATH;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-winpaths-"));
    process.env.PANEL_PATHS_CONFIG_PATH = path.join(tmpRoot, "paths.config.json");
    process.pkg = {};
    setExecPath(path.join(tmpRoot, "ZomboidControlPanel.exe"));

    const { getDataPaths } = await freshPathsModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});

    const result = getDataPaths();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(result.dataDir)).toBe(true);
    expect(fs.existsSync(result.logsDir)).toBe(true);
  });

  it("a real, unmocked EPERM against a Program-Files-shaped path exits 77 with a named cause instead of an uncaught crash", async () => {
    originalExecPath = process.execPath;
    originalPathsConfigEnv = process.env.PANEL_PATHS_CONFIG_PATH;
    process.pkg = {};
    const target = path.join(
      "C:\\Program Files",
      `zcp-ownership-trap-test-${process.pid}-${Date.now()}`,
    );
    setExecPath(path.join(target, "ZomboidControlPanel.exe"));
    process.env.PANEL_PATHS_CONFIG_PATH = path.join(target, "paths.config.json");

    const { getDataPaths } = await freshPathsModule();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => getDataPaths()).toThrow(/EPERM|EACCES/);

    expect(exitSpy).toHaveBeenCalledWith(77);
    const message = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(message).toMatch(/Program Files/i);
    expect(message).toMatch(/Run as administrator/i);
    expect(message).toContain(target);
  });
});
