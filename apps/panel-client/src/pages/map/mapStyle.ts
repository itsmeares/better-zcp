import type { ExpressionSpecification, GeoJSONSourceSpecification, Map as MapLibreMap, StyleSpecification } from 'maplibre-gl'
import type { WorldMapFeatures, WorldMapManifest } from '@/lib/api'
import { toLngLat } from './coords'

type Collection = Extract<GeoJSONSourceSpecification['data'], { type: 'FeatureCollection' }>
type Feature = Collection['features'][number]

// No glyph server: MapLibre draws text with these local font families.
const FONT = ['sans-serif']
const FONT_BOLD = ['Noto Sans Bold']
export const EMPTY: Collection = { type: 'FeatureCollection', features: [] }

const toRing = (ring: Array<[number, number]>) => ring.map(([x, y]) => toLngLat(x, y))

export function featuresToLngLat(data: WorldMapFeatures): Collection {
  return {
    type: 'FeatureCollection',
    features: data.features.map((feature): Feature => ({
      type: 'Feature',
      properties: feature.properties,
      geometry: feature.geometry.type === 'Polygon'
        ? { type: 'Polygon', coordinates: feature.geometry.coordinates.map(toRing) }
        : feature.geometry.type === 'LineString'
          ? { type: 'LineString', coordinates: toRing(feature.geometry.coordinates) }
          : { type: 'Point', coordinates: toLngLat(...feature.geometry.coordinates) },
    })),
  }
}

const ROOM_GROUPS: Array<[string, RegExp]> = [
  ['services', /police|fire|medic|hospital|clinic|school|church|class|gov|prison|cell|military|army/],
  ['commercial', /office|bank|vault|deposit|store|shop|grocer|restaurant|kitchen_?rest|bar|cafe|diner|pharm|mall|motel|hotel|gas|cashier|counter/],
  ['storage', /storage|garage|warehouse|shed|basement|janitor|boiler|utility|closet|mechanic|factory|tool/],
  ['living', /bed|living|kitchen|dining|bath|laundry|hall|room|den|study|lounge/],
]

export function roomGroup(name: string): string {
  const lower = name.toLowerCase()
  return ROOM_GROUPS.find(([, pattern]) => pattern.test(lower))?.[0] ?? 'other'
}

export function roomsToLngLat(rooms: Array<[string, Array<[number, number, number, number]>]>): Collection {
  return {
    type: 'FeatureCollection',
    features: rooms.flatMap(([name, rects]) => rects.map(([x, y, w, h], index): Feature => ({
      type: 'Feature',
      // Only the first rectangle of a room carries its name, so a label shows once.
      properties: { name: index === 0 ? name : '', group: roomGroup(name) },
      geometry: { type: 'Polygon', coordinates: [toRing([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]])] },
    }))),
  }
}

/** Runs of equal-density chunks, [x, y, length, value] in chunk units, as rectangles. */
export function densityToLngLat({ chunk, runs }: { chunk: number; runs: number[] }): Collection {
  const features: Feature[] = []
  for (let index = 0; index + 3 < runs.length; index += 4) {
    const [x, y, length, value] = runs.slice(index, index + 4)
    const left = x * chunk
    const top = y * chunk
    const right = left + length * chunk
    const bottom = top + chunk
    features.push({
      type: 'Feature',
      properties: { value },
      geometry: { type: 'Polygon', coordinates: [toRing([[left, top], [right, top], [right, bottom], [left, bottom], [left, top]])] },
    })
  }
  return { type: 'FeatureCollection', features }
}

const kind = (value: string): ExpressionSpecification => ['==', ['get', 'kind'], value]

