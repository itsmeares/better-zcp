
export function buildTileQuery(floor: number, versionDir: string | null): string {
  const floorParam = floor !== 0 ? `floor=${floor}` : "";
  const versionParam = versionDir ? `v=${encodeURIComponent(versionDir)}` : "";
  const params = [floorParam, versionParam].filter(Boolean).join("&");
  return params ? `?${params}` : "";
}
