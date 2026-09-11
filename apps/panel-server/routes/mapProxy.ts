import { Router } from "../http/startApiRouter.ts";
import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import type { Request, Response as NativeResponse } from "../http/startApiRouter.ts";
import { createLogger } from "../utils/logger.ts";
import { getDataPaths } from "../utils/paths.ts";
import { getActiveServer } from "../database/init.ts";
import { listPersistedVehicles } from "../utils/vehiclesDb.ts";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
const log = createLogger("API:MapProxy");
const execFileAsync = promisify(execFile);

const router = Router();

type TileCacheEntry = { buffer: Buffer; contentType: string };
type MapProjection = { x0: number; y0: number; sqr: number; scale: number };
type MapGeometry = {
  tileSize: number;
  width: number;
  height: number;
  maxLevel: number;
  x0?: number;
  y0?: number;
  sqr?: number;
  scale?: number;
  renderedMaxLevel?: number;
};
type B42Map = MapGeometry & {
  directory: string;
  renderedMaxLevel?: number;
};
type CurlResponse = { ok: boolean; status: number; text: string };
type TopFormat = "webp" | "jpg" | "jpeg" | "png";
type VehicleRecord = { id: number; x: number; y: number };
type PersistedVehicleCache = {
  key: string | null;
  expiresAt: number;
  vehicles: VehicleRecord[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TILE_CACHE_DIR = path.join(getDataPaths().dataDir, "map-tiles-cache");
const MEM_CACHE_MAX = 500;
const memCache = new Map<string, TileCacheEntry>();

function memCacheGet(relPath: string): TileCacheEntry | null {
  const entry = memCache.get(relPath);
  if (!entry) return null;
  memCache.delete(relPath);
  memCache.set(relPath, entry);
  return entry;
}

function memCachePut(relPath: string, buffer: Buffer, contentType: string): void {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey !== undefined) memCache.delete(oldestKey);
  }
  memCache.set(relPath, { buffer, contentType });
}

function diskPathFor(relPath: string): string {
  return path.join(TILE_CACHE_DIR, relPath);
}

async function readDiskCache(relPath: string): Promise<Buffer | null> {
  try {
    return await fs.promises.readFile(diskPathFor(relPath));
  } catch {
    return null;
  }
}

