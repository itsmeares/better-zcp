import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-09-04, god's finding in Charon's real support bundle: zomboid-paths.json's
// listings.installLogs.path came back "...\StartServer_CharonWorld.bat\logs"
// (ENOENT) because "custom launcher" mode (operator ruling 2026-08-27,
// custom-launcher-as-a-real-supported-mode-not-an-accident) legitimately
// stores a .bat/.sh/.exe FILE path in activeServer.installPath, and
// buildZomboidPaths() joined "logs" straight onto it without checking.
// listings.install had the identical bug (listDir() on a file), just
// without its own ENOENT surfaced the same way in the one bundle god read.
// Tests the extracted pure function directly, matching how the other
// support-bundle collectors in this file are tested (real temp-directory
// fixtures, not mocked fs, so listDir()'s real fs.readdir/stat calls are
// genuinely exercised).

const { buildZomboidPaths } = await import("../routes/debug.js");

describe("zomboid-paths.json: listings.install / listings.installLogs resolve the actual install DIRECTORY", () => {
  let tempDir;

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("custom-launcher installPath (a .bat file): install/installLogs list the folder the script lives in, not a path joined onto the file", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-zomboidpaths-custom-"));
    const launcherPath = path.join(tempDir, "StartServer_CharonWorld.bat");
    fs.writeFileSync(launcherPath, "@echo off\r\n");
    const logsDir = path.join(tempDir, "logs");
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, "server-console.txt"), "hello");

    const result = await buildZomboidPaths({ installPath: launcherPath, zomboidDataPath: null });

    expect(result.listings.install.path).toBe(tempDir);
    expect(result.listings.install.error).toBeUndefined();
    expect(result.listings.installLogs.path).toBe(logsDir);
    expect(result.listings.installLogs.error).toBeUndefined();
    expect(result.listings.installLogs.entries.map((e) => e.name)).toContain(
      "server-console.txt",
    );
  });

  it("managed-mode installPath (already a directory): unchanged from before -- still lists installPath itself and installPath/logs", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-zomboidpaths-managed-"));
    const logsDir = path.join(tempDir, "logs");
    fs.mkdirSync(logsDir);
    fs.writeFileSync(path.join(logsDir, "server-console.txt"), "hello");

    const result = await buildZomboidPaths({ installPath: tempDir, zomboidDataPath: null });

    expect(result.listings.install.path).toBe(tempDir);
    expect(result.listings.installLogs.path).toBe(logsDir);
    expect(result.listings.installLogs.entries.map((e) => e.name)).toContain(
      "server-console.txt",
    );
  });

  it("no installPath at all: both stay null, same as before", async () => {
    const result = await buildZomboidPaths({ installPath: null, zomboidDataPath: null });

    expect(result.listings.install).toBeNull();
    expect(result.listings.installLogs).toBeNull();
  });

  it("custom-launcher installPath (a .sh script, Linux-shaped): the same fix applies to every launcher extension resolveLaunchMode() recognises, not just .bat", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-zomboidpaths-sh-"));
    const launcherPath = path.join(tempDir, "start-server.sh");
    fs.writeFileSync(launcherPath, "#!/bin/bash\n");
    const logsDir = path.join(tempDir, "logs");
    fs.mkdirSync(logsDir);

    const result = await buildZomboidPaths({ installPath: launcherPath, zomboidDataPath: null });

    expect(result.listings.install.path).toBe(tempDir);
    expect(result.listings.installLogs.path).toBe(logsDir);
  });
});
