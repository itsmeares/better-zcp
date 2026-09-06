import { describe, expect, it, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// Custom launcher paths point to a file, while diagnostics need the containing
// directory for install and log listings.

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
    const launcherPath = path.join(tempDir, "StartServer_TestWorld.bat");
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
