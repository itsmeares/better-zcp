import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";


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
