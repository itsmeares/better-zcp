import { describe, expect, it } from 'vite-plus/test'
import { fromLngLat, toLngLat } from '../map/coords'

describe('world map coordinates', () => {
  it('round-trips game squares through map coordinates', () => {
    for (const [x, y] of [[0, 0], [10623, 9693], [19968, 16128]]) {
      const back = fromLngLat(...toLngLat(x, y))
      expect(back.x).toBeCloseTo(x, 6)
      expect(back.y).toBeCloseTo(y, 6)
    }
  })

  it('puts the game origin at the top-left corner of the map world', () => {
    const [lng, lat] = toLngLat(0, 0)
    expect(lng).toBe(-180)
    expect(lat).toBeCloseTo(85.0511, 3)
  })
})
