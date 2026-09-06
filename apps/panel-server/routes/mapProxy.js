import express from "express";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createLogger } from "../utils/logger.ts";
import { getDataPaths } from "../utils/paths.js";
import { getActiveServer } from "../database/init.js";
import { listPersistedVehicles } from "../utils/vehiclesDb.js";
import { parseBoundedInteger } from "../utils/queryNumbers.ts";
const log = createLogger("API:MapProxy");
const execFileAsync = promisify(execFile);

const router = express.Router();

const TILE_CACHE_DIR = path.join(getDataPaths().dataDir, "map-tiles-cache");
const MEM_CACHE_MAX = 500;
const memCache = new Map();

function memCacheGet(relPath) {
  const entry = memCache.get(relPath);
  if (!entry) return null;
  memCache.delete(relPath);
  memCache.set(relPath, entry);
  return entry;
}

function memCachePut(relPath, buffer, contentType) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey !== undefined) memCache.delete(oldestKey);
  }
  memCache.set(relPath, { buffer, contentType });
}

function diskPathFor(relPath) {
  return path.join(TILE_CACHE_DIR, relPath);
}

async function readDiskCache(relPath) {
  try {
    return await fs.promises.readFile(diskPathFor(relPath));
  } catch {
    return null;
  }
}

function writeDiskCacheAsync(relPath, buffer) {
  const dest = diskPathFor(relPath);
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.promises
    .mkdir(path.dirname(dest), { recursive: true })
    .then(() => fs.promises.writeFile(tmp, buffer))
    .then(() => fs.promises.rename(tmp, dest))
    .catch((err) => {
      log.debug(`Disk tile cache write failed for ${relPath}: ${err.message}`);
      fs.promises.unlink(tmp).catch(() => {});
    });
}

const PZ_MAP_ROOT = "https://pzmap.org";
const PZ_TILES_ROOT = "https://tiles.pzmap.org";

const CURL_DISCOVERY_UA =
  "ZomboidControlPanel/1.0 (+https://github.com/itsmeares/better-zcp)";
const CURL_TIMEOUT_S = 8;
const CURL_STATUS_MARKER = "\n__CURL_HTTP_STATUS__:";

async function fetchViaCurl(url) {
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
  } catch (err) {
    throw new Error(
      err.code === "ENOENT"
        ? "curl is not available on this host"
        : `curl request failed: ${err.message}`,
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

const B42_GEOMETRY_FALLBACK = {
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

async function fetchMapProjection(directory) {
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
async function fetchMapGeometry(directory) {
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
let _b42Map = null;
let _b42DirFetchedAt = 0;
let _b42ResolvePromise = null;
let _b42Source = null;
let _b42FallbackReason = null;

const RENDERED_MAX_LEVEL_CONSERVATIVE_OFFSET = 6;
function conservativeRenderedMaxLevel(maxLevel) {
  return Math.max(0, maxLevel - RENDERED_MAX_LEVEL_CONSERVATIVE_OFFSET);
}

async function probeLevelHasCoverage(directory, geometry, level) {
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

async function hasTileCoverage(directory, geometry) {
  return probeLevelHasCoverage(
    directory,
    geometry,
    conservativeRenderedMaxLevel(geometry.maxLevel),
  );
}

async function discoverRenderedMaxLevel(directory, geometry) {
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
const TOP_CONTENT_TYPES = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const _topFormatCache = new Map();
const _topFormatInflight = new Map();

async function getB42TopFormat(directory) {
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

async function resolveB42TopFormat(directory) {
  try {
    const resp = await fetchViaCurl(
      `${PZ_TILES_ROOT}/${directory}/base_top/layer0.dzi`,
    );
    if (resp.ok) {
      const xml = resp.text;
      const format = xml.match(/Format="(\w+)"/)?.[1]?.toLowerCase();
      if (format && TOP_CONTENT_TYPES[format]) {
        _topFormatCache.set(directory, format);
        return format;
      }
    }
  } catch {
    // Fall through to the default below.
  }
  return TOP_FORMAT_FALLBACK;
}

async function fetchBuildDefault() {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds/default`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds/default`);
  }
  const entry = JSON.parse(resp.text);
  if (!entry?.directory) {
    throw new Error("/api/builds/default response had no directory");
  }
  return entry;
}

async function fetchBuildList() {
  const resp = await fetchViaCurl(`${PZ_MAP_ROOT}/api/builds`);
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for /api/builds`);
  }
  const list = JSON.parse(resp.text);
  if (!Array.isArray(list)) {
    throw new Error("/api/builds response was not an array");
  }
  return list;
}

function isB42PlusCandidate(directory) {
  return /^4[2-9][\w.\-]*$/.test(directory || "");
}

async function getB42Map() {
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

async function resolveB42Map(now) {
  let failureReason = null;

  async function tryResolve(directory) {
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

  let alreadyTried = null;
  try {
    const def = await fetchBuildDefault();
    if (isB42PlusCandidate(def.directory)) {
      alreadyTried = def.directory;
      if (await tryResolve(def.directory)) return _b42Map;
    } else {
      failureReason = `/api/builds/default returned a non-B42+ directory (${def.directory})`;
    }
  } catch (err) {
    failureReason = err.message;
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
      if (await tryResolve(entry.directory)) return _b42Map;
    }
  } catch (err) {
    failureReason = failureReason || err.message;
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

async function getB42Dir() {
  return (await getB42Map()).directory;
}

function getB42ResolutionStatus() {
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

function isCircuitOpen() {
  return Date.now() < circuitOpenUntil;
}

function recordTileSuccess() {
  circuitConsecutiveFailures = 0;
}

function recordTileFailure() {
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

async function fetchTileWithTimeout(url) {
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

async function fetchTileWithRetry(url) {
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

function requestIsVersioned(req) {
  const v = Array.isArray(req.query.v) ? req.query.v[0] : req.query.v;
  return typeof v === "string" && v.length > 0;
}

async function serveTile(req, res, url, contentType, relPath, cacheControl) {
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
      return res.status(status).end();
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    memCachePut(relPath, buffer, contentType);
    writeDiskCacheAsync(relPath, buffer);
    res.set("Content-Type", contentType);
    res.set("Cache-Control", cacheControl);
    res.set("X-Tile-Cache", "miss");
    res.send(buffer);
  } catch (err) {
    log.debug(`Tile proxy failed for ${url}: ${err.message}`);
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

let persistedVehicleCache = { key: null, expiresAt: 0, vehicles: [] };

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
  } catch (err) {
    log.warn(`Persisted vehicle lookup failed: ${err.message}`);
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
