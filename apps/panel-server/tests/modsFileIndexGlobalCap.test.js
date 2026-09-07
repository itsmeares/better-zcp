import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const { buildFileIndex, FILE_INDEX_MAX_ENTRIES } = await import(
  "../routes/mods.ts"
);

function buildModFixture(serverPath, wsId, modDirName, fileCount) {
  const mediaPath = path.join(
    serverPath,
    "steamapps",
    "workshop",
    "content",
    "108600",
    wsId,
    modDirName,
    "media",
    "textures",
  );
  fs.mkdirSync(mediaPath, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    fs.closeSync(fs.openSync(path.join(mediaPath, `f${i}.dat`), "w"));
  }
}

describe("buildFileIndex() global entry cap", () => {
  let serverPath;

  beforeEach(() => {
    serverPath = fs.mkdtempSync(
      path.join(os.tmpdir(), "mods-file-index-cap-"),
    );
  });

  afterEach(() => {
    fs.rmSync(serverPath, { recursive: true, force: true });
  });

  it("production default is 300,000 entries -- matches server.ts's wipe-preview countDir() budget convention", () => {
    expect(FILE_INDEX_MAX_ENTRIES).toBe(300_000);
  });

  it("never accumulates more than the cap across MULTIPLE mods, even though each mod is individually far under WALK_MAX_FILES", async () => {
    const wsIds = ["111111111", "222222222", "333333333"];
    wsIds.forEach((wsId, i) =>
      buildModFixture(serverPath, wsId, `mod_${i}`, 300),
    );
    const CAP = 500;

    const scannedMods = [];
    const { fileIndex, truncated, warnings, modsScanned } =
      await buildFileIndex(
        wsIds,
        serverPath,
        (info) => scannedMods.push(info.modId),
        null,
        CAP,
      );

    const totalEntries = Object.values(fileIndex).reduce(
      (sum, arr) => sum + arr.length,
      0,
    );
    expect(totalEntries).toBe(CAP);
    expect(truncated).toBe(true);
    expect(warnings.some((w) => /500.*entry limit/i.test(w))).toBe(true);

    expect(modsScanned).toBeLessThan(wsIds.length);
    expect(scannedMods.length).toBeLessThan(wsIds.length);
  });

  it("does not truncate, and reports no limit warning, when the total stays under the cap", async () => {
    buildModFixture(serverPath, "444444444", "small_mod", 50);
    const { fileIndex, truncated, warnings, modsScanned } =
      await buildFileIndex(["444444444"], serverPath, null, null, 500);

    expect(Object.keys(fileIndex).length).toBe(50);
    expect(truncated).toBe(false);
    expect(warnings.some((w) => /entry limit/i.test(w))).toBe(false);
    expect(modsScanned).toBe(1);
  });

  it("with no override, a realistic-but-modest multi-mod scan stays well under the real 300,000 production cap and is not truncated", async () => {
    const wsIds = ["555555555", "666666666"];
    wsIds.forEach((wsId, i) =>
      buildModFixture(serverPath, wsId, `ordinary_mod_${i}`, 200),
    );
    const { truncated, warnings, modsScanned } = await buildFileIndex(
      wsIds,
      serverPath,
      null,
      null,
    );
    expect(truncated).toBe(false);
    expect(warnings.some((w) => /entry limit/i.test(w))).toBe(false);
    expect(modsScanned).toBe(2);
  });
});
