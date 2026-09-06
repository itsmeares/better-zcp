import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 2026-09-04, Dwight's finding: this preflight probe checked for a
// ".old" backup file, a suffix nothing has written since the bundle-journal
// rewrite renamed it to ".bundle-previous" (see updateBundle.js's
// backupBinaryPath and scripts/release/build.mjs's BIN_BACKUP). The check could therefore
// never fire for the current mechanism -- silence here read as "nothing
// lingering" while the actual current risk (a .bundle-previous a failed or
// incomplete rollback left behind, exactly the class of bug fixed in
// acb202b1) went completely unchecked.

// preflight() early-returns before this probe unless the process looks
// packaged -- match the real runtime condition, not just the file's own
// isolated logic, the same way every other preflight()-calling test here does.
process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("preflight() detects a lingering backup from a prior apply", () => {
  let scratchDir;
  let fakeExePath;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker() {
    const checker = new PanelUpdateChecker();
    checker.latestRelease = { version: "9.9.9", assets: [] };
    checker.updateAvailable = true;
    return checker;
  }

  function backupWarning(result) {
    return result.warningDetails.find(
      (w) => w.key === "updates.preflight.previousBackup",
    );
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
  });

  it("does not warn when nothing is left behind", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-backup-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const result = await makeChecker().preflight();
    expect(backupWarning(result)).toBeUndefined();
    expect(result.info.oldPath).toBeUndefined();
  });

  it("warns on a lingering .bundle-previous -- the CURRENT mechanism's backup suffix", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-backup-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    fs.writeFileSync(`${fakeExePath}.bundle-previous`, "leftover");
    setExecPath(fakeExePath);

    const result = await makeChecker().preflight();
    expect(backupWarning(result)).toBeDefined();
    expect(result.info.oldPath).toBe(`${fakeExePath}.bundle-previous`);
  });

  it("still warns on a lingering legacy .old, for an install that never applied since the rename", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-backup-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    fs.writeFileSync(`${fakeExePath}.old`, "ancient leftover");
    setExecPath(fakeExePath);

    const result = await makeChecker().preflight();
    expect(backupWarning(result)).toBeDefined();
    expect(result.info.oldPath).toBe(`${fakeExePath}.old`);
  });
});
