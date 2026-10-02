import type { WorldMapCoverage, WorldMapInfo, WorldMapLayer, WorldMapPoint } from '@/lib/api'

export type LayerCoverageLookup = Map<string, Map<string, number[]>>

export function worldToImage(
  point: WorldMapPoint,
  layer: WorldMapLayer,
): { x: number; y: number } {
  return {
    x: (layer.x0 + (point.x - point.y) * layer.sqr / 2) / layer.scale,
    y: (layer.y0 + (point.x + point.y) * layer.sqr / 4 - 1.5 * point.z * layer.sqr) / layer.scale,
  }
}

export function imageToWorld(
  point: { x: number; y: number },
  layer: WorldMapLayer,
  z: number,
): WorldMapPoint {
  const dx = point.x * layer.scale - layer.x0
  const dy = point.y * layer.scale - layer.y0 + 1.5 * z * layer.sqr
  return {
    x: (dx + 2 * dy) / layer.sqr,
    y: (2 * dy - dx) / layer.sqr,
    z,
  }
}

export function placeLayer(layer: WorldMapLayer, base: WorldMapLayer) {
  const ratio = (base.sqr / base.scale) / (layer.sqr / layer.scale)
  return {
    x: (base.x0 / base.scale - layer.x0 / layer.scale * ratio) / base.width,
    y: (base.y0 / base.scale - layer.y0 / layer.scale * ratio) / base.width,
    width: layer.width * ratio / base.width,
    height: layer.height * ratio / base.width,
  }
}

export function buildTileUrl(
  layer: WorldMapLayer,
  floor: number,
  level: number,
  x: number,
  y: number,
  format = layer.format,
): string {
  return `${layer.tileRoot}layer${floor}_files/${level}/${x}_${y}.${format}`
}

export function indexLayerCoverage(coverage: WorldMapCoverage): LayerCoverageLookup {
  const tilesByLevel = new Map<string, Map<string, Set<number>>>()
  for (const [level, floors] of Object.entries(coverage.levels)) {
    if (!/^\d+$/.test(level)) continue
    const tiles = new Map<string, Set<number>>()
    for (const [floor, coordinates] of Object.entries(floors)) {
      if (!/^-?\d+$/.test(floor) || !Array.isArray(coordinates)) continue
      const floorNumber = Number(floor)
      for (const coordinate of coordinates) {
        if (!Array.isArray(coordinate) || coordinate.length !== 2) continue
        const [x, y] = coordinate
        if (!Number.isInteger(x) || x < 0 || !Number.isInteger(y) || y < 0) continue
        const key = `${x},${y}`
        const available = tiles.get(key) ?? new Set<number>()
        available.add(floorNumber)
        tiles.set(key, available)
      }
    }
    tilesByLevel.set(level, tiles)
  }
  return new Map(
    [...tilesByLevel].map(([level, tiles]) => [
      level,
      new Map([...tiles].map(([tile, floors]) => [tile, [...floors].sort((a, b) => a - b)])),
    ]),
  )
}

export function mapCoverageIsValid(value: unknown): value is WorldMapCoverage {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<WorldMapCoverage>
  if (!Number.isInteger(candidate.ground) || !candidate.levels || typeof candidate.levels !== 'object') {
    return false
  }
  return Object.entries(candidate.levels).every(([level, floors]) =>
    /^\d+$/.test(level) && !!floors && typeof floors === 'object' &&
    Object.entries(floors).every(([floor, coordinates]) =>
      /^-?\d+$/.test(floor) && Array.isArray(coordinates) && coordinates.every((coordinate) =>
        Array.isArray(coordinate) && coordinate.length === 2 &&
        Number.isInteger(coordinate[0]) && coordinate[0] >= 0 &&
        Number.isInteger(coordinate[1]) && coordinate[1] >= 0,
      ),
    ),
  )
}

export function tileFloorFor(
  coverage: LayerCoverageLookup,
  ground: number,
  selectedFloor: number,
  level: number,
  x: number,
  y: number,
): number | null {
  const available = coverage.get(String(level))?.get(`${x},${y}`)
  return available ? tileFloorFromAvailable(available, ground, selectedFloor) : null
}

