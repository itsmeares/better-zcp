import { describe, expect, it } from 'vitest'
import {
  diagnoseTileFailure,
  tileFailureCopy,
} from '../worldMapTileFailureDiagnosis'

describe('map tile failure diagnosis', () => {
  it('distinguishes a truncated JPEG from a corrupt complete JPEG', () => {
    const truncated = diagnoseTileFailure(
      new Uint8Array([0xff, 0xd8, 0xff]),
      25,
      '100',
    )
    expect(tileFailureCopy(truncated)).toEqual({
      title: 'Map tile was cut short in transit',
      description:
        'Only 25 of 100 bytes arrived. The connection was cut short in transit.',
    })

    const corrupt = diagnoseTileFailure(
      new Uint8Array([0xff, 0xd8, 0xff]),
      100,
      '100',
    )
    expect(tileFailureCopy(corrupt).title).toBe('Map tile data is corrupted')
  })

  it('reports unrecognized bytes instead of guessing a format', () => {
    const diagnosis = diagnoseTileFailure(new Uint8Array([0x12, 0x34]), 2, null)
    expect(tileFailureCopy(diagnosis)).toEqual({
      title: 'Map tile arrived as unrecognized data',
      description: 'Raw bytes: 12 34',
    })
  })
})