export function writeDiskCacheAsync(relPath: string, buffer: Buffer): Promise<void> {
  const dest = diskPathFor(relPath);
  const tmp = `${dest}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  return fs.promises
    .mkdir(path.dirname(dest), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, buffer))
    .then(() => fs.promises.rename(tmp, dest))
    .catch((err: unknown) => {
      log.debug(`Disk tile cache write failed for ${relPath}: ${errorMessage(err)}`);
      fs.promises.unlink(tmp).catch(() => {});
    });
}

const PZ_MAP_ROOT = "https://pzmap.org";
const PZ_TILES_ROOT = "https://tiles.pzmap.org";

const CURL_DISCOVERY_UA =
  "ZomboidControlPanel/1.0 (+https://github.com/itsmeares/better-zcp)";
const CURL_TIMEOUT_S = 8;
const CURL_STATUS_MARKER = "\n__CURL_HTTP_STATUS__:";

async function fetchViaCurl(url: string): Promise<CurlResponse> {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "curl",
      [
        "-s",
        "--max-time",
        String(CURL_TIMEOUT_S),
        "-A",
        CURL_DISCOVERY_UA,
        "-w",
        `${CURL_STATUS_MARKER}%{http_code}`,
        "--",
        url,
      ],
      { timeout: (CURL_TIMEOUT_S + 2) * 1000, maxBuffer: 20 * 1024 * 1024 },
    ));
  } catch (err: unknown) {
    throw new Error(
      err && typeof err === "object" && "code" in err && err.code === "ENOENT"
        ? "curl is not available on this host"
        : `curl request failed: ${errorMessage(err)}`,
    );
  }
  const idx = stdout.lastIndexOf(CURL_STATUS_MARKER);
  if (idx === -1) throw new Error("curl output missing its status marker");
  const status = Number(stdout.slice(idx + CURL_STATUS_MARKER.length).trim());
  return {
    ok: status >= 200 && status < 300,
    status,
    text: stdout.slice(0, idx),
  };
}

const B42_DIR_FALLBACK = "42.20.0";
const B42_DIR_TTL_MS = 24 * 60 * 60 * 1000;
const B42_DIR_RETRY_MS = 5 * 60 * 1000;
const B42_GEOMETRY_FALLBACK_VERIFIED_RENDERED_MAX_LEVEL = 22;

const B42_GEOMETRY_FALLBACK: MapGeometry = {
  tileSize: 2048,
  width: 2318656,
  height: 1019040,
  maxLevel: 22,
  renderedMaxLevel: B42_GEOMETRY_FALLBACK_VERIFIED_RENDERED_MAX_LEVEL,
  x0: 1040384,
  y0: -139296,
  sqr: 128,
  scale: 1,
};

async function fetchMapProjection(directory: string): Promise<MapProjection | null> {
  try {
    const resp = await fetchViaCurl(
      `${PZ_TILES_ROOT}/${directory}/base/map_info.json`,
    );
    if (!resp.ok) return null;
    const info = JSON.parse(resp.text);
    const x0 = Number(info?.x0);
    const y0 = Number(info?.y0);
    const sqr = Number(info?.sqr);
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !sqr) return null;
    const skip = Number(info?.skip);
    return { x0, y0, sqr, scale: 1 << (Number.isFinite(skip) ? skip : 0) };
  } catch {
    return null;
  }
}
async function fetchMapGeometry(directory: string): Promise<MapGeometry | null> {
  try {
    const [resp, projection] = await Promise.all([
      fetchViaCurl(`${PZ_TILES_ROOT}/${directory}/base/layer0.dzi`),
      fetchMapProjection(directory),
    ]);
    if (!resp.ok) return null;
    const xml = resp.text;
    const tileSize = Number(xml.match(/TileSize="(\d+)"/)?.[1]);
    const width = Number(xml.match(/Width="(\d+)"/)?.[1]);
    const height = Number(xml.match(/Height="(\d+)"/)?.[1]);
    if (!tileSize || !width || !height) return null;
    return {
      tileSize,
      width,
      height,
      maxLevel: Math.ceil(Math.log2(Math.max(width, height))),
      ...(projection || {}),
    };
  } catch {
    return null;
  }
}

const COVERAGE_PROBE_FRACTIONS = [
  [0.51, 0.4],
  [0.56, 0.45],
  [0.61, 0.5],
];
let _b42Map: B42Map | null = null;
let _b42DirFetchedAt = 0;
let _b42ResolvePromise: Promise<B42Map> | null = null;
let _b42Source: "dynamic" | "fallback" | null = null;
let _b42FallbackReason: string | null = null;

const RENDERED_MAX_LEVEL_CONSERVATIVE_OFFSET = 6;
function conservativeRenderedMaxLevel(maxLevel: number): number {
  return Math.max(0, maxLevel - RENDERED_MAX_LEVEL_CONSERVATIVE_OFFSET);
}

async function probeLevelHasCoverage(
  directory: string,
  geometry: MapGeometry,
  level: number,
): Promise<boolean> {
  const levelScale = 2 ** (geometry.maxLevel - level);
  const levelW = Math.ceil(geometry.width / levelScale);
  const levelH = Math.ceil(geometry.height / levelScale);
  for (const [fx, fy] of COVERAGE_PROBE_FRACTIONS) {
    const col = Math.floor((levelW * fx) / geometry.tileSize);
    const row = Math.floor((levelH * fy) / geometry.tileSize);
    try {
      const resp = await fetch(
        `${PZ_TILES_ROOT}/${directory}/base/layer0_files/${level}/${col}_${row}.jpg`,
        {
          method: "HEAD",
          signal: AbortSignal.timeout(4000),
          headers: {
            "User-Agent":
              "ZomboidControlPanel/1.0 (+https://github.com/itsmeares/better-zcp)",
          },
        },
      );
      if (resp.ok) return true;
    } catch {
      // Treat as not-covered and try the next probe tile.
    }
  }
  return false;
}

async function hasTileCoverage(directory: string, geometry: MapGeometry): Promise<boolean> {
  return probeLevelHasCoverage(
    directory,
    geometry,
    conservativeRenderedMaxLevel(geometry.maxLevel),
  );
}

async function discoverRenderedMaxLevel(directory: string, geometry: MapGeometry): Promise<number> {
  const floor = conservativeRenderedMaxLevel(geometry.maxLevel);
  let lo = floor;
  let hi = geometry.maxLevel;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (await probeLevelHasCoverage(directory, geometry, mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

const TOP_FORMAT_FALLBACK = "jpg";
const TOP_CONTENT_TYPES: Record<TopFormat, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function isTopFormat(value: string): value is TopFormat {
  return value in TOP_CONTENT_TYPES;
}
const _topFormatCache = new Map<string, TopFormat>();
const _topFormatInflight = new Map<string, Promise<TopFormat>>();

async function getB42TopFormat(directory: string): Promise<TopFormat> {
  const cached = _topFormatCache.get(directory);
  if (cached) return cached;
  const pending = _topFormatInflight.get(directory);
  if (pending) return pending;
  const resolvePromise = resolveB42TopFormat(directory).finally(() => {
    _topFormatInflight.delete(directory);
  });
  _topFormatInflight.set(directory, resolvePromise);
  return resolvePromise;
}

async function resolveB42TopFormat(directory: string): Promise<TopFormat> {
  try {
    const resp = await fetchViaCurl(
      `${PZ_TILES_ROOT}/${directory}/base_top/layer0.dzi`,
    );
    if (resp.ok) {
      const xml = resp.text;
      const format = xml.match(/Format="(\w+)"/)?.[1]?.toLowerCase();
      if (format && isTopFormat(format)) {
        _topFormatCache.set(directory, format);
        return format;
      }
    }
  } catch {
    // Fall through to the default below.
  }
  return TOP_FORMAT_FALLBACK;
}

async function fetchBuildDefault(): Promise<{ directory: string }> {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds/default`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds/default`);
  }
  const entry = JSON.parse(resp.text) as { directory?: unknown };
  if (typeof entry.directory !== "string" || !entry.directory) {
    throw new Error("/api/builds/default response had no directory");
  }
  return { directory: entry.directory };
}

async function fetchBuildList(): Promise<Array<{ directory: string }>> {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds`);
  }
  const list = JSON.parse(resp.text);
  if (!Array.isArray(list)) {
    throw new Error("/api/builds response was not an array");
  }
  return list as Array<{ directory: string }>;
}

