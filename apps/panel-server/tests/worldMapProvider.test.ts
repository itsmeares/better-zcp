import * as zlib from "node:zlib";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { getContext } = vi.hoisted(() => ({ getContext: vi.fn() }));
vi.mock("../services/sandboxPersistence.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/sandboxPersistence.ts")>()),
  getCurrentServerContext: getContext,
}));

const PZ_MAP_ROOT = "https://pzmap.org";
const PZ_TILES_ROOT = "https://tiles.pzmap.org";
const VERSION = "42.21.2";
let tempRoot: string;
let profileA: string;
let profileB: string;

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers });
}

function mapInfo(overrides: Record<string, unknown> = {}) {
  return {
    w: 2318656,
    h: 1019040,
    skip: 2,
    cell_size: 256,
    maxlayer: 30,
    minlayer: -17,
    tile_size: 2048,
    x0: 1040384,
    y0: -139296,
    sqr: 128,
    composite: true,
    cell_rects: [[0, 18, 45, 45], [45, 3, 13, 60], [58, 0, 20, 63]],
    ...overrides,
  };
}

function dzi(format = "jpg") {
  return `<?xml version="1.0"?><Image TileSize="2048" Overlap="0" Format="${format}"><Size Width="2318656" Height="1019040"/></Image>`;
}

function builds() {
  return {
    directory: VERSION,
    label: "Build 42.21",
    available: true,
    mod_maps: [
      { WestPointExpansion: "West Point Expansion" },
      { RavenCreek: "Raven Creek" },
    ],
  };
}

function baseMetadataFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const fixture = overrides[url];
    if (fixture !== undefined) return fixture instanceof Response ? fixture : response(fixture);
    if (url === `${PZ_MAP_ROOT}/api/builds/default`) return response(builds());
    if (url.startsWith(`${PZ_TILES_ROOT}/${VERSION}/`) && url.endsWith("map_info.json")) {
      const root = url.includes("/RavenCreek/") ? "raven" : url.includes("/WestPointExpansion/") ? "west" : "base";
      return response(mapInfo(root === "base" ? {} : {
        x0: root === "raven" ? 111 : 222,
        cell_rects: [[1, 2, 3, 4]],
      }));
    }
    if (url.startsWith(`${PZ_TILES_ROOT}/${VERSION}/`) && /\/layer-?\d+\.dzi$/.test(url)) {
      return response(dzi(url.endsWith("layer1.dzi") ? "webp" : "jpg"));
    }
    throw new Error(`Unexpected provider URL: ${url}; redirect=${init?.redirect}`);
  });
}

function makePzcr(cellX: number, cellY: number, cellSize: number, points: Array<[number, number, number]>): Buffer {
  const buffer = Buffer.alloc(15 + points.length * 3);
  buffer.write("PZCR", 0, "ascii");
  buffer.writeUInt8(1, 4);
  buffer.writeUInt16LE(cellX, 5);
  buffer.writeUInt16LE(cellY, 7);
  buffer.writeUInt16LE(cellSize, 9);
  buffer.writeUInt32LE(points.length, 11);
  points.forEach(([x, y, z], index) => {
    const offset = 15 + index * 3;
    buffer.writeUInt8(x, offset);
    buffer.writeUInt8(y, offset + 1);
    buffer.writeInt8(z, offset + 2);
  });
  return buffer;
}

function findRoute(router: any, routePath: string) {
  const entry = router.stack.find((item: any) => item.route?.path === routePath && item.route.methods.get);
  if (!entry) throw new Error(`No GET ${routePath} route`);
  return entry.route.stack.at(-1).handle;
}

function makeResponseRecorder() {
  let statusCode = 200;
  let body: any;
  const headers: Record<string, string> = {};
  return {
    headers,
    get statusCode() { return statusCode; },
    get body() { return body; },
    status(code: number) { statusCode = code; return this; },
    set(name: string, value: string) { headers[name] = value; return this; },
    json(value: unknown) { body = value; return this; },
  };
}

