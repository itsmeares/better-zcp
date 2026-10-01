import { describe, expect, it } from 'vite-plus/test'
import type { WorldMapInfo, WorldMapLayer } from '@/lib/api'
import {
  imageToWorld,
  buildTileUrl,
  indexLayerCoverage,
  layerClipPolygons,
  availableTileFloors,
  layersForFloor,
  mapFloorRange,
  mapMetadataIsValid,
  placeLayer,
  tileFloorFor,
  worldToImage,
} from '../worldMapHelpers'

const base: WorldMapLayer = {
  id: 'base',
  name: 'Base',
  tileRoot: 'https://tiles.pzmap.org/42.20.0/base/',
  width: 2318656,
  height: 1019040,
  tileSize: 2048,
  format: 'jpg',
  x0: 1040384,
  y0: -139296,
  sqr: 128,
  scale: 1,
  minFloor: -17,
  maxFloor: 29,
  composite: true,
  cellSize: 300,
  cellRects: [],
}

describe('world map helpers', () => {
  it('builds tile paths using the resolved floor format', () => {
    expect(buildTileUrl(base, 2, 18, 101, 73, 'png'))
      .toBe('https://tiles.pzmap.org/42.20.0/base/layer2_files/18/101_73.png')
  })

  it('round trips projected coordinates on different floors', () => {
    for (const z of [-1, 0, 7]) {
      const image = worldToImage({ x: 10630, y: 9800, z }, base)
      expect(imageToWorld(image, base, z)).toEqual({ x: 10630, y: 9800, z })
    }
  })

  it('places an overlay using its world origin and scale', () => {
    const overlay = {
      ...base,
      id: 'RavenCreek',
      x0: 1040000,
      y0: -139100,
      sqr: 64,
      scale: 0.5,
    }
    const placement = placeLayer(overlay, base)
    expect(placement.width).toBeCloseTo(overlay.width / base.width)
    expect(placement.x).toBeCloseTo((base.x0 - overlay.x0 * 2) / base.width)
    expect(placement.y).toBeCloseTo((base.y0 - overlay.y0 * 2) / base.width)
  })

  it('uses the union of layer floors while hiding layers outside their floor range', () => {
    const groundLayer = { ...base, minFloor: -2, maxFloor: 2 }
    const upperLayer = { ...base, id: 'upper', minFloor: 2, maxFloor: 5 }
    const layers = [groundLayer, upperLayer]

    expect(mapFloorRange(layers)).toEqual({ min: -2, max: 5 })
    expect(layersForFloor(layers, 4)).toEqual([upperLayer])
    expect(layersForFloor(layers, 2)).toEqual(layers)
  })

  it('uses the requested composite floor or the nearest covered floor for each tile', () => {
    const coverage = indexLayerCoverage({
      ground: 0,
      levels: {
        '4': {
          '0': [[0, 0], [1, 0]],
          '1': [[0, 0]],
          '3': [[1, 0]],
          '-1': [[2, 0]],
        },
      },
    })

    expect(tileFloorFor(coverage, 0, 2, 4, 0, 0)).toBe(1)
    expect(tileFloorFor(coverage, 0, 2, 4, 1, 0)).toBe(0)
    expect(tileFloorFor(coverage, 0, 4, 4, 1, 0)).toBe(3)
    expect(tileFloorFor(coverage, 0, -1, 4, 2, 0)).toBe(-1)
    expect(tileFloorFor(coverage, 0, -1, 4, 0, 0)).toBeNull()
    expect(tileFloorFor(coverage, 0, 2, 4, 3, 0)).toBeNull()
    expect(availableTileFloors(coverage, 0, 2)).toEqual([0, 1])
  })

  it('projects mod cell clipping polygons at the selected floor', () => {
    const mod = { ...base, cellRects: [[2, 3, 4, 5] as [number, number, number, number]] }
    const ground = layerClipPolygons(mod, 0)[0]
    const upper = layerClipPolygons(mod, 2)[0]
    expect(ground).toEqual([
      worldToImage({ x: 600, y: 900, z: 0 }, mod),
      worldToImage({ x: 1800, y: 900, z: 0 }, mod),
      worldToImage({ x: 1800, y: 2400, z: 0 }, mod),
      worldToImage({ x: 600, y: 2400, z: 0 }, mod),
    ])
    expect(upper[0].y).toBeCloseTo(ground[0].y - 3 * mod.sqr / mod.scale)
  })

  it('accepts an explicit no-renderable-layer response and rejects unsafe tile roots', () => {
    const info: WorldMapInfo = {
      version: 'live',
      label: 'Current provider map',
      layers: [],
      mapOrder: ['Unsupported Map'],
      warnings: ['No configured map layer can be rendered.'],
    }
    expect(mapMetadataIsValid(info)).toBe(true)
    expect(mapMetadataIsValid({ ...info, layers: [{ ...base, tileRoot: 'http://tiles.example/' }] })).toBe(false)
    expect(mapMetadataIsValid({ ...info, layers: [{ ...base, cellRects: [[0, 0, 0, 2]] }] })).toBe(false)
  })
})
