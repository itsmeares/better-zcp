// <img>-tag-loaded binary proxy routes (map tiles, mod thumbnails -- see
// services/auth.js's own comment grouping these as the same "loaded via
// <img>, no auth headers" category). Their bytes are already-compressed
// JPEG/PNG: gzipping them again buys near-zero size reduction, and forces
// Express to drop Content-Length in favour of chunked transfer encoding
// purely to save a few bytes it can't actually save -- extra surface for a
// misbehaving reverse proxy to get wrong for zero upside. If a proxy strips
// or mishandles Content-Encoding on a chunked response, the browser can end
// up decoding the still-gzip'd bytes directly as an image and fail (see
// apps/panel-client/src/pages/WorldMap.tsx's loadViaProxy, which detects and reports
// this specific case client-side).
export const UNCOMPRESSED_BINARY_PROXY_PREFIXES = [
  "/api/map/tiles/",
  "/api/map/toptiles/",
  "/api/map/b41tiles/",
  "/api/mods/thumbnail/",
];

// req is anything with a `.path` string (a real Express req, or a plain
// { path } object in a unit test) -- kept minimal so this stays testable
// without spinning up an app.
export function isUncompressedBinaryProxyPath(req) {
  return UNCOMPRESSED_BINARY_PROXY_PREFIXES.some((prefix) => req.path.startsWith(prefix));
}
