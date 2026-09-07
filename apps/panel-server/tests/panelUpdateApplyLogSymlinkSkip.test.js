import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const getSetting = vi.fn();
const setSetting = vi.fn();
vi.mock("../database/init.js", () => ({ getSetting, setSetting }));

const mockLogsDir = {
  dir: fs.mkdtempSync(path.join(os.tmpdir(), "panel-update-logsdir-")),
};
vi.mock("../utils/paths.ts", () => ({
  getDataPaths: () => ({ logsDir: mockLogsDir.dir, dataDir: mockLogsDir.dir }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.ts");

describe("readMostRecentApplyLog(): logsDir fallbacks still work; the os.tmpdir() fallback is gone", () => {
  let sharedTmpDir;

  beforeEach(() => {
    getSetting.mockReset();
    setSetting.mockReset();
    fs.mkdirSync(mockLogsDir.dir, { recursive: true });
    for (const name of fs.readdirSync(mockLogsDir.dir)) {
      fs.rmSync(path.join(mockLogsDir.dir, name), { force: true });
    }
    sharedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-update-applylog-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(sharedTmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(sharedTmpDir, { recursive: true, force: true });
  });

  it("still reads supervisor.log from the panel's own logsDir", () => {
    fs.writeFileSync(path.join(mockLogsDir.dir, "supervisor.log"), "apply ok");
    const checker = new PanelUpdateChecker();
    expect(checker.readMostRecentApplyLog()).toBe("apply ok");
  });

  it("ignores a real, non-symlink matching file sitting in the shared system temp dir", () => {
    fs.writeFileSync(
      path.join(sharedTmpDir, "zomboid-panel-update-123.log"),
      "should never be read",
    );
    const checker = new PanelUpdateChecker();
    expect(checker.readMostRecentApplyLog()).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "ignores a symlinked entry in the shared system temp dir too",
    () => {
      const secret = path.join(sharedTmpDir, "..", "not-a-log-secret.txt");
      fs.writeFileSync(secret, "SECRET CONTENT");
      fs.symlinkSync(
        secret,
        path.join(sharedTmpDir, "zomboid-panel-update-999.log"),
      );

      const checker = new PanelUpdateChecker();
      expect(checker.readMostRecentApplyLog()).toBeNull();

      fs.rmSync(secret, { force: true });
    },
  );

  it("returns null when no matching file exists anywhere", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.readMostRecentApplyLog()).toBeNull();
  });
});
