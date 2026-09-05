import type { MapConfig } from './WorldMap'

// detectServerVersion's "skip if nothing
// changed" guard used to compare a hand-picked field LIST (label, tileSize,
// fullWidth, isoX0, isoY0) instead of the whole config. That list was
// widened once already, from a label-only check to those five geometry
// fields, specifically to fix an earlier version of this same class of bug
// -- but "geometry" was the wrong category to widen to: renderedMaxLevel
// and maxLevel are DERIVED, not geometry, so they sat outside the list by
// construction, and fullHeight was simply never added. The next omission
// was pre-arranged the moment the guard became a list instead of "every
// field this type has": a real server resolve whose width/height/tileSize/
// origin happen to numerically match MAP_B42's own hardcoded placeholder
// (plausible whenever the resolved build is the common one the placeholder
// was modeled on) makes every listed field match, the guard fires, and the
// REAL discovered renderedMaxLevel is silently discarded in favor of the
// placeholder's much deeper conservativeRenderedMaxLevel(21) = 15 --
// confirmed live: tiles requested at level 15 came back real 404s (5 levels
// past the actual renderedMaxLevel of 10), and the gap persisted
// indefinitely, not just until a redraw.
//
// Fixed by comparing every own key MapConfig has, read generically via
// Object.keys rather than named one at a time, so a field added to the
// interface later is included automatically instead of needing whoever
// adds it to also remember this comparison exists. Keys are read from BOTH
// a and b (union, not just a's keys): with only a's keys, a key present on
// b and absent on a would never be examined, so an optional field added to
// MapConfig later could compare absent-vs-present as equal -- the exact
// hole this file exists to close, one level up. defaultCenter is the only
// non-primitive field (an {x,y} point), compared by value. Pulled out of
// WorldMap.tsx as a pure function so this comparison is unit-testable
// without mounting the canvas -- same reasoning as worldMapTileFallback.ts
// and worldMapTileUrl.ts.
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
