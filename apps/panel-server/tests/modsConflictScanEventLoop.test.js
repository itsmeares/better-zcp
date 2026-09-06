import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// mods-conflict-scan-unmeasured-at-scale: routes/mods.js's conflict scanner
// (GET /conflicts, /conflicts/stream) builds its file index by walking every
// tracked mod's media/ folder. Measured against a synthetic mod at
// WALK_MAX_FILES (50,000 files -- a real, code-enforced ceiling this file
// already truncates at, not a hypothetical one): a single such mod blocked
// the Node event loop for ~690ms in ONE unbroken synchronous burst, because
// buildFileIndex()'s per-mod loop only ever yielded to the event loop
// between mods, never within one mod's walk or while populating fileIndex
// from that mod's file list -- the exact same "sync fs walk with no yield
// budget" shape as the countDir() (/wipe/preview) and scanSaveStats()
// (debug.js) bugs found earlier tonight. One large content mod (a map pack,
// a texture pack) was enough to freeze every other request on the panel --
// RCON, the player list, any other tab -- for that long, on a demand action
// an admin can trigger at will.
//
// The fix (both in walkDir()'s own entry loop and in buildFileIndex()'s
// fileIndex-population loop, which turned out to be the larger of the two
// contributors) yields every WALK_YIELD_EVERY entries instead of once per
// mod. Measured after the fix: the same 50,000-file mod's worst single
// event-loop gap dropped from ~690ms to ~30ms.
//
// This test can't reproduce the full 50,000-file scale without making the
// suite slow (fixture creation alone took ~30s at that size), so instead of
// re-timing wall-clock here, it proves the MECHANISM: yielding now happens
// many times over the course of indexing one mod, scaling with file count,
// rather than a fixed once-per-mod -- the exact property that was missing.
// Spies on the real global setImmediate (yieldTick's primitive) and lets it
// run through normally, so this observes the real code path, not a mock of
// it.

vi.mock("../database/init.js", () => ({
  getTrackedMods: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  getActiveServer: vi.fn(async () => null),
}));

vi.mock("../utils/paths.js", () => ({
  getDataPaths: vi.fn(() => ({
    dataDir: "/tmp/mods-conflict-scan-event-loop-test",
    logsDir: "/tmp/mods-conflict-scan-event-loop-test",
  })),
}));

const { buildFileIndex } = await import("../routes/mods.js");

const WORKSHOP_ID = "123456789";

// Builds <serverPath>/steamapps/workshop/content/108600/<wsId>/media/<sub>/f*.dat
// -- the first path getWorkshopPaths() checks, and deliberately no mod.info
// file: buildFileIndex() falls back to the mod directory's own name as
// modId/modName when getModDetailsFromWorkshop() finds nothing, so this
// fixture doesn't need to fake Steam's mod.info format at all.
function buildSingleModFixture(serverPath, wsId, fileCount) {
  const modDir = path.join(
    serverPath,
    "steamapps",
    "workshop",
    "content",
    "108600",
    wsId,
    "onlymod",
  );
  const subdirs = ["lua/server", "textures", "sound"];
  const mediaPath = path.join(modDir, "media");
  for (const d of subdirs) fs.mkdirSync(path.join(mediaPath, d), { recursive: true });
  let written = 0;
  let i = 0;
  while (written < fileCount) {
    const d = subdirs[i % subdirs.length];
    fs.closeSync(fs.openSync(path.join(mediaPath, d, `f${written}.dat`), "w"));
    written++;
    i++;
  }
}

describe("buildFileIndex() yields to the event loop many times while indexing one large mod", () => {
  let serverPath;

  beforeEach(() => {
    serverPath = fs.mkdtempSync(path.join(os.tmpdir(), "mods-conflict-scan-el-"));
  });

  afterEach(() => {
    fs.rmSync(serverPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("yield count scales with file count instead of staying fixed at one-per-mod", async () => {
    // Old code yielded exactly once per mod, regardless of how many files
    // that mod contained -- so this ratio would stay ~flat (dominated by the
    // single fixed per-mod yield) instead of growing with fileCount.
    buildSingleModFixture(serverPath, WORKSHOP_ID, 500);
    const smallSpy = vi.spyOn(global, "setImmediate");
    await buildFileIndex([WORKSHOP_ID], serverPath, null, null);
    const smallYields = smallSpy.mock.calls.length;
    smallSpy.mockRestore();
    fs.rmSync(path.join(serverPath, "steamapps"), { recursive: true, force: true });

    buildSingleModFixture(serverPath, WORKSHOP_ID, 6000);
    const largeSpy = vi.spyOn(global, "setImmediate");
    const { fileIndex, modsScanned } = await buildFileIndex(
      [WORKSHOP_ID],
      serverPath,
      null,
      null,
    );
    const largeYields = largeSpy.mock.calls.length;
    largeSpy.mockRestore();

    // Sanity: the walk itself actually ran and found every file.
    expect(modsScanned).toBe(1);
    expect(Object.keys(fileIndex).length).toBe(6000);

    // 500 files stays under every yield threshold (WALK_YIELD_EVERY is
    // 1000, split across 3 subdirs), so it only crosses the ONE fixed
    // per-mod yieldTick() -- this is what the old code did unconditionally,
    // at every scale. The old code would show largeYields === 1 too,
    // regardless of file count. The fix must show materially more yields
    // for the 12x-larger mod -- proving the yield budget is tied to work
    // done, not fixed per mod.
    expect(smallYields).toBe(1);
    expect(largeYields).toBeGreaterThan(smallYields * 2);
  });

  it("yields repeatedly during a large single-mod walk", async () => {
    buildSingleModFixture(serverPath, WORKSHOP_ID, 8000);

    const yieldSpy = vi.spyOn(global, "setImmediate");
    try {
      await buildFileIndex([WORKSHOP_ID], serverPath, null, null);

      expect(yieldSpy.mock.calls.length).toBeGreaterThan(3);
    } finally {
      yieldSpy.mockRestore();
    }
  });
});
