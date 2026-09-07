import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";


const logServerEvent = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent,
}));

vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { BackupService } = await import("../services/backupService.ts");

const SERVER_NAME = "servertest";
let root;
let savesPath;
let backupsPath;

function createService() {
  const service = new BackupService();
  service.getSavesPath = async () => savesPath;
  service.getBackupsPath = async () => backupsPath;
  service.setServerManager({
    getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
  });
  return service;
}

function corruptOneByte(filePath) {
  const buf = fs.readFileSync(filePath);
  const at = Math.floor(buf.length * 0.6);
  buf[at] = buf[at] ^ 0xff;
  fs.writeFileSync(filePath, buf);
}

async function forceCrcOnlyCorruption(zipPath, entryName) {
  const unzipper = await import("unzipper");
  const archive = await unzipper.Open.file(zipPath);
  const entry = archive.files.find((f) => f.path.endsWith(entryName));
  if (!entry) {
    throw new Error(`forceCrcOnlyCorruption: no entry named ${entryName} in ${zipPath}`);
  }

  const buf = fs.readFileSync(zipPath);
  const localOffset = entry.offsetToLocalFileHeader;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);
  const original = zlib.inflateRawSync(compressed);

  let foundOffset = null;
  for (let i = 0; i < compressed.length; i++) {
    const candidate = Buffer.from(compressed);
    candidate[i] ^= 0xff;
    try {
      const out = zlib.inflateRawSync(candidate);
      if (!out.equals(original)) {
        foundOffset = i;
        break;
      }
    } catch {
      // This byte position broke the DEFLATE stream structurally -- that's
      // exactly the OTHER corruption shape (extraction-time failure), not
      // the one this helper needs. Try the next byte.
    }
  }
  if (foundOffset === null) {
    throw new Error(
      `forceCrcOnlyCorruption: could not find a byte in ${entryName}'s ${compressed.length}-byte compressed payload whose flip decodes cleanly but differs -- fixture may be too small/uncompressible for this technique.`,
    );
  }

  buf[dataStart + foundOffset] ^= 0xff;
  fs.writeFileSync(zipPath, buf);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-integrity-"));
  savesPath = path.join(root, "Saves", "Multiplayer", SERVER_NAME);
  backupsPath = path.join(root, "backups");
  fs.mkdirSync(backupsPath, { recursive: true });
  fs.mkdirSync(savesPath, { recursive: true });
  fs.writeFileSync(
    path.join(savesPath, "map_meta.bin"),
    Buffer.from("LIVE ORIGINAL MAP DATA ".repeat(400)),
  );
  fs.writeFileSync(path.join(savesPath, "worldstats.txt"), "LIVE ORIGINAL STATS");
  logServerEvent.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("restoreBackup() verifies extracted file integrity before swapping in the live save", () => {
  it("refuses via the CRC-recompute path specifically, when corruption decodes cleanly but produces wrong content", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);
    const zipPath = path.join(backupsPath, createResult.backup.name);

    await forceCrcOnlyCorruption(zipPath, "map_meta.bin");

    const beforeRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    expect(restoreResult.success).toBe(false);
    expect(restoreResult.message).toMatch(/integrity verification/i);
    expect(restoreResult.message).toContain("map_meta.bin");
    expect(restoreResult.message).not.toMatch(/unexpected end of file/i);

    expect(fs.existsSync(savesPath)).toBe(true);
    const afterRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));
    expect(Buffer.compare(afterRestore, beforeRestore)).toBe(0);
  });

  it("refuses ANY single-byte corruption and leaves the live save untouched, regardless of which mechanism catches it", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);
    const zipPath = path.join(backupsPath, createResult.backup.name);

    corruptOneByte(zipPath);

    const beforeRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    expect(restoreResult.success).toBe(false);

    expect(fs.existsSync(savesPath)).toBe(true);
    const afterRestore = fs.readFileSync(path.join(savesPath, "map_meta.bin"));
    expect(Buffer.compare(afterRestore, beforeRestore)).toBe(0);
  });

  it("restores normally when every file's checksum matches (no false positives)", async () => {
    const service = createService();

    const createResult = await service.createBackup({ createPreRestoreBackup: false });
    expect(createResult.success).toBe(true);

    fs.rmSync(savesPath, { recursive: true, force: true });

    const restoreResult = await service.restoreBackup(createResult.backup.name, {
      createPreRestoreBackup: false,
    });

    expect(restoreResult.success).toBe(true);
    expect(fs.readFileSync(path.join(savesPath, "map_meta.bin")).toString()).toBe(
      "LIVE ORIGINAL MAP DATA ".repeat(400),
    );
  });
});
