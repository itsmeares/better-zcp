import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { captureBackupSnapshot } from "../utils/backupSnapshot.js";

let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-snapshot-"));
  fs.mkdirSync(path.join(root, "Server"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it("captures curated server settings without credentials", () => {
  fs.writeFileSync(
    path.join(root, "Server", "DoomerZ.ini"),
    "MaxPlayers=16\nPVP=false\nRCONPassword=secret\nAdminPassword=also-secret\n",
  );
  fs.writeFileSync(
    path.join(root, "Server", "DoomerZ_SandboxVars.lua"),
    "SandboxVars = {\nZombies = 2,\nDayLength = 4,\nZombieLore = { Speed = 2, },\n}\n",
  );

  const snapshot = captureBackupSnapshot({
    id: "server-1",
    serverName: "DoomerZ",
    zomboidDataPath: root,
  });

  expect(snapshot.server).toEqual({ id: "server-1", name: "DoomerZ", provider: "native" });
  expect(snapshot.serverIni).toEqual({ MaxPlayers: "16", PVP: "false" });
  expect(snapshot.sandboxVars).toEqual({ Zombies: 2, DayLength: 4 });
  expect(JSON.stringify(snapshot)).not.toMatch(/secret/);
});

it("returns an empty configuration snapshot when config files are absent", () => {
  const snapshot = captureBackupSnapshot({ serverName: "DoomerZ", zomboidDataPath: root });

  expect(snapshot.serverIni).toEqual({});
  expect(snapshot.sandboxVars).toEqual({});
});