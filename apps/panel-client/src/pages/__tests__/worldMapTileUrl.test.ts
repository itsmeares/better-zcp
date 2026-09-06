import { describe, expect, it } from 'vitest'
import { buildTileQuery } from '../worldMapTileUrl'


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
