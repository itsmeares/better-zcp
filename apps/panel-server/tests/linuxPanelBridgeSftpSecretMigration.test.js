import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const {
  getDb,
  commitNow,
  setSetting,
  createDatabaseBackup,
  rehydratePanelBridgeSftpPassword,
  redactPanelBridgeSftpPasswordForWrite,
} = await import("../database/init.js");
const { getDataPaths } = await import("../utils/paths.js");
const { readUiSecretFile, writeUiSecretFile } = await import(
  "../utils/uiSecretFile.ts"
);

const { dataDir, dbPath } = getDataPaths();
const backupDir = path.join(dataDir, "backups");
const isWindows = process.platform === "win32";

const FAKE_PASSWORD = "obviously-fake-sftp-password-do-not-use";

function secretFilePath(name) {
  return path.join(dataDir, `${name}.secret`);
}

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(secretFilePath("panelBridgeSftpPassword"), { force: true });
});

describe("panelBridgeSftpPassword — migrates out of db.json on the very first write, like rconPassword", () => {
  it("a legacy plaintext value is redacted from db.json and lands in its own file on the next flush", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    const onDisk = JSON.parse(fs.readFileSync(dbPath, "utf-8"));
    expect(onDisk.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(readUiSecretFile("panelBridgeSftpPassword")).toBe(FAKE_PASSWORD);
  });

  it.skipIf(isWindows)(
    "the secret file the legacy value lands in is 0600",
    async () => {
      await getDb();
      await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
      await commitNow();

      const mode = fs.statSync(secretFilePath("panelBridgeSftpPassword")).mode & 0o777;
      expect(mode).toBe(0o600);
    },
  );

  it("survives a restart -- the in-memory value is re-attached from the secret file, not lost", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    const rehydrated = rehydratePanelBridgeSftpPassword({ settings: {} }, console);
    expect(rehydrated.settings.panelBridgeSftpPassword).toBe(FAKE_PASSWORD);
  });
});

describe("ASK 1 -- the backup win, measured (not deduced)", () => {
  it("a real backup taken AFTER the fix does not contain the plaintext password anywhere in the file", async () => {
    await getDb();
    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupContent = fs.readFileSync(path.join(backupDir, result.file), "utf-8");
    expect(backupContent).not.toContain(FAKE_PASSWORD);
  });

  it("BREAK-VERIFY CONTROL: a real backup taken with the redact step disabled DOES contain the plaintext -- proves the win is real, not vacuous", async () => {
    const db = await getDb();

    db.data.settings.panelBridgeSftpPassword = FAKE_PASSWORD;
    const raw = JSON.stringify(db.data, null, 2);
    fs.writeFileSync(dbPath, raw, { encoding: "utf-8", mode: 0o600 });

    const result = await createDatabaseBackup();
    expect(result.success).toBe(true);
    const backupContent = fs.readFileSync(path.join(backupDir, result.file), "utf-8");
    expect(backupContent).toContain(FAKE_PASSWORD);

    await setSetting("panelBridgeSftpPassword", FAKE_PASSWORD);
    await commitNow();
  });
});

describe("ASK 2 -- restoring an old (pre-migration) backup that still carries the plaintext", () => {
  it("the restored plaintext is used as-is, not clobbered by a stale/absent secret file, and gets redacted again on the next flush", async () => {
    writeUiSecretFile("panelBridgeSftpPassword", "stale-value-from-before-restore");

    const restored = rehydratePanelBridgeSftpPassword(
      { settings: { panelBridgeSftpPassword: FAKE_PASSWORD } },
      console,
    );
    expect(restored.settings.panelBridgeSftpPassword).toBe(FAKE_PASSWORD);

    const redacted = redactPanelBridgeSftpPasswordForWrite(restored);
    expect(redacted.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(readUiSecretFile("panelBridgeSftpPassword")).toBe(FAKE_PASSWORD);
  });
});

describe("ASK 3 -- db.json restored, but panelBridgeSftpPassword.secret did not make the trip", () => {
  it("resolves to undefined silently -- no thrown error, no warning logged. Same shape as rconPassword's pre-existing analogous gap (see report; not fixed here, filed separately).", () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    expect(fs.existsSync(secretFilePath("panelBridgeSftpPassword"))).toBe(false);

    const result = rehydratePanelBridgeSftpPassword({ settings: {} }, log);

    expect(result.settings.panelBridgeSftpPassword).toBeUndefined();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
