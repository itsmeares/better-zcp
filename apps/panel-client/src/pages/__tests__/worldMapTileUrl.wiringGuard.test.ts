import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// hunt-wave12-2026-08-30 follow-up: worldMapTileUrl.test.ts proves
// buildTileQuery() itself is correct (7 cases, break-verified). It does
// NOT prove WorldMap.tsx and ChunkCleaner.tsx actually CALL it with the
// right args -- a full-render integration test for that hit a genuine
// structural wall in jsdom (see the commit message on 456c421f) and was
// cut rather than forced. "Both halves covered, the join untested" is
// exactly the shape a refactor slips through: something could extract a
// perfectly correct helper and simply forget to wire it in -- most likely
// in ChunkCleaner.tsx specifically, since it never tracked b42Dir at all
// before this change, making that wiring the newest and least load-bearing
// part of the fix.
//
// THIS IS A TEXT-LEVEL GUARD, NOT BEHAVIOURAL COVERAGE. It reads each page
// file off disk and asserts the literal symbol `buildTileQuery` still
// appears in it -- the same technique this floor's accessLevelsListParity
// test used for a cross-file drift check. It cannot tell whether the call
// is reachable, passes the right arguments, or ever actually runs; it can
// only catch "the reference to buildTileQuery was removed entirely",
// which is the shape of regression a naive refactor or an accidental
// revert would actually produce. Do not treat a pass here as evidence the
// wiring behaves correctly -- worldMapTileUrl.test.ts and manual review
// are what established that; this only prevents it from being silently
// dropped afterward.

function readPageSource(fileName: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), "src/pages", fileName), "utf8");
}

describe("worldMapTileUrl wiring guard (text-level only, see file header)", () => {
  it("WorldMap.tsx still references buildTileQuery", () => {
    const source = readPageSource("WorldMap.tsx");
    expect(source).toMatch(/\bbuildTileQuery\b/);
  });

  it("ChunkCleaner.tsx still references buildTileQuery", () => {
    const source = readPageSource("ChunkCleaner.tsx");
    expect(source).toMatch(/\bbuildTileQuery\b/);
  });
});
