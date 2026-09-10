import { describe, expect, it } from "vitest";
import {
  isEventStreamResponse,
  isUncompressedBinaryProxyPath,
  UNCOMPRESSED_BINARY_PROXY_PREFIXES,
} from "../utils/compressionFilter.ts";


describe("isUncompressedBinaryProxyPath", () => {
  it("excludes all four <img>-tag-loaded binary proxy prefixes", () => {
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/tiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/toptiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/b41tiles/12/3_4.jpg" })).toBe(true);
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/thumbnail/1234567890" })).toBe(true);
  });

  it("does not exclude ordinary JSON API routes", () => {
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/status" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/geometry" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/servers" })).toBe(false);
  });

  it("does not exclude a path that merely starts similarly but isn't the real prefix", () => {
    expect(isUncompressedBinaryProxyPath({ path: "/api/map/tilesetcetera" })).toBe(false);
    expect(isUncompressedBinaryProxyPath({ path: "/api/mods/thumbnails" })).toBe(false);
  });

  it("keeps the prefix list exactly as documented -- a change here is a deliberate change to what stays uncompressed", () => {
    expect(UNCOMPRESSED_BINARY_PROXY_PREFIXES).toEqual([
      "/api/map/tiles/",
      "/api/map/toptiles/",
      "/api/map/b41tiles/",
      "/api/mods/thumbnail/",
    ]);
  });
});

describe("isEventStreamResponse", () => {
  it("recognizes an SSE content type with optional parameters", () => {
    expect(isEventStreamResponse({ getHeader: () => "text/event-stream; charset=utf-8" })).toBe(true);
  });

  it("does not disable compression for ordinary text or missing headers", () => {
    expect(isEventStreamResponse({ getHeader: () => "text/plain" })).toBe(false);
    expect(isEventStreamResponse({ getHeader: () => undefined })).toBe(false);
  });
});
