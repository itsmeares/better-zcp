// GH#109: a requested DZI tile level can be
// within the map's theoretical maxLevel yet still have no tile actually
// rendered upstream for most of the map -- maxLevel is the depth a FULL
// Deep Zoom pyramid would need for the image's dimensions, computed purely
// from width/height, not evidence the tile host rendered that deep (level
// 21 at 1024px tiles is ~563,000 tiles for one floor). Zooming past the
// real coverage boundary made the exact-level tile 404, and WorldMap's
// drawMap simply skipped drawing anything for that rect -- terrain turned
// solid black over the dark canvas background while player/vehicle markers
// (drawn as separate vector passes, unaffected by tile state) kept
// rendering fine. Pulled out of WorldMap.tsx as a pure function so the
// fallback-selection math can be unit tested without mounting the canvas.

// Conservative stand-in for renderedMaxLevel wherever the real discovered
// depth isn't known: the static placeholder configs in WorldMap.tsx (used
// before /api/map/resolve returns, e.g. on first paint every session), and
// its `??` fallback if a server response ever predates or fails discovery.
// Same known-safe floor hasTileCoverage/discoverRenderedMaxLevel use
// server-side (mapProxy.js). Deliberately fails CLOSED, same doctrine this
// codebase applies to server-state checks everywhere else: costing a user
// some zoom depth for a moment is nothing, showing them a black map is the
// bug GH#109 exists to fix. Falling back to the raw maxLevel instead would
// be exactly the inflated, never-actually-rendered ceiling this whole fix
// exists to stop trusting.
const CONSERVATIVE_LEVEL_OFFSET = 6;
export function conservativeRenderedMaxLevel(maxLevel: number): number {
  return Math.max(0, maxLevel - CONSERVATIVE_LEVEL_OFFSET);
}

export type TileCacheValue = HTMLImageElement | null | "empty" | undefined;

export interface FallbackTileDraw {
  parentLevel: number;
  parentCol: number;
  parentRow: number;
  img: HTMLImageElement;
  srcX: number;
  srcY: number;
  srcW: number;
  srcH: number;
}

// Walks up to `maxFallbackLevels` coarser levels looking for a cached,
// non-empty ancestor tile, and returns the sub-rectangle of it (in the
// ancestor image's own pixel space) that covers the same DZI-space area as
// the missing (level, col, row) tile -- the caller draws that rectangle
// stretched over the destination rect instead of leaving it untouched.
// `request` is called for every candidate level even when nothing is
// cached there yet, so a coarser tile nobody has otherwise asked for still
// gets loaded and is available as a fallback on a later redraw -- without
// this, a user who zooms straight past several levels never gets a
// fallback at all, since nothing else asks for non-current-level tiles.
export function resolveFallbackTile(
  level: number,
  col: number,
  row: number,
  lookup: (level: number, col: number, row: number) => TileCacheValue,
  request: (level: number, col: number, row: number) => void,
  maxFallbackLevels: number,
): FallbackTileDraw | null {
  for (let k = 1; k <= Math.min(level, maxFallbackLevels); k++) {
    const parentLevel = level - k;
    const step = 2 ** k;
    const parentCol = Math.floor(col / step);
    const parentRow = Math.floor(row / step);

    request(parentLevel, parentCol, parentRow);
    const img = lookup(parentLevel, parentCol, parentRow);
    if (!img || img === "empty") continue;

    // The ancestor tile's image covers `step`x`step` finer tiles' worth of
    // DZI area, so our target is one (1/step)-sized sub-rectangle of it.
    const fracCol = col - parentCol * step;
    const fracRow = row - parentRow * step;
    const srcW = img.naturalWidth / step;
    const srcH = img.naturalHeight / step;
    return {
      parentLevel,
      parentCol,
      parentRow,
      img,
      srcX: fracCol * srcW,
      srcY: fracRow * srcH,
      srcW,
      srcH,
    };
  }
  return null;
}
