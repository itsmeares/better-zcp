import { describe, expect, it } from "vitest";
import { mapConfigsEqual } from "../worldMapConfigEqual";
import type { MapConfig } from "../WorldMap";

// conv-worldmap-black-2026-08-31: detectServerVersion's "skip if nothing
// changed" guard used to compare a hand-picked field list (label, tileSize,
// fullWidth, isoX0, isoY0) instead of the whole config -- renderedMaxLevel,
// maxLevel, and fullHeight all sat outside that list, so a resolve response
// whose width/height/tileSize/origin happened to numerically match
// MAP_B42's own hardcoded placeholder made every LISTED field match while
// the real (narrower, correct) renderedMaxLevel was silently discarded.
// mapConfigsEqual replaces the list with a generic Object.keys walk so
// every field the type has participates automatically, including ones
// added after this fix. These tests pin that: they build a real base
// config, mutate exactly ONE field per test (including the three the old
// list dropped), and assert the comparison actually returns false for that
// field -- reproducing the specific miss, not just testing the happy path.

const BASE: MapConfig = {
  tileUrl: "/api/map/tiles",
  tileSize: 1024,
  fullWidth: 1157312,
  fullHeight: 509520,
  maxLevel: 21,
  renderedMaxLevel: 10,
  isoX0: 518144,
  isoY0: -69648,
  isoHalfSqr: 32,
  isoQuarterSqr: 16,
  defaultCenter: { x: 640000, y: 205000 },
  defaultScale: 0.002,
  label: "B42",
};

describe("mapConfigsEqual", () => {
  it("is true for two configs with identical fields (including a fresh defaultCenter object)", () => {
    const other: MapConfig = { ...BASE, defaultCenter: { x: BASE.defaultCenter.x, y: BASE.defaultCenter.y } };
    expect(mapConfigsEqual(BASE, other)).toBe(true);
  });

  it("is false when only renderedMaxLevel differs -- the exact field the old list-based guard dropped, causing the black-tile bug", () => {
    const resolved: MapConfig = { ...BASE, renderedMaxLevel: 15 };
    expect(mapConfigsEqual(BASE, resolved)).toBe(false);
  });

  it("is false when only maxLevel differs -- also dropped by the old list", () => {
    const resolved: MapConfig = { ...BASE, maxLevel: 22 };
    expect(mapConfigsEqual(BASE, resolved)).toBe(false);
  });

  it("is false when only fullHeight differs -- also dropped by the old list", () => {
    const resolved: MapConfig = { ...BASE, fullHeight: 990400 };
    expect(mapConfigsEqual(BASE, resolved)).toBe(false);
  });

  it("is false when only defaultCenter.x differs (the one non-primitive field, compared by value not reference)", () => {
    const resolved: MapConfig = { ...BASE, defaultCenter: { x: BASE.defaultCenter.x + 1, y: BASE.defaultCenter.y } };
    expect(mapConfigsEqual(BASE, resolved)).toBe(false);
  });

  it("is false when only defaultCenter.y differs", () => {
    const resolved: MapConfig = { ...BASE, defaultCenter: { x: BASE.defaultCenter.x, y: BASE.defaultCenter.y + 1 } };
    expect(mapConfigsEqual(BASE, resolved)).toBe(false);
  });

  it("is false when the fields the OLD guard did check still differ (label/tileSize/fullWidth/isoX0/isoY0), proving those weren't accidentally dropped by the rewrite", () => {
    expect(mapConfigsEqual(BASE, { ...BASE, label: "B41" })).toBe(false);
    expect(mapConfigsEqual(BASE, { ...BASE, tileSize: 2048 })).toBe(false);
    expect(mapConfigsEqual(BASE, { ...BASE, fullWidth: 2318656 })).toBe(false);
    expect(mapConfigsEqual(BASE, { ...BASE, isoX0: 1 })).toBe(false);
    expect(mapConfigsEqual(BASE, { ...BASE, isoY0: 1 })).toBe(false);
  });

  it("is false when a key is present on b but absent from a -- Object.keys(a) alone would never examine it and silently report equal (simulates a future optional MapConfig field)", () => {
    const a = { ...BASE } as Record<string, unknown>;
    delete a.fullHeight;
    const b = { ...BASE, fullHeight: 990400 } as Record<string, unknown>;
    expect(mapConfigsEqual(a as unknown as MapConfig, b as unknown as MapConfig)).toBe(false);
  });
});
