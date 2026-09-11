export const MAP_SCAN_TTL_MS = 3000;
export const mapScanCache = new Map<string, { result: any; at: number }>();
export const mapScanInflight = new Map<string, Promise<any>>();

export function invalidateMapFolderScan(mapPath: string): void {
  mapScanCache.delete(mapPath);
}
