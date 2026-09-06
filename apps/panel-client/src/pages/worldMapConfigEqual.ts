import type { MapConfig } from './WorldMap'

export function mapConfigsEqual(a: MapConfig, b: MapConfig): boolean {
  const keys = new Set<keyof MapConfig>([
    ...(Object.keys(a) as (keyof MapConfig)[]),
    ...(Object.keys(b) as (keyof MapConfig)[]),
  ])
  return Array.from(keys).every((key) => {
    if (key === 'defaultCenter') {
      return a.defaultCenter?.x === b.defaultCenter?.x && a.defaultCenter?.y === b.defaultCenter?.y
    }
    return a[key] === b[key]
  })
}