function isB42PlusCandidate(directory: unknown): directory is string {
  return typeof directory === "string" && /^4[2-9][\w.\-]*$/.test(directory);
}

async function getB42Map(): Promise<B42Map> {
  const now = Date.now();
  if (_b42Map && now - _b42DirFetchedAt < B42_DIR_TTL_MS) {
    return _b42Map;
  }
  if (_b42ResolvePromise) return _b42ResolvePromise;
  _b42ResolvePromise = resolveB42Map(now).finally(() => {
    _b42ResolvePromise = null;
  });
  return _b42ResolvePromise;
}

async function resolveB42Map(now: number): Promise<B42Map> {
  let failureReason = null;

  async function tryResolve(directory: string): Promise<boolean> {
    const geometry = await fetchMapGeometry(directory);
    if (!geometry) {
      failureReason = `could not read ${directory}/base/layer0.dzi (discovery request to tiles.pzmap.org was refused)`;
      log.warn(
        `B42 map directory ${directory} has no readable layer0.dzi — trying another build.`,
      );
      return false;
    }
    if (!(await hasTileCoverage(directory, geometry))) {
      failureReason = `${directory} listed but has no rendered tile coverage yet`;
      log.warn(
        `B42 map directory ${directory} listed but has no rendered tile coverage yet — trying another build.`,
      );
      return false;
    }
    const renderedMaxLevel = await discoverRenderedMaxLevel(directory, geometry);
    if (_b42Map?.directory !== directory || _b42Source !== "dynamic") {
      log.info(
        `B42 map directory resolved: ${directory} (${geometry.width}x${geometry.height}, tile ${geometry.tileSize}, max level ${geometry.maxLevel}, rendered max level ${renderedMaxLevel})`,
      );
    }
    _b42Map = { directory, ...geometry, renderedMaxLevel };
    _b42DirFetchedAt = now;
    _b42Source = "dynamic";
    _b42FallbackReason = null;
    return true;
  }

  let alreadyTried: string | null = null;
  try {
    const def = await fetchBuildDefault();
    if (isB42PlusCandidate(def.directory)) {
      alreadyTried = def.directory;
      if (await tryResolve(def.directory)) return _b42Map!;
    } else {
      failureReason = `/api/builds/default returned a non-B42+ directory (${def.directory})`;
    }
  } catch (err: unknown) {
    failureReason = errorMessage(err);
  }

  try {
    const list = await fetchBuildList();
    const candidates = list
      .filter(
        (e) => isB42PlusCandidate(e?.directory) && e.directory !== alreadyTried,
      )
      .reverse();
    if (candidates.length === 0 && !alreadyTried) {
      failureReason = failureReason || "/api/builds listed no B42+ candidates";
    }
    for (const entry of candidates) {
      if (await tryResolve(entry.directory)) return _b42Map!;
    }
  } catch (err: unknown) {
    failureReason = failureReason || errorMessage(err);
  }

  if (_b42Source !== "fallback" || _b42FallbackReason !== failureReason) {
    log.warn(
      `B42 build auto-detect failed (${failureReason || "unknown reason"}) — serving hardcoded fallback ${_b42Map?.directory || B42_DIR_FALLBACK}. This will NOT track the next PZ map build until discovery starts working again.`,
    );
  }
  _b42Map = _b42Map || { directory: B42_DIR_FALLBACK, ...B42_GEOMETRY_FALLBACK };
  _b42Source = "fallback";
  _b42FallbackReason = failureReason || "unknown reason";
  _b42DirFetchedAt = now - B42_DIR_TTL_MS + B42_DIR_RETRY_MS;
  return _b42Map;
}

