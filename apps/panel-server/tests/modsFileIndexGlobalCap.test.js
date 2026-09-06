import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// panel-oom-buildfileindex-unbounded: the panel crashed with a V8 heap OOM
// (~4GB, exit 134) on a real operator's modlist. buildFileIndex()'s per-mod
// walk was bounded by WALK_MAX_FILES (50,000), but that budget (ctx.left) is
// created fresh per top-level walkDir() call -- i.e. PER MOD, not globally.
// fileIndex itself accumulated every file across EVERY mod combined with no
// cap at all: at 150 mods, several routinely near the per-mod ceiling, that
// is millions of entries at ~500 bytes each (measured synthetically,
// matching the real entry shape of workshopId+modId+modName+absPath
// strings) -- multiple gigabytes, reproducing the operator's exact
// Mark-Compact-thrashing-then-OOM crash signature when run against a
// synthetic worst case at real scale.
//
// Fix: a GLOBAL cap (FILE_INDEX_MAX_ENTRIES, default 300,000 -- the same
// maxEntries budget convention server.js's wipe-preview countDir() already
// uses for this exact class of problem) shared across every mod in the
// scan, checked before each entry is pushed. Once hit, the scan stops
// entirely (not just this mod -- walking further mods after the index is
// already full only burns more time/memory for nothing) and an honest
// `truncated` flag + warning is returned, matching the "a truncated result
// must say so" convention used everywhere else in this codebase tonight.
//
// buildFileIndex() takes an optional `maxEntries` override (default
// FILE_INDEX_MAX_ENTRIES) so this cap is provable at a fast, small scale --
// same pattern as countDir(dir, budget) in server.js -- instead of needing a
// real 300,000-file fixture on disk.

const { buildFileIndex, FILE_INDEX_MAX_ENTRIES } = await import(
  "../routes/mods.js"
);

// Builds <serverPath>/steamapps/workshop/content/108600/<wsId>/<modDirName>/media/textures/f*.dat
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

  it("production default is 300,000 entries -- matches server.js's wipe-preview countDir() budget convention", () => {
    expect(FILE_INDEX_MAX_ENTRIES).toBe(300_000);
  });

  it("never accumulates more than the cap across MULTIPLE mods, even though each mod is individually far under WALK_MAX_FILES", async () => {
    // Three mods, none anywhere near the 50,000-per-mod WALK_MAX_FILES
    // ceiling, but their combined total (900) exceeds a small test cap
    // (500) -- exactly the "unbounded by mod count" shape of the bug. The
    // old code had no global counter at all, so this scenario could not
    // have been capped by anything.
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
    // The check happens before each push, so the walk stops the instant it
    // would exceed the cap -- total pushed entries lands exactly at CAP,
    // not "somewhere under it" (that would also be true of a much weaker,
    // approximate guard).
    expect(totalEntries).toBe(CAP);
    expect(truncated).toBe(true);
    expect(warnings.some((w) => /500.*entry limit/i.test(w))).toBe(true);

    // The scan must have stopped mid-flight rather than walking every mod
    // and just dropping entries at the end -- proves the fix bails out of
    // the WHOLE scan, not only the fileIndex write.
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
    // Sanity check that the production default doesn't accidentally
    // truncate an ordinary modlist -- only pathological scale should hit it.
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
