import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initDatabase, closeDatabase, createServer } from "../database/init.ts";
import { setPanelRuntime, setServerRuntime, removeServerRuntime } from "../utils/panelRuntime.ts";
import { handleApiRequest } from "../http/apiDispatcher.ts";

let root: string;
let serverId: string;
afterEach(() => {
  if (serverId) removeServerRuntime(serverId);
  setPanelRuntime({});
  closeDatabase();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("backup downloads through the native API", () => {
  it.skipIf(process.platform === "win32")("streams regular archives but rejects links to panel-private files", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-backup-download-"));
    await initDatabase();
    const server = await createServer({ name: "Download fixture", serverName: "DownloadFixture" });
    serverId = server.id;
    const backups = path.join(root, "backups");
    fs.mkdirSync(backups);
    const privateFile = path.join(root, "private.txt");
    fs.writeFileSync(privateFile, "PRIVATE-PANEL-FIXTURE");
    fs.writeFileSync(path.join(backups, "regular.zip"), "REGULAR-ARCHIVE-FIXTURE");
    fs.symlinkSync(privateFile, path.join(backups, "linked.zip"));
    setPanelRuntime({ authService: { authenticateApiRequest: async () => ({
      ok: true, user: { userId: "fixture-admin", username: "fixture", role: "admin" },
    }) } });
    setServerRuntime(serverId, { backupService: { getBackupsPath: async () => backups } });

    const download = (name: string) => handleApiRequest(new Request(
      `http://panel.test/api/servers/${serverId}/backup/download/${name}`,
    ));
    const regular = await download("regular.zip");
    expect(regular?.status).toBe(200);
    expect(regular?.headers.get("content-disposition")).toContain("regular.zip");
    expect(await regular?.text()).toBe("REGULAR-ARCHIVE-FIXTURE");
    const linked = await download("linked.zip");
    expect(linked?.status).toBe(500);
    expect(await linked?.text()).not.toContain("PRIVATE-PANEL-FIXTURE");
    expect(fs.readFileSync(privateFile, "utf8")).toBe("PRIVATE-PANEL-FIXTURE");
  });
});
