export const UNCOMPRESSED_BINARY_PROXY_PREFIXES = [
  "/api/map/tiles/",
  "/api/map/toptiles/",
  "/api/map/b41tiles/",
  "/api/mods/thumbnail/",
];

interface PathRequest {
  path: string;
}

interface ResponseHeaders {
  getHeader(name: string): unknown;
}

export function isUncompressedBinaryProxyPath(req: PathRequest): boolean {
  return UNCOMPRESSED_BINARY_PROXY_PREFIXES.some((prefix) =>
    req.path.startsWith(prefix),
  );
}

export function isEventStreamResponse(res: ResponseHeaders): boolean {
  const contentType = res.getHeader("Content-Type");
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0].trim() === "text/event-stream";
}
