import { describe, expect, it, vi } from "vitest";
import { conservativeRenderedMaxLevel, resolveFallbackTile } from "../worldMapTileFallback";


function fakeImg(naturalWidth = 1024, naturalHeight = 1024) {
  return { naturalWidth, naturalHeight } as unknown as HTMLImageElement;
}

describe("resolveFallbackTile", () => {
  it("reproduces the black-out: returns null when no ancestor tile is cached anywhere -- nothing to fall back to", () => {
    const lookup = vi.fn(() => undefined);
    const request = vi.fn();

    const result = resolveFallbackTile(13, 101, 57, lookup, request, 8);

    expect(result).toBeNull();
    // Without a fix, this is exactly the state that produced GH#109: the
    // caller has no fallback and (pre-fix) drew nothing for the rect.
  });

  it("falls back to the immediate parent level (k=1) when it's cached and non-empty", () => {
    const parentImg = fakeImg();
    const lookup = vi.fn((level: number, col: number, row: number) =>
      level === 12 && col === 50 && row === 28 ? parentImg : undefined,
    );
    const request = vi.fn();

    const result = resolveFallbackTile(13, 101, 57, lookup, request, 8);

    expect(result).not.toBeNull();
    expect(result?.parentLevel).toBe(12);
    expect(result?.parentCol).toBe(50);
    expect(result?.parentRow).toBe(28);
    expect(result?.img).toBe(parentImg);
  });

  it("computes the correct source sub-rectangle within the coarser tile's own image", () => {
    const parentImg = fakeImg(1024, 1024);
    const lookup = vi.fn(() => parentImg);
    const request = vi.fn();

    const result = resolveFallbackTile(13, 101, 57, lookup, request, 8);

    expect(result).toEqual(
      expect.objectContaining({
        srcX: 512,
        srcY: 512,
        srcW: 512,
        srcH: 512,
      }),
    );
  });

  it("skips a confirmed-empty ancestor and keeps searching a coarser level", () => {
    const grandparentImg = fakeImg();
    const lookup = vi.fn((level: number) => {
      if (level === 12) return "empty" as const;
      if (level === 11) return grandparentImg;
      return undefined;
    });
    const request = vi.fn();

    const result = resolveFallbackTile(13, 101, 57, lookup, request, 8);

    expect(result?.parentLevel).toBe(11);
    expect(result?.img).toBe(grandparentImg);
  });

  it("requests every candidate level even when nothing is cached yet, so a coarser tile eventually loads for a later redraw", () => {
    const lookup = vi.fn(() => undefined);
    const request = vi.fn();

    resolveFallbackTile(5, 10, 6, lookup, request, 8);

    expect(request).toHaveBeenCalledTimes(5);
    expect(request).toHaveBeenNthCalledWith(1, 4, 5, 3);
    expect(request).toHaveBeenNthCalledWith(5, 0, 0, 0);
  });

  it("never walks past maxFallbackLevels even when level is deep", () => {
    const lookup = vi.fn(() => undefined);
    const request = vi.fn();

    resolveFallbackTile(20, 1000, 1000, lookup, request, 3);

    expect(request).toHaveBeenCalledTimes(3);
  });

  it("never walks below level 0 when the requested level is shallower than maxFallbackLevels", () => {
    const lookup = vi.fn(() => undefined);
    const request = vi.fn();

    resolveFallbackTile(2, 3, 1, lookup, request, 8);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, 0, 0, 0);
  });
});

describe("conservativeRenderedMaxLevel", () => {
  it("subtracts the known-safe offset from maxLevel", () => {
    expect(conservativeRenderedMaxLevel(21)).toBe(15);
    expect(conservativeRenderedMaxLevel(22)).toBe(16);
  });

  it("never goes negative for a small maxLevel", () => {
    expect(conservativeRenderedMaxLevel(3)).toBe(0);
    expect(conservativeRenderedMaxLevel(0)).toBe(0);
  });

  it("is always strictly less than maxLevel for any real build depth, never equal to it", () => {
    for (const maxLevel of [10, 15, 21, 22, 30]) {
      expect(conservativeRenderedMaxLevel(maxLevel)).toBeLessThan(maxLevel);
    }
  });
});
