import { describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  initDatabase,
  closeDatabase,
  createServer,
  getServer,
  updateServer,
  deleteServer,
  getDatabaseFilePath,
  getSetting,
  setSetting,
  setSettings,
  logCommand,
  getCommandHistory,
  createScheduledTask,
  getScheduledTasks,
  updateScheduledTask,
  addTrackedMod,
  getTrackedMods,
  createAdmin,
  createDatabaseBackup,
} from "../database/init.ts";
import { runForServer, requireServerId } from "../utils/serverScope.ts";
import { setPanelRuntime, setServerRuntime } from "../utils/panelRuntime.ts";
import { handleApiRequest } from "../http/apiDispatcher.ts";
import { acquireLifecycleLock } from "../services/lifecycleCoordinator.ts";
import { RconService } from "../services/rcon.ts";
import { findPanelBridgePath } from "../services/serverRuntime.ts";
import { getDataPaths } from "../utils/paths.ts";
import { ServerManager } from "../services/serverManager.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("server and data foundation", () => {
  it("keeps concurrent settings, commands, mods, and schedules on their explicit profiles across restart", async () => {
    await initDatabase();
    const first = await createServer({
      name: "First",
      serverName: "first",
      rconPassword: "first-secret",
    });
    const second = await createServer({
      name: "Second",
      serverName: "second",
      rconPassword: "second-secret",
    });
    await Promise.all(
      [first, second].map((server) =>
        runForServer(server.id, async () => {
          await setSetting("autoRestartEnabled", server.name);
          await delay(server === first ? 10 : 1);
          await logCommand(`servermsg ${server.name}`, "ok");
          await addTrackedMod("123", server.name);
          const task = await createScheduledTask(
            server.name,
            "0 */6 * * *",
            "save",
          );
          expect(task.server_id).toBe(server.id);
          expect(await getSetting("autoRestartEnabled")).toBe(server.name);
        }),
      ),
    );
    await Promise.all([
      updateServer(first.id, { name: "Renamed" }),
      updateServer(first.id, { maxMemory: 12 }),
    ]);
    expect(await getServer(first.id)).toMatchObject({
      name: "Renamed",
      maxMemory: 12,
    });
    closeDatabase();
    await initDatabase();
    for (const server of [first, second])
      await runForServer(server.id, async () => {
        expect(await getSetting("autoRestartEnabled")).toBe(server.name);
        expect(
          (await getCommandHistory()).map((entry) => entry.command),
        ).toEqual([`servermsg ${server.name}`]);
        expect((await getTrackedMods()).map((mod) => mod.name)).toEqual([
          server.name,
        ]);
        expect(
          (await getScheduledTasks()).map((task) => task.server_id),
        ).toEqual([server.id]);
      });
    const task = await runForServer(
      first.id,
      async () => (await getScheduledTasks())[0],
    );
    expect(
      await runForServer(second.id, () =>
        updateScheduledTask(
          task.id,
          "wrong",
          undefined,
          undefined,
          undefined,
          undefined,
        ),
      ),
    ).toBeNull();
    expect(
      fs
        .readFileSync(getDatabaseFilePath())
        .includes(Buffer.from("first-secret")),
    ).toBe(false);
    expect((await getServer(first.id))?.rconPassword).toBe("first-secret");
    const backup = await createDatabaseBackup();
    const snapshot = new DatabaseSync(
      path.join(path.dirname(getDatabaseFilePath()), "backups", backup.file),
      { readOnly: true },
    );
    expect(snapshot.prepare("PRAGMA integrity_check").get()).toEqual({
      integrity_check: "ok",
    });
    expect(
      snapshot.prepare("SELECT count(*) AS count FROM servers").get()?.count,
    ).toBe(2);
    snapshot.close();
    await deleteServer(first.id);
    expect(await getServer(first.id)).toBeNull();
    expect((await getServer(second.id))?.rconPassword).toBe("second-secret");
  });

  it("dispatches overlapping API requests to their own service and history", async () => {
    const first = await createServer({
      name: "API First",
      serverName: "api_first",
    });
    const second = await createServer({
      name: "API Second",
      serverName: "api_second",
    });
    await createAdmin({ id: "admin", username: "admin", role: "admin" });
    await setSetting("authEnabled", false);
    setPanelRuntime({});
    for (const server of [first, second])
      setServerRuntime(server.id, {
        rconService: {
          execute: async (command: string) => {
            await delay(server === first ? 10 : 1);
            expect(requireServerId()).toBe(server.id);
            await logCommand(command, server.name);
            return { success: true, response: server.name };
          },
        },
      });
    const responses = await Promise.all(
      [first, second].map((server) =>
        handleApiRequest(
          new Request(`http://panel/api/servers/${server.id}/rcon/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command: "players" }),
          }),
        ),
      ),
    );
    expect(
      await Promise.all(responses.map((response) => response!.json())),
    ).toEqual([
      { success: true, response: first.name },
      { success: true, response: second.name },
    ]);
    for (const server of [first, second])
      await runForServer(server.id, async () => {
        expect((await getCommandHistory())[0].response).toBe(server.name);
      });
    const unscoped = await handleApiRequest(
      new Request("http://panel/api/rcon/history"),
    );
    expect(unscoped?.status).toBe(400);
    const missing = await handleApiRequest(
      new Request("http://panel/api/servers/missing/rcon/history"),
    );
    expect(missing?.status).toBe(404);
  });

  it("keeps bridge discovery inside the owning cachedir when another server has matching files", async () => {
    const root = getDataPaths().dataDir;
    const installPath = path.join(root, "install");
    const dataPath = path.join(root, "own-data");
    const foreignBridge = path.join(
      root,
      "Server_files_peer",
      "Lua",
      "panelbridge",
      "same_name",
    );
    fs.mkdirSync(foreignBridge, { recursive: true });
    fs.writeFileSync(path.join(foreignBridge, "status.json"), "{}");
    const server = await createServer({
      serverName: "same_name",
      installPath,
      zomboidDataPath: dataPath,
    });
    await runForServer(server.id, async () => {
      expect(await findPanelBridgePath()).toMatchObject({
        path: path.join(dataPath, "Lua", "panelbridge", "same_name"),
        notCreated: true,
      });
      await setSetting("panelBridge", {
        bridgePath: path.join(dataPath, "custom"),
      });
      expect(await findPanelBridgePath()).toMatchObject({
        path: path.join(dataPath, "custom"),
      });
    });
  });

  it("locks one profile and refuses retargeting live managers or connections", async () => {
    const first = await createServer({ name: "Bound", serverName: "bound" });
    const second = await createServer({ name: "Other", serverName: "other" });
    await runForServer(first.id, async () => {
      const manager = new ServerManager();
      const rcon = new RconService();
      await manager.loadConfig();
      await rcon.loadConfig();
      await expect(manager.reloadConfig(second.id)).rejects.toThrow(
        "Cannot retarget",
      );
      await expect(rcon.reloadConfig(second.id)).rejects.toThrow(
        "Cannot retarget",
      );
      const lock = acquireLifecycleLock("backup");
      expect(lock).not.toBeNull();
      expect(acquireLifecycleLock("restart")).toBeNull();
      await runForServer(second.id, async () => {
        const otherLock = acquireLifecycleLock("restart");
        expect(otherLock).not.toBeNull();
        otherLock!.release();
      });
      lock!.release();
    });
  });
  it("commits a settings form as one change and restores credentials on a rejected SQL write", async () => {
    const server = await createServer({
      serverName: "Atomic",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "original",
    });
    const injection = new DatabaseSync(getDatabaseFilePath());
    injection.exec(
      "CREATE TRIGGER reject_setting BEFORE INSERT ON settings WHEN NEW.key='reject' BEGIN SELECT RAISE(ABORT, 'injected failure'); END",
    );
    try {
      await runForServer(server.id, async () => {
        await expect(
          setSettings([
            ["rconHost", "127.0.0.2"],
            ["rconPort", 27016],
            ["rconPassword", "replacement"],
            ["reject", true],
          ]),
        ).rejects.toThrow("injected failure");
        expect(await getServer(server.id)).toMatchObject({
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "original",
        });
        await setSettings([
          ["rconHost", "127.0.0.2"],
          ["rconPort", 27016],
        ]);
        expect(await getServer(server.id)).toMatchObject({
          rconHost: "127.0.0.2",
          rconPort: 27016,
        });
      });
    } finally {
      injection.exec("DROP TRIGGER reject_setting");
      injection.close();
    }
  });
});
