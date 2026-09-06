import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  applyUpdateBundle,
  acknowledgeUpdateBundle,
  stageUpdateBundle,
} from "../services/updateBundle.ts";
import {
  createUpdateDataBackup,
  restorePreUpdateDataBackup,
} from "../services/panelUpdateChecker.js";

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function metadata(version = "2.0.0", buildSha = "new-build") {
  return { panelVersion: version, buildSha, apiContractVersion: 1 };
}

let installDir;

function prepareBundleWithDatabase() {
  const binaryPath = path.join(installDir, "ZomboidControlPanel");
  const stagedBinaryPath = `${binaryPath}.new`;
  const liveClientPath = path.join(installDir, "client", "dist");
  const incomingClientPath = path.join(installDir, "incoming-client");
  const dbPath = path.join(installDir, "data", "db.json");
  writeFile(binaryPath, "old-binary");
  writeFile(stagedBinaryPath, "new-binary");
  writeFile(path.join(liveClientPath, "index.html"), "old-client");
  writeFile(path.join(incomingClientPath, "index.html"), "new-client");
  writeFile(
    path.join(incomingClientPath, "build-info.json"),
    JSON.stringify(metadata()),
  );
  writeFile(dbPath, '{"schemaVersion":1,"users":[{"username":"admin"}]}');
  const dataPaths = { dbPath };

  const journalPath = stageUpdateBundle({
    installDir,
    version: "2.0.0",
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    metadata: metadata(),
  });

  return { binaryPath, liveClientPath, journalPath, dataPaths, dbPath };
}

describe("pre-update database backup lifecycle around a real bundle transaction", () => {
  beforeEach(() => {
    installDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-update-db-lifecycle-"));
  });

  afterEach(() => {
    fs.rmSync(installDir, { recursive: true, force: true });
  });

  it("the snapshot exists before the destructive apply step, and survives a clean successful update", () => {
    const { binaryPath, liveClientPath, journalPath, dataPaths, dbPath } =
      prepareBundleWithDatabase();
    const originalDbContent = fs.readFileSync(dbPath, "utf8");

    const backupPath = createUpdateDataBackup(dataPaths, "2.0.0");
    expect(backupPath).toBeTruthy();
    expect(fs.readFileSync(backupPath, "utf8")).toBe(originalDbContent);

    applyUpdateBundle(journalPath);
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("new-binary");
    expect(
      fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8"),
    ).toBe("new-client");

    acknowledgeUpdateBundle(journalPath, metadata());
    expect(fs.existsSync(journalPath)).toBe(false);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(originalDbContent);
  });

  it("closes the half-rollback gap: restores the pre-migration database after a version-mismatch rollback", () => {
    const { binaryPath, liveClientPath, journalPath, dataPaths, dbPath } =
      prepareBundleWithDatabase();
    const preUpdateDbContent = fs.readFileSync(dbPath, "utf8");

    const backupPath = createUpdateDataBackup(dataPaths, "2.0.0");
    applyUpdateBundle(journalPath);

    const migratedDbContent = '{"schemaVersion":2,"users":[{"username":"admin","migrated":true}]}';
    fs.writeFileSync(dbPath, migratedDbContent);

    expect(() =>
      acknowledgeUpdateBundle(journalPath, metadata("2.0.1", "other-build")),
    ).toThrowError(expect.objectContaining({ code: "version_mismatch" }));
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(
      fs.readFileSync(path.join(liveClientPath, "index.html"), "utf8"),
    ).toBe("old-client");

    expect(fs.readFileSync(dbPath, "utf8")).toBe(migratedDbContent);
    expect(fs.readFileSync(dbPath, "utf8")).not.toBe(preUpdateDbContent);

    const restored = restorePreUpdateDataBackup(dataPaths, backupPath);
    expect(restored).toBe(true);
    expect(fs.readFileSync(dbPath, "utf8")).toBe(preUpdateDbContent);
  });

  it("the mid-apply rollback path (new binary never ran) needs no database restore at all", () => {
    const { binaryPath, stagedBinaryPath, dataPaths, dbPath, journalPath } = (() => {
      const b = prepareBundleWithDatabase();
      return { ...b, stagedBinaryPath: `${b.binaryPath}.new` };
    })();
    const originalDbContent = fs.readFileSync(dbPath, "utf8");
    createUpdateDataBackup(dataPaths, "2.0.0");

    fs.unlinkSync(stagedBinaryPath);
    expect(() => applyUpdateBundle(journalPath)).toThrowError(
      expect.objectContaining({ code: "av_quarantine" }),
    );
    expect(fs.readFileSync(binaryPath, "utf8")).toBe("old-binary");
    expect(fs.readFileSync(dbPath, "utf8")).toBe(originalDbContent);
  });
});

describe("restorePreUpdateDataBackup() -- edge cases", () => {
  let dir;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns false and touches nothing when no backup path was recorded", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restore-nobackup-"));
    const dbPath = path.join(dir, "db.json");
    fs.writeFileSync(dbPath, "live-content");

    expect(restorePreUpdateDataBackup({ dbPath }, null)).toBe(false);
    expect(restorePreUpdateDataBackup({ dbPath }, undefined)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("live-content");
  });

  it("returns false without throwing when the recorded backup no longer exists on disk", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-restore-missing-"));
    const dbPath = path.join(dir, "db.json");
    fs.writeFileSync(dbPath, "live-content");
    const goneBackupPath = path.join(dir, "db.json.pre-update-1.0.0-123");

    expect(restorePreUpdateDataBackup({ dbPath }, goneBackupPath)).toBe(false);
    expect(fs.readFileSync(dbPath, "utf8")).toBe("live-content");
  });
});
