import { describe, expect, it } from 'vitest'
import { buildTileQuery } from '../worldMapTileUrl'

// hunt-wave12-2026-08-30 (version-the-tile-url-by-resolved-b42-build): pure
// unit tests for the query-string half of the fix, pulled out of
// WorldMap.tsx/ChunkCleaner.tsx for the same reason worldMapTileFallback.ts
// was -- both files' actual tile-loading call sites (loadDziTile) are only
// ever reached from their canvas draw loop, which bails out immediately
// (`if (!ctx) return`) whenever canvas.getContext('2d') is unavailable --
// which is jsdom's default with no `canvas` package installed, confirmed
// via WorldMap.tsx:1441 and ChunkCleaner.tsx:977. A full-render integration
// test can never observe the resulting fetch()/img.src call in this
// environment; this pure function is the actually-reachable unit of the
// fix.

describe('buildTileQuery', () => {
  it('returns an empty string when floor is default (0) and no build directory is known yet', () => {
    expect(buildTileQuery(0, null)).toBe('')
  })

  it('includes only `v` when floor is default but the build directory is known', () => {
    expect(buildTileQuery(0, '42.20.0')).toBe('?v=42.20.0')
  })

  it('includes only `floor` when the build directory is not known (e.g. before /api/map/resolve completes, or B41)', () => {
    expect(buildTileQuery(3, null)).toBe('?floor=3')
  })

  it('includes both, floor first, joined with &, when both are present', () => {
    expect(buildTileQuery(-1, '42.20.0')).toBe('?floor=-1&v=42.20.0')
  })

  it('URL-encodes the build directory value', () => {
    // Real B42 directories are plain version strings (e.g. "42.20.0"), but
    // the value ultimately comes from an upstream JSON response (see
    // mapProxy.js's isB42PlusCandidate) -- prove encoding actually runs
    // rather than relying on real-world values never needing it.
    expect(buildTileQuery(0, '42.20.0 test&v=x')).toBe(
      `?v=${encodeURIComponent('42.20.0 test&v=x')}`,
    )
  })

  it('a basement floor (negative) is still included', () => {
    expect(buildTileQuery(-17, null)).toBe('?floor=-17')
  })

  it('an empty-string directory is treated the same as null -- no `v` emitted', () => {
    expect(buildTileQuery(0, '')).toBe('')
  })
})
