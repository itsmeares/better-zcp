
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