async function callRoute(routePath: string, query: Record<string, unknown> = {}) {
  vi.resetModules();
  const { default: router } = await import("../routes/worldMap.ts");
  const handler = findRoute(router, routePath);
  const res = makeResponseRecorder();
  await handler({ query, params: {} } as any, res as any, () => {});
  return res;
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "better-zcp-world-map-"));
  profileA = path.join(tempRoot, "profile-a");
  profileB = path.join(tempRoot, "profile-b");
  await Promise.all([fs.mkdir(profileA), fs.mkdir(profileB)]);
  await fs.writeFile(path.join(profileA, "A.ini"), "Map=OldMap;Muldraugh, KY\n");
  await fs.writeFile(path.join(profileB, "B.ini"), "Map=RavenCreek;Muldraugh, KY;West Point Expansion;MissingRegion\n");
  getContext.mockReset().mockResolvedValue({ serverConfigPath: profileB, serverName: "B" });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.resetModules();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("world map resolution", () => {
  it("uses the selected profile Map order, reverses supported layers for drawing, and reports unsupported entries", async () => {
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");

    expect(res.statusCode).toBe(200);
    expect(res.body.version).toBe(VERSION);
    expect(res.body.label).toBe("Build 42.21");
    expect(res.body.mapOrder).toEqual(["RavenCreek", "Muldraugh, KY", "West Point Expansion", "MissingRegion"]);
    expect(res.body.layers.map((layer: any) => layer.id)).toEqual(["WestPointExpansion", "base", "RavenCreek"]);
    expect(res.body.layers[0]).toMatchObject({
      name: "West Point Expansion",
      tileRoot: `${PZ_TILES_ROOT}/${VERSION}/mod_maps/WestPointExpansion/base/`,
      width: 2318656,
      height: 1019040,
      tileSize: 2048,
      format: "jpg",
      composite: true,
      cellSize: 256,
      cellRects: [[1, 2, 3, 4]],
      x0: 222,
      scale: 4,
      minFloor: -17,
      maxFloor: 29,
    });
    expect(res.body.warnings).toContain("Map=MissingRegion is not available from PZMap and was skipped.");
    expect(fetchMock.mock.calls.every(([input, init]) => {
      const origin = new URL(String(input)).origin;
      return [PZ_MAP_ROOT, PZ_TILES_ROOT].includes(origin) && init?.redirect === "error";
    })).toBe(true);
  });

  it("uses the real Muldraugh default only when the readable INI omits Map=", async () => {
    await fs.writeFile(path.join(profileB, "B.ini"), "PublicName=One\n");
    vi.stubGlobal("fetch", baseMetadataFetch({
      [`${PZ_TILES_ROOT}/${VERSION}/base/map_info.json`]: mapInfo({ cell_rects: undefined }),
    }));
    const res = await callRoute("/resolve");
    expect(res.body.mapOrder).toEqual(["Muldraugh, KY"]);
    expect(res.body.layers.map((layer: any) => layer.id)).toEqual(["base"]);
    expect(res.body.layers[0].cellRects).toEqual([]);
    expect(res.body.warnings[0]).toContain("using the Project Zomboid default");
  });

  it("keeps an explicitly empty Map= empty instead of loading the default", async () => {
    await fs.writeFile(path.join(profileB, "B.ini"), "Map=\n");
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.body.mapOrder).toEqual([]);
    expect(res.body.layers).toEqual([]);
    expect(res.body.warnings).toContain("Active server INI has an empty Map= setting; no map layers were loaded.");
    expect(fetchMock.mock.calls.every(([input]) => String(input) === `${PZ_MAP_ROOT}/api/builds/default`)).toBe(true);
  });

  it("resolves the currently selected profile rather than another configured profile", async () => {
    getContext.mockResolvedValue({ serverConfigPath: profileA, serverName: "A" });
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.body.mapOrder).toEqual(["OldMap", "Muldraugh, KY"]);
    expect(res.body.layers.map((layer: any) => layer.id)).toEqual(["base"]);
    expect(res.body.warnings).toContain("Map=OldMap is not available from PZMap and was skipped.");
  });

  it("does not invent a map when the active profile INI cannot be read", async () => {
    getContext.mockResolvedValue({ serverConfigPath: path.join(tempRoot, "missing"), serverName: "Missing" });
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.body.mapOrder).toEqual([]);
    expect(res.body.layers).toEqual([]);
    expect(res.body.warnings).toContain("Could not read the active server INI; map overlays were not resolved.");
    expect(fetchMock.mock.calls.every(([input]) => String(input).startsWith(PZ_MAP_ROOT))).toBe(true);
  });

  it("reports non-composite maps as unsupported instead of rendering incorrect floors", async () => {
    getContext.mockResolvedValue({ serverConfigPath: profileA, serverName: "A" });
    const fetchMock = baseMetadataFetch({
      [`${PZ_TILES_ROOT}/${VERSION}/base/map_info.json`]: mapInfo({ composite: false }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain("non-composite floor dataset");
  });

  it("warns and skips a mod overlay with missing cell bounds", async () => {
    const fetchMock = baseMetadataFetch({
      [`${PZ_TILES_ROOT}/${VERSION}/mod_maps/RavenCreek/base/map_info.json`]: mapInfo({ cell_rects: undefined }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.statusCode).toBe(200);
    expect(res.body.layers.map((layer: any) => layer.id)).toEqual(["WestPointExpansion", "base"]);
    expect(res.body.warnings.some((warning: string) => warning.includes("Raven Creek") && warning.includes("no cell bounds"))).toBe(true);
  });

  it("returns a map-scoped 503 with the provider's 403 challenge status", async () => {
    const fetchMock = vi.fn(async () => response("challenge", 403, { "cf-mitigated": "challenge" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/resolve");
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toContain("HTTP 403; Cloudflare challenge");

    vi.resetModules();
    const { getWorldMapDiagnostics } = await import("../routes/worldMap.ts");
    const diagnostics = await getWorldMapDiagnostics();
    expect(diagnostics).toMatchObject({
      available: false,
      provider: { origin: PZ_MAP_ROOT, status: "error", statusCode: 403 },
    });
  });

  it("rejects arbitrary versions and loot paths before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const pois = await callRoute("/pois", { version: "42.21.2/https://example.com" });
    const loot = await callRoute("/loot", { version: VERSION, type: "../catalog", x: "1", y: "2", z: "0" });
    expect(pois.statusCode).toBe(400);
    expect(loot.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects arbitrary coverage layer IDs before any provider request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/coverage", { version: VERSION, id: "../outside" });
    expect(result.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("composite layer metadata", () => {
  it("serves a validated sparse coverage manifest with floor and DZI tile bounds", async () => {
    const manifest = {
      ground: 0,
      levels: {
        "0": { "0": [[0, 0]], "1": [[0, 0]] },
        "22": { "0": [[1126, 490]], "1": [[1126, 490]] },
      },
    };
    const fetchMock = baseMetadataFetch({
      [`${PZ_TILES_ROOT}/${VERSION}/base/layer_coverage.json`]: manifest,
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/coverage", { version: VERSION, id: "base" });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(manifest);
    expect(result.headers["Cache-Control"]).toContain("max-age=300");
  });

  it("rejects fractional and out-of-bounds sparse tile coordinates", async () => {
    const fetchMock = baseMetadataFetch({
      [`${PZ_TILES_ROOT}/${VERSION}/base/layer_coverage.json`]: {
        ground: 0,
        levels: { "22": { "1": [[1.5, 2], [1133, 0]] } },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/coverage", { version: VERSION, id: "base" });
    expect(result.statusCode).toBe(503);
    expect(result.body.error).toContain("invalid coverage tile coordinates");
  });

  it("returns each selected floor's validated DZI format", async () => {
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/floor", { version: VERSION, id: "base", floor: "1" });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ format: "webp" });
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/base/layer1.dzi"))).toBe(true);
  });

  it("rejects a floor outside map_info bounds before requesting its DZI", async () => {
    const fetchMock = baseMetadataFetch();
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/floor", { version: VERSION, id: "base", floor: "30" });
    expect(result.statusCode).toBe(400);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/base/layer30.dzi"))).toBe(false);
  });
});

describe("world map search data", () => {
  it("normalizes POI IDs, coordinates, floors, and tags", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === `${PZ_MAP_ROOT}/api/pois/for-version/${VERSION}`) {
        return response([
          { ID: 3000, name: "Brandenburg", x: 2101, y: 6076, layer: 0, tags: ["town", "city"], Categories: ["Store"] },
          { ID: "bad", name: "Skipped", x: "invalid", y: 2, layer: 0 },
        ]);
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await callRoute("/pois", { version: VERSION });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      pois: [{ id: "3000", name: "Brandenburg", x: 2101, y: 6076, z: 0, tags: ["town", "city", "Store"] }],
    });
  });

  it("lists normalized container types and searches only the bounded nearest cells with the official PZCR layout", async () => {
    const catalog = {
      version: 1,
      format: "PZCR",
      cell_size: 256,
      types: [{ id: "barbecue", slug: "barbecue", total: 1426, cells: 441, index: "barbecue/index.json" }],
    };
    const chunkA = zlib.gzipSync(makePzcr(1, 1, 256, [[10, 20, 0], [8, 19, 0], [30, 30, 1]]));
    const chunkB = zlib.gzipSync(makePzcr(2, 1, 256, [[0, 20, 0]]));
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url === `${PZ_TILES_ROOT}/${VERSION}/tiles/containers/catalog.json`) return response(catalog);
      if (url === `${PZ_TILES_ROOT}/${VERSION}/tiles/containers/barbecue/index.json`) {
        return response({ cells: {
          "1_1": { f: "1_1.pzcr.gz", c: "gzip" },
          "2_1": { f: "2_1.pzcr.gz", c: "gzip" },
          "900_900": { f: "all-map.pzcr.gz", c: "gzip" },
        } });
      }
      if (url === `${PZ_TILES_ROOT}/${VERSION}/tiles/containers/barbecue/1_1.pzcr.gz`) return new Response(chunkA);
      if (url === `${PZ_TILES_ROOT}/${VERSION}/tiles/containers/barbecue/2_1.pzcr.gz`) return new Response(chunkB);
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const types = await callRoute("/loot-types", { version: VERSION });
    expect(types.body).toEqual({ types: [{ id: "barbecue", name: "Barbecue", total: 1426 }] });
    const result = await callRoute("/loot", { version: VERSION, type: "barbecue", x: "266", y: "276", z: "0" });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({
      points: [
        { x: 266, y: 276, z: 0 },
        { x: 264, y: 275, z: 0 },
        { x: 512, y: 276, z: 0 },
      ],
      truncated: false,
    });
    expect(calls.filter((url) => url.includes(".pzcr.gz"))).toHaveLength(2);
    expect(calls.some((url) => url.includes("all-map"))).toBe(false);
  });

  it("reports truncation after sorting the nearest 100 container points", async () => {
    const points = Array.from({ length: 101 }, (_, index) => [index, 10, 0] as [number, number, number]);
    const chunk = zlib.gzipSync(makePzcr(0, 0, 256, points));
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/tiles/containers/catalog.json")) return response({ cell_size: 256, types: [{ slug: "barbecue", total: 101 }] });
      if (url.endsWith("/tiles/containers/barbecue/index.json")) return response({ cells: { "0_0": { f: "0_0.pzcr.gz", c: "gzip" } } });
      if (url.endsWith("/tiles/containers/barbecue/0_0.pzcr.gz")) return new Response(chunk);
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/loot", { version: VERSION, type: "barbecue", x: "10", y: "10", z: "0" });
    expect(result.body.points).toHaveLength(100);
    expect(result.body.truncated).toBe(true);
  });

  it("rejects a provider chunk path that is not a basename", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/tiles/containers/catalog.json")) {
        return response({ cell_size: 256, types: [{ slug: "barbecue", total: 1 }] });
      }
      if (url.endsWith("/tiles/containers/barbecue/index.json")) {
        return response({ cells: { "0_0": { f: "../secret.pzcr" } } });
      }
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/loot", { version: VERSION, type: "barbecue", x: "1", y: "1", z: "0" });
    expect(result.statusCode).toBe(503);
    expect(result.body.error).toContain("invalid container chunk path");
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => new URL(url).origin === PZ_TILES_ROOT)).toBe(true);
  });

  it.skipIf(typeof zlib.zstdCompressSync !== "function")("decodes provider Zstd chunks when the runtime supports Node's native decoder", async () => {
    const raw = makePzcr(0, 0, 256, [[5, 7, -1]]);
    const chunk = zlib.zstdCompressSync(raw);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/tiles/containers/catalog.json")) return response({ cell_size: 256, types: [{ slug: "barbecue", total: 1 }] });
      if (url.endsWith("/tiles/containers/barbecue/index.json")) return response({ cells: { "0_0": { f: "0_0.pzcr.zst", c: "zstd" } } });
      if (url.endsWith("/tiles/containers/barbecue/0_0.pzcr.zst")) return new Response(chunk);
      throw new Error(`Unexpected provider URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await callRoute("/loot", { version: VERSION, type: "barbecue", x: "5", y: "7", z: "-1" });
    expect(result.body).toEqual({ points: [{ x: 5, y: 7, z: -1 }], truncated: false });
  });
});
