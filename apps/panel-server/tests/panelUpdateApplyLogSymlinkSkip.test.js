import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// readMostRecentApplyLog()'s legacy os.tmpdir() fallback used fs.statSync
// (follows symlinks) with no check at all on files matched only by a
// predictable name pattern in the shared, world-writable system temp dir --
// a lower-privileged local user on a non-PrivateTmp host could plant a
// symlink named zomboid-panel-update-<n>.log pointing at any file the panel
// process can read, and any logged-in panel user could pull its content
// back through GET /api/panel/update-apply-log (CodeQL
// js/insecure-temporary-file #289). Nothing in the codebase still WRITES to
// that location (cleanupOldHelperArtifacts() only prunes it as pre-v1.0.21
// legacy cruft), so the fix removes the read fallback entirely rather than
// patching around it -- these tests pin that the class of bug is gone, not
// just its symlink variant.

const getSetting = vi.fn();
const setSetting = vi.fn();
vi.mock("../database/init.js", () => ({ getSetting, setSetting }));

// logger.js reads getDataPaths().logsDir at MODULE LOAD time (mkdirSync), so
// the mocked directory must already exist before panelUpdateChecker.js (and
// its logger.js import) is ever imported below -- not just by beforeEach.
// This runs after `fs`/`os`/`path` are bound (ESM imports resolve before any
// module body code) but before the dynamic import below triggers the mock
// factory, so it's ready in time despite `vi.mock` itself being hoisted.
const mockLogsDir = {
  dir: fs.mkdtempSync(path.join(os.tmpdir(), "panel-update-logsdir-")),
};
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ logsDir: mockLogsDir.dir, dataDir: mockLogsDir.dir }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

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