export function availableTileFloors(
  coverage: LayerCoverageLookup,
  ground: number,
  selectedFloor: number,
): number[] {
  const available = new Set<number>()
  for (const tiles of coverage.values()) {
    for (const floors of tiles.values()) {
      const floor = tileFloorFromAvailable(floors, ground, selectedFloor)
      if (floor !== null) available.add(floor)
    }
  }
  return [...available].sort((a, b) => a - b)
}

export function layerClipPolygons(layer: WorldMapLayer, floor: number): Array<Array<{ x: number; y: number }>> {
  return layer.cellRects.map(([cellX, cellY, width, height]) => [
    worldToImage({ x: cellX * layer.cellSize, y: cellY * layer.cellSize, z: floor }, layer),
    worldToImage({ x: (cellX + width) * layer.cellSize, y: cellY * layer.cellSize, z: floor }, layer),
    worldToImage({ x: (cellX + width) * layer.cellSize, y: (cellY + height) * layer.cellSize, z: floor }, layer),
    worldToImage({ x: cellX * layer.cellSize, y: (cellY + height) * layer.cellSize, z: floor }, layer),
  ])
}

function tileFloorFromAvailable(available: number[], ground: number, selectedFloor: number): number | null {
  if (selectedFloor < ground) {
    return available.includes(selectedFloor) ? selectedFloor : null
  }
  let closest: number | null = null
  for (const floor of available) {
    if (floor < ground || floor > selectedFloor) continue
    if (closest === null || floor > closest) closest = floor
  }
  return closest
}

export function normalizeMapSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase().trim()
}

export function layersForFloor(layers: WorldMapLayer[], floor: number): WorldMapLayer[] {
  return layers.filter((layer) => floor >= layer.minFloor && floor <= layer.maxFloor)
}

export function mapFloorRange(layers: WorldMapLayer[]): { min: number; max: number } {
  if (layers.length === 0) return { min: 0, max: 0 }
  return {
    min: Math.min(...layers.map((layer) => layer.minFloor)),
    max: Math.max(...layers.map((layer) => layer.maxFloor)),
  }
}

export function mapMetadataIsValid(info: unknown): info is WorldMapInfo {
  if (!info || typeof info !== 'object') return false
  const candidate = info as Partial<WorldMapInfo>
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.label === 'string' &&
    Array.isArray(candidate.mapOrder) && candidate.mapOrder.every((map) => typeof map === 'string') &&
    Array.isArray(candidate.warnings) && candidate.warnings.every((warning) => typeof warning === 'string') &&
    Array.isArray(candidate.layers) &&
    candidate.layers.every((layer) => {
      if (!layer || typeof layer !== 'object') return false
      const item = layer as WorldMapLayer
      return (
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        safeTileRoot(item.tileRoot) &&
        Number.isFinite(item.width) && item.width > 0 &&
        Number.isFinite(item.height) && item.height > 0 &&
        Number.isInteger(item.tileSize) && item.tileSize > 0 &&
        typeof item.format === 'string' && /^[a-z0-9]+$/i.test(item.format) &&
        Number.isFinite(item.sqr) && item.sqr > 0 &&
        Number.isFinite(item.scale) && item.scale > 0 &&
        Number.isFinite(item.x0) &&
        Number.isFinite(item.y0) &&
        typeof item.composite === 'boolean' &&
        Number.isInteger(item.cellSize) && item.cellSize > 0 &&
        Array.isArray(item.cellRects) && item.cellRects.every((rect) =>
          Array.isArray(rect) && rect.length === 4 &&
          rect.every((value) => Number.isInteger(value)) &&
          rect[2] > 0 && rect[3] > 0,
        ) &&
        Number.isInteger(item.minFloor) &&
        Number.isInteger(item.maxFloor) &&
        item.minFloor <= item.maxFloor
      )
    })
  )
}

function safeTileRoot(value: unknown): boolean {
  if (typeof value !== 'string') return false
  if (!value.endsWith('/')) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch {
    return false
  }
}