async function getB42Dir(): Promise<string> {
  return (await getB42Map()).directory;
}

function getB42ResolutionStatus(): {
  source: "dynamic" | "fallback" | null;
  directory: string;
  reason: string | null;
} {
  return {
    source: _b42Source,
    directory: _b42Map?.directory ?? B42_DIR_FALLBACK,
    reason: _b42FallbackReason,
  };
}

const TILE_FETCH_TIMEOUT_MS = 10_000;

const CIRCUIT_FAILURE_THRESHOLD = 8;
const CIRCUIT_COOLDOWN_MS = 30_000;
let circuitConsecutiveFailures = 0;
let circuitOpenUntil = 0;

function isCircuitOpen(): boolean {
  return Date.now() < circuitOpenUntil;
}

function recordTileSuccess(): void {
  circuitConsecutiveFailures = 0;
}

function recordTileFailure(): void {
  circuitConsecutiveFailures++;
  if (
    circuitConsecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD &&
    !isCircuitOpen()
  ) {
    circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
    log.warn(
      `Tile proxy circuit breaker OPEN for ${CIRCUIT_COOLDOWN_MS / 1000}s after ${circuitConsecutiveFailures} consecutive upstream failures`,
    );
  }
}

async function fetchTileWithTimeout(url: string): Promise<globalThis.Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(TILE_FETCH_TIMEOUT_MS),
    headers: {
      // Some upstreams (Cloudflare on tiles.pzmap.org) return 403/503 when the
      // User-Agent header is missing entirely. Send a neutral identifier.
      "User-Agent":
        "ZomboidControlPanel/1.0 (+https://github.com/itsmeares/better-zcp)",
      Accept: "image/*,*/*;q=0.8",
    },
  });
}

