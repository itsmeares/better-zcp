// Game squares live in a Web Mercator world 2^15 squares wide. At zoom 7 one map
// tile covers 256 squares, which is exactly one tile of the game's pyramid.zip.
const WORLD = 2 ** 15

export function toLngLat(x: number, y: number): [number, number] {
  return [(x / WORLD) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI]
}

export function fromLngLat(lng: number, lat: number): { x: number; y: number } {
  const sin = Math.sin((lat * Math.PI) / 180)
  return {
    x: ((lng + 180) / 360) * WORLD,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * WORLD,
  }
}
