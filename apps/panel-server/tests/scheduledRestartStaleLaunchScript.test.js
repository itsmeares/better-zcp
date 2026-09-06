import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

const { generateStartupScripts, regenerateStartupScriptsWithBackup, refreshLaunchTargetBeforeStart } =
  await import("../routes/server.js");

// 2026-08-27 reproduction task (card
// user-report-servertest-ini-and-sandbox-reverted-to-default-after-restart),
// originally by Jim (4b8b22f). Pam's leading theory: PZ writes a fresh
// default servertest.ini when it starts and can't find the one it expects
// at -cachedir, and the scheduled-restart path can point PZ at the WRONG
// cachedir without ever touching the real config -- an orphan, not a
// corruption.
//
// ORIGINAL MECHANISM PROVEN HERE (Jim, 4b8b22f): -cachedir and -servername
// are baked as literal text into StartServer_<name>.bat/.sh at
// generateStartupScripts() time (server.js), and that function used to be
// called from exactly three places -- the manual /start route and the two
// install/setup-wizard flows -- NEVER from PUT /api/servers/:id (the
// Settings-UI edit route) and NEVER from scheduler.js's performRestart().
// So editing zomboidDataPath/serverName in Settings changed the DATABASE
// immediately but left the already-written launch script stale until the
// next MANUAL start regenerated it -- the next SCHEDULED restart in
// between launched PZ against the OLD baked cachedir.
//
// UPDATED 2026-08-27, SAME DAY, ROOT CAUSE FIX LANDED
// (refreshLaunchTargetBeforeStart(), server.js, called from BOTH the
// manual /start route and scheduler.js's performRestart()): this test
// used to hand-simulate "a scheduled restart leaves the script alone" by
// literally not calling anything between the settings edit and reading the
// script back -- an accurate simulation of the BUG, but one that would
// have kept passing silently forever even after the fix landed, since it
// never actually exercised the code path that got fixed. Per explicit
// instruction: a test that asserts a bug still exists must not survive the
// fix silently. Flipped to call the REAL refreshLaunchTargetBeforeStart()
// -- the function performRestart() now calls -- and assert the FIXED
// behavior: the script picks up the new path. See
// apps/panel-server/tests/performRestartRefreshesLaunchTarget.test.js for the same
// claim proven through the actual performRestart() call, not just this
// function in isolation, and apps/panel-server/tests/refreshLaunchTargetBeforeStart.test.js
// for that function's own full test suite.
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

    // Manual start #1: bakes -cachedir="...ZomboidData_old" into the .bat.
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

    // Operator edits the server's zomboidDataPath through the Settings UI
    // (PUT /api/servers/:id) -- that route still only updates the database
    // record, unchanged by this fix and correctly so (Settings save isn't
    // a restart). Modeled by an updated server object, exactly what a
    // fresh getServer()/getActiveServer() read after the edit returns.
    const updatedServer = { ...baseServer, zomboidDataPath: newDataPath };

    // What used to be the bug's exact blind spot: no manual start happens
    // here, only the refresh performRestart() now calls before every
    // scheduled restart.
    await refreshLaunchTargetBeforeStart(updatedServer);

    const scriptPzActuallyLaunches = fs.readFileSync(batPath, "utf8");

    // Fixed: the script now carries the NEW cachedir, with no trace of the
    // stale one -- a scheduled restart launches PZ against the same
    // directory a manual start would have.
    expect(scriptPzActuallyLaunches).toContain(
      `-cachedir="${newDataPath}"`,
    );
    expect(scriptPzActuallyLaunches).not.toContain(
      `-cachedir="${oldDataPath}"`,
    );
  });
});
