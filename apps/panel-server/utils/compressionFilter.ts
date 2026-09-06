export const UNCOMPRESSED_BINARY_PROXY_PREFIXES = [
  "/api/map/tiles/",
  "/api/map/toptiles/",
  "/api/map/b41tiles/",
  "/api/mods/thumbnail/",
];

interface PathRequest {
  path: string;
}

export function isUncompressedBinaryProxyPath(req: PathRequest): boolean {
  return UNCOMPRESSED_BINARY_PROXY_PREFIXES.some((prefix) =>
    req.path.startsWith(prefix),
  );
}
