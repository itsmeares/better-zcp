// Include the resolved B42 build in the tile URL so browser caches cannot
// reuse a tile from a different map build. This pure query-string helper is
// kept separate so it can be tested without mounting the map canvas.

// `floor` is a query param on THIS proxy route specifically (not a path
// segment -- see buildDirectTileUrl's own comment in WorldMap.tsx), and
// only ever included when non-default (matches the pre-existing
// behaviour, unrelated to this change). `versionDir` is the resolved B42
// build directory, or null when it isn't known yet (before /api/map/resolve
// completes) or doesn't apply (B41, whose upstream directory is a fixed
// literal, never dynamically resolved -- nothing to version).
export function buildTileQuery(floor: number, versionDir: string | null): string {
  const floorParam = floor !== 0 ? `floor=${floor}` : "";
  const versionParam = versionDir ? `v=${encodeURIComponent(versionDir)}` : "";
  const params = [floorParam, versionParam].filter(Boolean).join("&");
  return params ? `?${params}` : "";
}