export function createMapStyle(manifest: WorldMapManifest, tileUrl: (folder: number) => string): StyleSpecification {
  const imageFolders = manifest.folders.filter((folder) => folder.image).reverse()
  return {
    version: 8,
    sources: {
      features: { type: 'geojson', data: EMPTY },
      rooms: { type: 'geojson', data: EMPTY },
      density: { type: 'geojson', data: EMPTY },
      highlight: { type: 'geojson', data: EMPTY },
      players: { type: 'geojson', data: EMPTY },
      ...Object.fromEntries(imageFolders.map((folder) => [`image-${folder.id}`, {
        type: 'raster' as const,
        tiles: [tileUrl(folder.id)],
        tileSize: 256,
        minzoom: folder.image!.minZoom,
        maxzoom: folder.image!.maxZoom,
      }])),
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#14130f' } },
      // Drawn from worldmap.xml under the game images, so they only show where a map has no image.
      { id: 'base-water', type: 'fill', source: 'features', filter: kind('water'), paint: { 'fill-color': '#2c4450' } },
      { id: 'base-roads', type: 'fill', source: 'features', filter: ['all', kind('highway'), ['==', ['geometry-type'], 'Polygon']], paint: { 'fill-color': ['match', ['get', 'value'], 'trail', '#3d3a31', '#57534b'] } },
      { id: 'base-rail', type: 'line', source: 'features', filter: kind('railway'), paint: { 'line-color': '#6b5444', 'line-width': 1.5 } },
      {
        id: 'base-buildings', type: 'fill', source: 'features', filter: kind('building'), paint: {
          'fill-color': ['match', ['get', 'value'],
            'Residential', '#857760', 'Industrial', '#6a727c', 'RetailAndCommercial', '#957049',
            'RestaurantsAndEntertainment', '#9a5d50', 'CommunityServices', '#6b8455', '#746c62'],
        },
      },
      ...imageFolders.map((folder) => ({
        id: `image-${folder.id}`, type: 'raster' as const, source: `image-${folder.id}`,
        paint: { 'raster-resampling': 'nearest' as const, 'raster-fade-duration': 0 },
      })),
      {
        id: 'building-outline', type: 'line', source: 'features', minzoom: 8.5, filter: kind('building'),
        paint: { 'line-color': '#f3e3c0', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, 0.5], 'line-width': 1 },
      },
      {
        id: 'rooms-fill', type: 'fill', source: 'rooms', paint: {
          'fill-color': ['match', ['get', 'group'],
            'living', '#c9ad78', 'commercial', '#d48552', 'storage', '#8a95a3', 'services', '#7fae6a', '#b39ab3'],
          'fill-opacity': 0,
        },
      },
      { id: 'rooms-outline', type: 'line', source: 'rooms', minzoom: 9, paint: { 'line-color': '#1c1813', 'line-width': 1, 'line-opacity': 0 } },
      {
        id: 'density', type: 'fill', source: 'density', layout: { visibility: 'none' }, paint: {
          // The game's zombie density is 0-10 per 8x8 chunk; most chunks hold 1-3.
          'fill-color': ['interpolate', ['linear'], ['get', 'value'], 1, '#f2cf4a', 3, '#e8762c', 6, '#c41e2a'],
          'fill-opacity': ['interpolate', ['linear'], ['get', 'value'], 1, 0.18, 4, 0.5],
          'fill-antialias': false,
        },
      },
      {
        id: 'rooms-label', type: 'symbol', source: 'rooms', minzoom: 10.5, filter: ['all', ['!=', ['get', 'name'], ''], ['!', ['in', 'empty', ['get', 'name']]]],
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11, 'text-max-width': 6 },
        paint: { 'text-color': '#16130f', 'text-halo-color': 'rgba(245,235,215,0.6)', 'text-halo-width': 1, 'text-opacity': 0 },
      },
      {
        id: 'street-labels', type: 'symbol', source: 'features', minzoom: 8, filter: kind('street'),
        layout: {
          'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': FONT,
          'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 11, 14], 'symbol-spacing': 400,
        },
        paint: { 'text-color': '#f4efe4', 'text-halo-color': 'rgba(10,9,7,0.85)', 'text-halo-width': 1.6 },
      },
      {
        id: 'place-labels', type: 'symbol', source: 'features', filter: kind('label'),
        layout: {
          'text-field': ['get', 'name'], 'text-font': FONT_BOLD, 'text-rotate': ['get', 'rotation'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 3, ['*', 9, ['get', 'scale']], 8, ['*', 16, ['get', 'scale']]],
          'text-letter-spacing': 0.08, 'text-max-width': 12,
        },
        paint: {
          'text-color': ['case', ['in', 'water', ['get', 'layer']], '#a9cbe0', '#fbf6ea'],
          'text-halo-color': 'rgba(10,9,7,0.85)', 'text-halo-width': 1.8,
        },
      },
      {
        id: 'highlight', type: 'circle', source: 'highlight', paint: {
          'circle-radius': 14, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#e8f2d6', 'circle-stroke-width': 2.5,
        },
      },
      {
        id: 'players', type: 'circle', source: 'players', paint: {
          'circle-radius': ['case', ['get', 'selected'], 8, 6],
          'circle-color': ['match', ['get', 'state'], 'dead', '#8a8580', 'infected', '#e0524a', 'staff', '#e0a640', '#5fb0e0'],
          'circle-stroke-color': '#0b0a08', 'circle-stroke-width': 2,
          'circle-opacity': ['case', ['get', 'here'], 1, 0.4],
          'circle-stroke-opacity': ['case', ['get', 'here'], 1, 0.4],
        },
      },
      {
        id: 'player-labels', type: 'symbol', source: 'players',
        layout: {
          'text-field': ['get', 'label'], 'text-font': FONT_BOLD, 'text-size': 12, 'text-offset': [0, -1.4],
          'text-anchor': 'bottom', 'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6,
          'text-opacity': ['case', ['get', 'here'], 1, 0.55],
        },
      },
    ],
  }
}

/** Ground floor shows the game image; other floors dim it and draw that floor's rooms solid. */
export function applyFloorStyle(map: MapLibreMap, manifest: WorldMapManifest, floor: number): void {
  const ground = floor === 0
  for (const folder of manifest.folders) {
    if (!folder.image) continue
    map.setPaintProperty(`image-${folder.id}`, 'raster-opacity', ground ? 1 : 0.28)
    map.setPaintProperty(`image-${folder.id}`, 'raster-saturation', ground ? 0 : -0.8)
  }
  for (const id of ['base-water', 'base-roads', 'base-buildings']) map.setPaintProperty(id, 'fill-opacity', ground ? 1 : 0.3)
  map.setPaintProperty('rooms-fill', 'fill-opacity', ground ? ['interpolate', ['linear'], ['zoom'], 9.5, 0, 11, 0.35] : 0.88)
  map.setPaintProperty('rooms-outline', 'line-opacity', ground ? ['interpolate', ['linear'], ['zoom'], 9.5, 0, 11, 0.6] : 0.9)
  map.setPaintProperty('rooms-label', 'text-opacity', ground ? ['interpolate', ['linear'], ['zoom'], 10.5, 0, 11.5, 1] : 1)
  map.setPaintProperty('building-outline', 'line-opacity', ground ? ['interpolate', ['linear'], ['zoom'], 8.5, 0, 10, 0.5] : 0.25)
}
