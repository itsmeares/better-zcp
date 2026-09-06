import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


process.pkg = {};

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("preflight() surfaces an unknown free-disk-space result instead of staying silent", () => {
  let scratchDir;
  let fakeExePath;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker() {
    const checker = new PanelUpdateChecker();
    const assetName =
      process.platform === "win32"
        ? "ZomboidControlPanel.exe"
        : "ZomboidControlPanel";
    checker.latestRelease = {
      version: "9.9.9",
      assets: [{ name: assetName, size: 1024 }],
    };
    checker.updateAvailable = true;
    return checker;
  }

  function unknownWarning(result) {
    return result.warningDetails.find(
      (w) => w.key === "updates.preflight.diskSpaceUnknown",
    );
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
    vi.restoreAllMocks();
  });

  it("warns when getFreeDiskSpace resolves to null", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockResolvedValue(null);

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeDefined();
    expect(result.info.freeBytes).toBeNull();
    expect(result.blockerDetails.some((b) => b.key === "updates.preflight.diskSpace")).toBe(false);
  });

  it("warns when getFreeDiskSpace throws", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockRejectedValue(new Error("statfs exploded"));

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeDefined();
    expect(result.info.freeBytes).toBeNull();
  });

  it("stays silent on disk space when a real, sufficient value is available", async () => {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-disk-"));
    fakeExePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(fakeExePath, "fake-exe");
    setExecPath(fakeExePath);

    const checker = makeChecker();
    vi.spyOn(checker, "getFreeDiskSpace").mockResolvedValue(1024 * 1024 * 1024 * 10);

    const result = await checker.preflight();
    expect(unknownWarning(result)).toBeUndefined();
    expect(result.info.freeBytes).toBe(1024 * 1024 * 1024 * 10);
  });
});