async function fetchTileWithRetry(url: string): Promise<globalThis.Response> {
  if (isCircuitOpen()) {
    throw new Error(
      "Tile proxy circuit breaker is open (upstream has been failing repeatedly)",
    );
  }
  try {
    const r = await fetchTileWithTimeout(url);
    if (r.ok || r.status === 404) {
      recordTileSuccess();
      return r;
    }
    if (r.status >= 500 && r.status < 600) {
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    }
    return r;
  } catch (err) {
    try {
      await new Promise((res) => setTimeout(res, 250));
      const retried = await fetchTileWithTimeout(url);
      if (retried.ok || retried.status === 404) recordTileSuccess();
      else recordTileFailure();
      return retried;
    } catch (retryErr) {
      recordTileFailure();
      throw retryErr;
    }
  }
}

const TILE_BROWSER_CACHE_CONTROL = "public, max-age=3600";
const TILE_BROWSER_CACHE_CONTROL_VERSIONED =
  "public, max-age=604800, immutable";

function requestIsVersioned(req: Request): boolean {
  const v = Array.isArray(req.query.v) ? req.query.v[0] : req.query.v;
  return typeof v === "string" && v.length > 0;
}

async function serveTile(
  req: Request,
  res: NativeResponse,
  url: string,
  contentType: string,
  relPath: string,
  cacheControl: string,
): Promise<void> {
  const hot = memCacheGet(relPath);
  if (hot) {
    res.set("Content-Type", hot.contentType);
    res.set("Cache-Control", cacheControl);
    res.set("X-Tile-Cache", "hit-mem");
    res.send(hot.buffer);
    return;
  }

  const onDisk = await readDiskCache(relPath);
  if (onDisk) {
    memCachePut(relPath, onDisk, contentType);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", cacheControl);
    res.set("X-Tile-Cache", "hit-disk");
    res.send(onDisk);
    return;
  }

  try {
    const response = await fetchTileWithRetry(url);
    if (!response.ok) {
      const status =
        response.status === 404
          ? 404
          : response.status >= 500
            ? 502
            : response.status;
      res.set("X-Tile-Cache", "miss");
      res.status(status).end();
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    memCachePut(relPath, buffer, contentType);
    writeDiskCacheAsync(relPath, buffer);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", cacheControl);
    res.set("X-Tile-Cache", "miss");
    res.send(buffer);
  } catch (err: unknown) {
    log.debug(`Tile proxy failed for ${url}: ${errorMessage(err)}`);
    if (!res.headersSent) res.status(502).end();
  }
}

router.get("/resolve", async (req, res) => {
  const map = await getB42Map();
  res.set("Cache-Control", "public, max-age=3600");
  res.json({
    root: PZ_TILES_ROOT,
    b42Dir: map.directory,
    b41Path: "41.78.16/base/layer0_files",
    tileSize: map.tileSize,
    width: map.width,
    height: map.height,
    maxLevel: map.maxLevel,
    renderedMaxLevel: map.renderedMaxLevel ?? conservativeRenderedMaxLevel(map.maxLevel),
    x0: map.x0,
    y0: map.y0,
    sqr: map.sqr,
    scale: map.scale,
  });
});

let persistedVehicleCache: PersistedVehicleCache = { key: null, expiresAt: 0, vehicles: [] };

router.get("/vehicles", async (req, res) => {
  try {
    const activeServer = await getActiveServer();
    if (!activeServer || activeServer.isRemote || !activeServer.zomboidDataPath) {
      return res.json({ vehicles: [] });
    }
    const serverName = activeServer.serverName || activeServer.name;
    if (!serverName) return res.json({ vehicles: [] });
    const savePath = path.join(activeServer.zomboidDataPath, "Saves", "Multiplayer", serverName);
    const cacheKey = `${savePath}`;
    if (persistedVehicleCache.key !== cacheKey || Date.now() >= persistedVehicleCache.expiresAt) {
      persistedVehicleCache = {
        key: cacheKey,
        expiresAt: Date.now() + 15000,
        vehicles: await listPersistedVehicles(savePath),
      };
    }
    res.json({ vehicles: persistedVehicleCache.vehicles });
  } catch (err: unknown) {
    log.warn(`Persisted vehicle lookup failed: ${errorMessage(err)}`);
    res.json({ vehicles: [] });
  }
});

router.get("/tiles/:level/:tile", async (req, res) => {
  const level = parseBoundedInteger(req.params.level, null, 0, 22);
  const tile = req.params.tile;
  const floorRaw = Array.isArray(req.query.floor)
    ? req.query.floor[0]
    : req.query.floor;
  const floor = parseBoundedInteger(String(floorRaw ?? "0"), null, -17, 29);

  if (level === null) {
    return res.status(400).json({ error: "Invalid level" });
  }
  if (floor === null) {
    return res.status(400).json({ error: "Invalid floor" });
  }
  const ext = "jpg";
  if (!new RegExp(`^\\d+_\\d+\\.${ext}$`).test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  const url = `${PZ_TILES_ROOT}/${dir}/base/layer${floor}_files/${level}/${tile}`;
  const contentType = "image/jpeg";
  const relPath = path.join("b42", dir, `layer${floor}`, String(level), tile);
  const cacheControl = requestIsVersioned(req)
    ? TILE_BROWSER_CACHE_CONTROL_VERSIONED
    : TILE_BROWSER_CACHE_CONTROL;
  await serveTile(req, res, url, contentType, relPath, cacheControl);
});

router.get("/toptiles/:level/:tile", async (req, res) => {
  const level = parseBoundedInteger(req.params.level, null, 0, 22);
  const tile = req.params.tile;

  if (level === null) {
    return res.status(400).json({ error: "Invalid level" });
  }
  const parsed = /^(\d+_\d+)\.(webp|jpe?g|png)$/.exec(tile);
  if (!parsed) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const dir = await getB42Dir();
  const format = await getB42TopFormat(dir);
  const upstreamTile = `${parsed[1]}.${format}`;
  const url = `${PZ_TILES_ROOT}/${dir}/base_top/layer0_files/${level}/${upstreamTile}`;
  const relPath = path.join("b42-top", dir, String(level), upstreamTile);
  const cacheControl = requestIsVersioned(req)
    ? TILE_BROWSER_CACHE_CONTROL_VERSIONED
    : TILE_BROWSER_CACHE_CONTROL;
  await serveTile(req, res, url, TOP_CONTENT_TYPES[format], relPath, cacheControl);
});

router.get("/b41tiles/:level/:tile", async (req, res) => {
  const level = parseBoundedInteger(req.params.level, null, 0, 22);
  const tile = req.params.tile;

  if (level === null) {
    return res.status(400).json({ error: "Invalid level" });
  }
  if (!/^\d+_\d+\.jpg$/.test(tile)) {
    return res.status(400).json({ error: "Invalid tile" });
  }

  const url = `${PZ_TILES_ROOT}/41.78.16/base/layer0_files/${level}/${tile}`;
  const relPath = path.join("b41", String(level), tile);
  await serveTile(req, res, url, "image/jpeg", relPath, TILE_BROWSER_CACHE_CONTROL);
});

export default router;

export { PZ_MAP_ROOT, PZ_TILES_ROOT, getB42Dir, getB42TopFormat, getB42ResolutionStatus };
