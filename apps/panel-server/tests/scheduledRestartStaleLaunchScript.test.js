import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { generateStartupScripts, regenerateStartupScriptsWithBackup, refreshLaunchTargetBeforeStart } =
  await import("../routes/server.js");

describe("a Settings-UI config change now reaches the script a scheduled restart will use", () => {
  let tmpRoot;

  afterEach(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("changing zomboidDataPath, then a scheduled-restart-style refresh (no manual start), picks up the NEW path -- the stale-script window is closed", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-stale-launch-"));
    const oldDataPath = path.join(tmpRoot, "ZomboidData_old");
    const newDataPath = path.join(tmpRoot, "ZomboidData_new");

    const baseServer = {
      installPath: tmpRoot,
      serverName: "TestServer",
      serverPort: 16261,
      adminPassword: "",
    };

    const v1 = generateStartupScripts({
      ...baseServer,
      zomboidDataPath: oldDataPath,
    });
    const batPath = path.join(tmpRoot, "StartServer_TestServer.bat");
    const shPath = path.join(tmpRoot, "start-server_TestServer.sh");
    regenerateStartupScriptsWithBackup(tmpRoot, [
      { path: batPath, content: v1.bat },
      { path: shPath, content: v1.sh.replace(/\r\n/g, "\n") },
    ]);
    expect(fs.readFileSync(batPath, "utf8")).toContain(
      `-cachedir="${oldDataPath}"`,
    );

    const updatedServer = { ...baseServer, zomboidDataPath: newDataPath };

    await refreshLaunchTargetBeforeStart(updatedServer);

    const scriptPzActuallyLaunches = fs.readFileSync(batPath, "utf8");

    expect(scriptPzActuallyLaunches).toContain(
      `-cachedir="${newDataPath}"`,
    );
    expect(scriptPzActuallyLaunches).not.toContain(
      `-cachedir="${oldDataPath}"`,
    );
  });
});
