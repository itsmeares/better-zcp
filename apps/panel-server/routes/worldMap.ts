import * as zlib from "node:zlib";
import path from "node:path";
import { Router } from "../http/apiRouter.ts";
import type { Request, Response } from "../http/apiRouter.ts";
import { getCurrentServerContext } from "../services/sandboxPersistence.ts";
import { readRegularFile } from "../utils/regularFile.ts";
import { createLogger } from "../utils/logger.ts";
import { parseIni } from "./serverFiles.ts";

const log = createLogger("API:WorldMap");
const router = Router();

const PZ_MAP_ROOT = "https://pzmap.org";
const PZ_TILES_ROOT = "https://tiles.pzmap.org";
const FETCH_TIMEOUT_MS = 8_000;
const RESOLVE_TIMEOUT_MS = 12_000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 24;
const CACHE_VALUE_MAX_BYTES = 8 * 1024 * 1024;
const CACHE_TOTAL_MAX_BYTES = 32 * 1024 * 1024;
const MAX_MAP_OVERLAYS = 16;
const MAX_LOOT_POINTS = 100;
const MAX_LOOT_CHUNKS = 9;
const MAX_COMPRESSED_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_DECOMPRESSED_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_COVERAGE_PAIRS = 600_000;
const MAX_COVERAGE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_CELL_RECTS = 4_096;
const DEFAULT_MAP = "Muldraugh, KY";

type ProviderFailure = {
  origin: string;
  status: "ok" | "error" | "unknown";
  statusCode?: number;
  error?: string;
};
type WorldMapDiagnostics = {
  provider: ProviderFailure;
  tiles: { origin: string; mode: "direct"; referrerPolicy: "no-referrer" };
  available: boolean;
  version?: string;
  error?: string;
};
type WorldMapLayer = {
  id: string;
  name: string;
  tileRoot: string;
  width: number;
  height: number;
  tileSize: number;
  format: "webp" | "jpg" | "jpeg" | "png";
  composite: boolean;
  cellSize: number;
  cellRects: Array<[number, number, number, number]>;
  x0: number;
  y0: number;
  sqr: number;
  scale: number;
  minFloor: number;
  maxFloor: number;
};
type MapBuild = {
  version: string;
  label: string;
  maps: Array<{ id: string; name: string }>;
};
type CacheValue = { value: unknown; expiresAt: number; bytes: number };

class ProviderError extends Error {
  readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "ProviderError";
    this.statusCode = statusCode;
  }
}

const cache = new Map<string, CacheValue>();
const inflight = new Map<string, Promise<unknown>>();
let cacheBytes = 0;
let lastProvider: ProviderFailure = { origin: PZ_MAP_ROOT, status: "unknown" };
let lastResolvedVersion: string | undefined;
let lastProviderError: string | undefined;

function noteProviderSuccess(origin: string): void {
  lastProvider = { origin, status: "ok", statusCode: 200 };
  lastProviderError = undefined;
}

function noteProviderError(origin: string, error: unknown, statusCode?: number): void {
  const message = error instanceof Error ? error.message : String(error);
  lastProvider = { origin, status: "error", ...(statusCode ? { statusCode } : {}), error: message };
  lastProviderError = message;
}

function deleteCache(key: string): void {
  const previous = cache.get(key);
  if (!previous) return;
  cacheBytes -= previous.bytes;
  cache.delete(key);
}

function remember(key: string, value: unknown, bytes: number): void {
  if (bytes > CACHE_VALUE_MAX_BYTES) return;
  deleteCache(key);
  while (cache.size >= CACHE_MAX || cacheBytes + bytes > CACHE_TOTAL_MAX_BYTES) {
    deleteCache(cache.keys().next().value!);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS, bytes });
  cacheBytes += bytes;
}

async function readLimited(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new ProviderError(`Provider response exceeded ${maxBytes} bytes`, 502);
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ProviderError(`Provider response exceeded ${maxBytes} bytes`, 502);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function fetchProviderBody(
  origin: string,
  relativePath: string,
  maxBytes: number,
  deadline?: AbortSignal,
): Promise<Buffer> {
  if ((origin !== PZ_MAP_ROOT && origin !== PZ_TILES_ROOT) || !relativePath.startsWith("/")) {
    throw new ProviderError("Invalid provider request", 400);
  }
  const url = new URL(relativePath, origin);
  if (url.origin !== origin) throw new ProviderError("Invalid provider request", 400);

  let response: globalThis.Response;
  try {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    response = await fetch(url, {
      signal: deadline ? AbortSignal.any([timeout, deadline]) : timeout,
      redirect: "error",
      headers: { Accept: "application/json, application/xml, application/octet-stream" },
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "TimeoutError"
      ? "Provider request timed out"
      : error instanceof Error && error.name === "AbortError"
        ? "Provider request exceeded the map request time limit"
        : `Provider request failed: ${error instanceof Error ? error.message : String(error)}`;
    noteProviderError(origin, message);
    throw new ProviderError(message);
  }

  if (!response.ok) {
    const challenge = response.headers.get("cf-mitigated") === "challenge"
      ? "; Cloudflare challenge"
      : "";
    const message = `PZMap provider returned HTTP ${response.status}${challenge}`;
    await response.body?.cancel();
    noteProviderError(origin, message, response.status);
    throw new ProviderError(message, response.status);
  }

  try {
    const body = await readLimited(response, maxBytes);
    noteProviderSuccess(origin);
    return body;
  } catch (error) {
    noteProviderError(origin, error, error instanceof ProviderError ? error.statusCode : undefined);
    throw error;
  }
}

async function providerJson<T>(
  origin: string,
  relativePath: string,
  maxBytes: number,
  deadline?: AbortSignal,
): Promise<T> {
  const key = `${origin}${relativePath}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    noteProviderSuccess(origin);
    return hit.value as T;
  }
  if (hit) deleteCache(key);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    const body = await fetchProviderBody(origin, relativePath, maxBytes, deadline);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      const error = new ProviderError("PZMap provider returned invalid JSON", 502);
      noteProviderError(origin, error, 502);
      throw error;
    }
    remember(key, value, body.byteLength);
    return value as T;
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function providerText(
  origin: string,
  relativePath: string,
  maxBytes: number,
  deadline?: AbortSignal,
): Promise<string> {
  const key = `${origin}${relativePath}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, hit);
    noteProviderSuccess(origin);
    return hit.value as string;
  }
  if (hit) deleteCache(key);
  const pending = inflight.get(key);
  if (pending) return pending as Promise<string>;
  const promise = (async () => {
    const body = await fetchProviderBody(origin, relativePath, maxBytes, deadline);
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(body);
      remember(key, value, body.byteLength);
      return value;
    } catch {
      const error = new ProviderError("PZMap provider returned invalid text", 502);
      noteProviderError(origin, error, 502);
      throw error;
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function providerDataError(message: string, origin = PZ_MAP_ROOT): never {
  noteProviderError(origin, message, 502);
  throw new ProviderError(message, 502);
}

function validB42Version(value: unknown): value is string {
  return typeof value === "string" && /^42\.\d{1,3}\.\d{1,3}$/.test(value);
}

function validMapId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function getBuildMaps(value: unknown): MapBuild["maps"] {
  if (!Array.isArray(value)) providerDataError("PZMap build metadata has no mod_maps list");
  const maps: MapBuild["maps"] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const properties = Object.entries(entry);
    if (properties.length !== 1) continue;
    const [id, name] = properties[0];
    if (!validMapId(id) || typeof name !== "string" || !name.trim() || name.length > 120) continue;
    maps.push({ id, name: name.trim() });
  }
  return maps;
}

async function getDefaultBuild(deadline?: AbortSignal): Promise<MapBuild> {
  const raw = await providerJson<Record<string, unknown>>(
    PZ_MAP_ROOT,
    "/api/builds/default",
    512 * 1024,
    deadline,
  );
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !validB42Version(raw.directory) || raw.available === false) {
    providerDataError("PZMap default build is unavailable or is not a supported B42 build");
  }
  const build = {
    version: raw.directory,
    label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : `Build ${raw.directory}`,
    maps: getBuildMaps(raw.mod_maps),
  };
  lastResolvedVersion = build.version;
  return build;
}

function finite(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown, max: number): number | null {
  const number = finite(value);
  return Number.isSafeInteger(number) && number! > 0 && number! <= max ? number! : null;
}

function validateCellRects(
  value: unknown,
  cellSize: number,
  required: boolean,
): Array<[number, number, number, number]> {
  if (value === undefined || value === null) {
    if (required) providerDataError("PZMap mod map has no cell bounds", PZ_TILES_ROOT);
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CELL_RECTS) {
    providerDataError("PZMap returned invalid cell bounds", PZ_TILES_ROOT);
  }
  if (value.length === 0 && required) providerDataError("PZMap mod map has no cell bounds", PZ_TILES_ROOT);

  const rects: Array<[number, number, number, number]> = [];
  for (const rect of value) {
    if (
      !Array.isArray(rect) || rect.length !== 4 ||
      !rect.every((part) => Number.isSafeInteger(part))
    ) {
      providerDataError("PZMap returned invalid cell bounds", PZ_TILES_ROOT);
    }
    const [x, y, width, height] = rect as number[];
    if (
      x < 0 || y < 0 || width < 1 || height < 1 ||
      x + width > 65_536 || y + height > 65_536 ||
      width * height > 16_000_000 || cellSize < 1
    ) {
      providerDataError("PZMap returned out-of-range cell bounds", PZ_TILES_ROOT);
    }
    rects.push([x, y, width, height]);
  }
  return rects;
}

function surfaceComposite(info: Record<string, unknown>): boolean {
  if (typeof info.composite === "boolean") return info.composite;
  if (typeof info.surface_composite === "boolean") return info.surface_composite;
  if (typeof info.basement_composite === "boolean") return false;
  providerDataError("PZMap map metadata has no validated composite floor mode", PZ_TILES_ROOT);
}

function dziAttribute(xml: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]+)"`).exec(xml)?.[1] ?? null;
}

async function loadLayer(
  version: string,
  id: string,
  name: string,
  relativeRoot: string,
  deadline: AbortSignal,
  floor = 0,
  knownInfo?: Record<string, unknown>,
): Promise<WorldMapLayer> {
  const infoPromise = knownInfo ? Promise.resolve(knownInfo) : providerJson<Record<string, unknown>>(
      PZ_TILES_ROOT,
      `/${version}/${relativeRoot}map_info.json`,
      512 * 1024,
      deadline,
    );
  const [info, dzi] = await Promise.all([
    infoPromise,
    providerText(
      PZ_TILES_ROOT,
      `/${version}/${relativeRoot}layer${floor}.dzi`,
      32 * 1024,
      deadline,
    ),
  ]);
  const sizeTag = /<Size\b[^>]*>/i.exec(dzi)?.[0] || "";
  const width = positiveInteger(dziAttribute(sizeTag, "Width"), 100_000_000);
  const height = positiveInteger(dziAttribute(sizeTag, "Height"), 100_000_000);
  const tileSize = positiveInteger(dziAttribute(dzi, "TileSize"), 16_384);
  const infoWidth = positiveInteger(info.w, 100_000_000);
  const infoHeight = positiveInteger(info.h, 100_000_000);
  const infoTileSize = positiveInteger(info.tile_size, 16_384);
  const format = dziAttribute(dzi, "Format")?.toLowerCase();
  const x0 = finite(info.x0);
  const y0 = finite(info.y0);
  const sqr = finite(info.sqr);
  const cellSize = positiveInteger(info.cell_size, 4_096);
  const cellRects = validateCellRects(info.cell_rects, cellSize || 0, id !== "base");
  const composite = surfaceComposite(info);
  const skip = finite(info.skip);
  const minFloor = finite(info.minlayer);
  const maxLayer = finite(info.maxlayer);

  if (
    !width || !height || !tileSize || width !== infoWidth || height !== infoHeight ||
    tileSize !== infoTileSize || !["jpg", "jpeg", "png", "webp"].includes(format || "") ||
    x0 === null || y0 === null || sqr === null || sqr <= 0 || !cellSize ||
    !Number.isInteger(skip) || skip! < 0 || skip! > 12 ||
    !Number.isInteger(minFloor) || !Number.isInteger(maxLayer) ||
    minFloor! < -128 || maxLayer! > 128 || maxLayer! <= minFloor! ||
    floor < minFloor! || floor >= maxLayer!
  ) {
    providerDataError(`PZMap returned invalid geometry for ${id}`, PZ_TILES_ROOT);
  }

  return {
    id,
    name,
    tileRoot: `${PZ_TILES_ROOT}/${version}/${relativeRoot}`,
    width,
    height,
    tileSize,
    format: format as WorldMapLayer["format"],
    composite,
    cellSize,
    cellRects,
    x0,
    y0,
    sqr,
    scale: 2 ** skip!,
    minFloor: minFloor!,
    maxFloor: maxLayer! - 1,
  };
}

function normalizedMapName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function readMapOrder(): Promise<{ mapOrder: string[]; warnings: string[]; readable: boolean }> {
  const warnings: string[] = [];
  try {
    const context = await getCurrentServerContext();
    if (!context.serverConfigPath || !context.serverName) {
      return { mapOrder: [], warnings: ["Active server INI is unavailable; map overlays were not resolved."], readable: false };
    }
    const iniPath = path.join(context.serverConfigPath, `${context.serverName}.ini`);
    const settings = parseIni(readRegularFile(iniPath, 1024 * 1024));
    const mapEntry = Object.entries(settings).find(([key]) => key.toLowerCase() === "map");
    if (!mapEntry) {
      warnings.push(`Map= is unset; using the Project Zomboid default (${DEFAULT_MAP}).`);
      return { mapOrder: [DEFAULT_MAP], warnings, readable: true };
    }
    if (!String(mapEntry[1]).trim()) {
      return { mapOrder: [], warnings: ["Active server INI has an empty Map= setting; no map layers were loaded."], readable: true };
    }
    const mapOrder = String(mapEntry[1]).split(";").map((map) => map.trim()).filter(Boolean);
    if (mapOrder.length === 0) {
      return { mapOrder: [], warnings: ["Active server INI has no usable Map= entries; no map layers were loaded."], readable: true };
    }
    if (mapOrder.length > 64 || mapOrder.some((map) => map.length > 128)) {
      return { mapOrder: [], warnings: ["Active server INI has too many Map= entries; no map layers were loaded."], readable: true };
    }
    return {
      mapOrder,
      warnings,
      readable: true,
    };
  } catch (error) {
    log.warn(`Could not read active server INI for map resolution: ${error instanceof Error ? error.message : String(error)}`);
    warnings.push("Could not read the active server INI; map overlays were not resolved.");
    return { mapOrder: [], warnings, readable: false };
  }
}

function isVanillaMap(value: string): boolean {
  return normalizedMapName(value) === normalizedMapName(DEFAULT_MAP);
}

async function resolveWorldMap(): Promise<{
  version: string;
  label: string;
  layers: WorldMapLayer[];
  mapOrder: string[];
  warnings: string[];
}> {
  const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
  const [build, config] = await Promise.all([getDefaultBuild(deadline), readMapOrder()]);
  const warnings = [...config.warnings];
  const mapByName = new Map<string, MapBuild["maps"][number]>();
  for (const map of build.maps) {
    mapByName.set(normalizedMapName(map.id), map);
    mapByName.set(normalizedMapName(map.name), map);
  }

  const configured: Array<{ id: string; name: string; root: string } | null> = config.mapOrder.map((entry) => {
    if (isVanillaMap(entry)) return { id: "base", name: "Base map", root: "base/" };
    const map = mapByName.get(normalizedMapName(entry));
    return map ? { id: map.id, name: map.name, root: `mod_maps/${map.id}/base/` } : null;
  });
  for (const [index, entry] of config.mapOrder.entries()) {
    if (!configured[index]) warnings.push(`Map=${entry} is not available from PZMap and was skipped.`);
  }

  const selected: Array<{ id: string; name: string; root: string }> = [];
  const selectedIds = new Set<string>();
  let overlayCount = 0;
  for (const map of configured) {
    if (!map || selectedIds.has(map.id)) continue;
    if (map.id !== "base" && overlayCount >= MAX_MAP_OVERLAYS) {
      warnings.push(`Only the first ${MAX_MAP_OVERLAYS} configured PZMap overlays were resolved.`);
      continue;
    }
    selectedIds.add(map.id);
    selected.push(map);
    if (map.id !== "base") overlayCount += 1;
  }

  const ordered = selected.reverse();
  const layerResults = await Promise.allSettled(ordered.map((map) =>
    loadLayer(build.version, map.id, map.name, map.root, deadline),
  ));
  const layers: WorldMapLayer[] = [];
  let firstFailure: unknown;
  let legacyLayerCount = 0;
  for (let i = 0; i < layerResults.length; i += 1) {
    const result = layerResults[i];
    if (result.status === "fulfilled" && result.value.composite) layers.push(result.value);
    else if (result.status === "fulfilled") {
      legacyLayerCount += 1;
      warnings.push(`PZMap layer ${ordered[i].name} uses legacy non-composite floors and was skipped.`);
    }
    else {
      firstFailure ||= result.reason;
      const detail = result.reason instanceof Error ? ` (${result.reason.message})` : "";
      warnings.push(`PZMap layer ${ordered[i].name} is unavailable and was skipped${detail}.`);
    }
  }
  if (config.readable && selected.length > 0 && layers.length === 0) {
    if (firstFailure instanceof ProviderError) throw firstFailure;
    if (legacyLayerCount > 0) {
      throw new ProviderError("PZMap configured maps use a non-composite floor dataset that this viewer cannot render");
    }
    throw new ProviderError("PZMap could not provide geometry for the configured maps");
  }
  return {
    version: build.version,
    label: build.label,
    layers,
    mapOrder: config.mapOrder,
    warnings,
  };
}

type MapTileRoot = { id: string; name: string; relativeRoot: string };

function mapTileRoot(build: MapBuild, id: string): MapTileRoot | null {
  if (id === "base") return { id, name: "Base map", relativeRoot: "base/" };
  const map = build.maps.find((entry) => entry.id === id);
  return map ? { id, name: map.name, relativeRoot: `mod_maps/${map.id}/base/` } : null;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

type WorldMapCoverage = {
  ground: number;
  levels: Record<string, Record<string, Array<[number, number]>>>;
};

function validateCoverage(value: unknown, layer: WorldMapLayer): WorldMapCoverage {
  if (!objectRecord(value) || !objectRecord(value.levels)) {
    providerDataError("PZMap returned invalid layer coverage metadata", PZ_TILES_ROOT);
  }
  const ground = finite(value.ground);
  if (!Number.isInteger(ground) || ground! < layer.minFloor || ground! > layer.maxFloor) {
    providerDataError("PZMap returned an invalid coverage ground floor", PZ_TILES_ROOT);
  }

  const maxLevel = Math.ceil(Math.log2(Math.max(layer.width, layer.height)));
  const levelEntries = Object.entries(value.levels);
  if (levelEntries.length === 0 || levelEntries.length > maxLevel + 1) {
    providerDataError("PZMap returned an invalid coverage pyramid", PZ_TILES_ROOT);
  }

  const levels: WorldMapCoverage["levels"] = {};
  let pairCount = 0;
  for (const [levelKey, rawFloors] of levelEntries) {
    if (!/^(0|[1-9]\d*)$/.test(levelKey) || !objectRecord(rawFloors)) {
      providerDataError("PZMap returned an invalid coverage level", PZ_TILES_ROOT);
    }
    const level = Number(levelKey);
    if (!Number.isSafeInteger(level) || level > maxLevel) {
      providerDataError("PZMap returned a coverage level outside the DZI pyramid", PZ_TILES_ROOT);
    }
    const levelScale = 2 ** (maxLevel - level);
    const tilesWide = Math.ceil(Math.ceil(layer.width / levelScale) / layer.tileSize);
    const tilesHigh = Math.ceil(Math.ceil(layer.height / levelScale) / layer.tileSize);
    const floorEntries = Object.entries(rawFloors);
    if (floorEntries.length === 0 || floorEntries.length > layer.maxFloor - layer.minFloor + 1) {
      providerDataError("PZMap returned an invalid coverage floor list", PZ_TILES_ROOT);
    }
    const floors: Record<string, Array<[number, number]>> = {};
    for (const [floorKey, rawPairs] of floorEntries) {
      if (!/^(0|-?[1-9]\d*)$/.test(floorKey) || !Array.isArray(rawPairs)) {
        providerDataError("PZMap returned an invalid coverage floor", PZ_TILES_ROOT);
      }
      const floor = Number(floorKey);
      if (!Number.isSafeInteger(floor) || floor < layer.minFloor || floor > layer.maxFloor) {
        providerDataError("PZMap returned a coverage floor outside map bounds", PZ_TILES_ROOT);
      }
      pairCount += rawPairs.length;
      if (pairCount > MAX_COVERAGE_PAIRS) {
        providerDataError("PZMap layer coverage exceeds the coordinate limit", PZ_TILES_ROOT);
      }
      const pairs: Array<[number, number]> = [];
      const seen = new Set<string>();
      for (const pair of rawPairs) {
        if (
          !Array.isArray(pair) || pair.length !== 2 ||
          !Number.isSafeInteger(pair[0]) || !Number.isSafeInteger(pair[1]) ||
          pair[0] < 0 || pair[1] < 0 || pair[0] >= tilesWide || pair[1] >= tilesHigh
        ) {
          providerDataError("PZMap returned invalid coverage tile coordinates", PZ_TILES_ROOT);
        }
        const coordinateKey = `${pair[0]}_${pair[1]}`;
        if (seen.has(coordinateKey)) {
          providerDataError("PZMap returned duplicate coverage tile coordinates", PZ_TILES_ROOT);
        }
        seen.add(coordinateKey);
        pairs.push([pair[0], pair[1]]);
      }
      floors[floorKey] = pairs;
    }
    levels[levelKey] = floors;
  }
  if (pairCount === 0) providerDataError("PZMap layer coverage contains no tiles", PZ_TILES_ROOT);
  return { ground: ground!, levels };
}

function versionFromQuery(req: Request): string | null {
  const value = Array.isArray(req.query.version) ? req.query.version[0] : req.query.version;
  return validB42Version(value) ? value : null;
}

function errorResponse(res: Response, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ProviderError && error.statusCode === 400 ? 400 : 503;
  if (!(error instanceof ProviderError)) noteProviderError(PZ_MAP_ROOT, message);
  return res.status(status).json({ error: message, code: "WORLD_MAP_UNAVAILABLE" });
}

router.get("/resolve", async (_req, res) => {
  try {
    const value = await resolveWorldMap();
    lastResolvedVersion = value.version;
    res.set("Cache-Control", "private, max-age=60");
    res.json(value);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get("/coverage", async (req, res) => {
  const version = versionFromQuery(req);
  const idValue = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = idValue === "base" || validMapId(idValue) ? idValue : null;
  if (!version || !id) return res.status(400).json({ error: "Invalid B42 version or map layer ID" });
  try {
    const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    const build = await getDefaultBuild(deadline);
    const tileRoot = mapTileRoot(build, id);
    if (!tileRoot) return res.status(404).json({ error: "Unknown PZMap layer ID" });
    const info = await providerJson<Record<string, unknown>>(
      PZ_TILES_ROOT,
      `/${version}/${tileRoot.relativeRoot}map_info.json`,
      512 * 1024,
      deadline,
    );
    const minFloor = finite(info.minlayer);
    const maxLayer = finite(info.maxlayer);
    if (
      !Number.isInteger(minFloor) || !Number.isInteger(maxLayer) ||
      minFloor! < -128 || maxLayer! > 128 || maxLayer! <= minFloor!
    ) {
      providerDataError("PZMap returned invalid layer floor bounds", PZ_TILES_ROOT);
    }
    if (!surfaceComposite(info)) return res.status(409).json({ error: "PZMap layer does not use composite floors" });
    const geometryFloor = Math.max(minFloor!, Math.min(0, maxLayer! - 1));
    const [layer, raw] = await Promise.all([
      loadLayer(version, id, tileRoot.name, tileRoot.relativeRoot, deadline, geometryFloor, info),
      providerJson<unknown>(
        PZ_TILES_ROOT,
        `/${version}/${tileRoot.relativeRoot}layer_coverage.json`,
        MAX_COVERAGE_BODY_BYTES,
        deadline,
      ),
    ]);
    res.set("Cache-Control", "private, max-age=300");
    res.json(validateCoverage(raw, layer));
  } catch (error) {
    errorResponse(res, error);
  }
});

function integerQueryField(value: unknown): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "number") return Number.isSafeInteger(candidate) ? candidate : null;
  if (typeof candidate !== "string" || !/^(0|-?[1-9]\d*)$/.test(candidate)) return null;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

router.get("/floor", async (req, res) => {
  const version = versionFromQuery(req);
  const idValue = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const id = idValue === "base" || validMapId(idValue) ? idValue : null;
  const floor = integerQueryField(req.query.floor);
  if (!version || !id || floor === null) {
    return res.status(400).json({ error: "Invalid B42 version, map layer ID, or floor" });
  }
  try {
    const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    const build = await getDefaultBuild(deadline);
    const tileRoot = mapTileRoot(build, id);
    if (!tileRoot) return res.status(404).json({ error: "Unknown PZMap layer ID" });
    const info = await providerJson<Record<string, unknown>>(
      PZ_TILES_ROOT,
      `/${version}/${tileRoot.relativeRoot}map_info.json`,
      512 * 1024,
      deadline,
    );
    const minFloor = finite(info.minlayer);
    const maxLayer = finite(info.maxlayer);
    if (
      !Number.isInteger(minFloor) || !Number.isInteger(maxLayer) ||
      minFloor! < -128 || maxLayer! > 128 || maxLayer! <= minFloor! ||
      floor < minFloor! || floor >= maxLayer!
    ) {
      return res.status(400).json({ error: "Floor is outside the map layer bounds" });
    }
    const layer = await loadLayer(version, id, tileRoot.name, tileRoot.relativeRoot, deadline, floor, info);
    res.set("Cache-Control", "private, max-age=300");
    res.json({ format: layer.format });
  } catch (error) {
    errorResponse(res, error);
  }
});

function stringField(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : null;
}

function numberField(value: unknown): number | null {
  const number = finite(value);
  return number !== null && Math.abs(number) <= 10_000_000 ? number : null;
}

function normalizePois(value: unknown): Array<{ id: string; name: string; x: number; y: number; z: number; tags: string[] }> {
  if (!Array.isArray(value) || value.length > 10_000) providerDataError("PZMap returned an invalid POI list");
  const pois: Array<{ id: string; name: string; x: number; y: number; z: number; tags: string[] }> = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const id = stringField(row.ID ?? row.id, 100) || (typeof row.ID === "number" ? String(row.ID) : null);
    const name = stringField(row.name, 200);
    const x = numberField(row.x);
    const y = numberField(row.y);
    const z = finite(row.layer) ?? 0;
    if (!id || !name || x === null || y === null || !Number.isInteger(z) || Math.abs(z) > 128) continue;
    const sourceTags = [
      ...(Array.isArray(row.tags) ? row.tags : []),
      ...(Array.isArray(row.Categories) ? row.Categories : []),
    ];
    const tags = [...new Set(sourceTags.map((tag) => stringField(tag, 80)).filter((tag): tag is string => !!tag))].slice(0, 30);
    pois.push({ id, name, x, y, z, tags });
  }
  return pois;
}

router.get("/pois", async (req, res) => {
  const version = versionFromQuery(req);
  if (!version) return res.status(400).json({ error: "Invalid B42 version" });
  try {
    const data = await providerJson<unknown>(PZ_MAP_ROOT, `/api/pois/for-version/${version}`, 8 * 1024 * 1024);
    const pois = normalizePois(data);
    res.set("Cache-Control", "private, max-age=60");
    res.json({ pois });
  } catch (error) {
    errorResponse(res, error);
  }
});

type LootType = { id: string; name: string; total: number };
type LootCatalog = { cell_size?: unknown; types?: unknown };
type LootTypeIndex = { cells?: unknown; cell_size?: unknown };

function lootSlug(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_-]{1,80}$/.test(value);
}

function normalizeLootTypes(catalog: LootCatalog): LootType[] {
  if (!Array.isArray(catalog.types) || catalog.types.length > 1_000) {
    providerDataError("PZMap returned an invalid container catalog");
  }
  return catalog.types.flatMap((row: any) => {
    const id = lootSlug(row?.slug) ? row.slug : null;
    const total = finite(row?.total);
    if (!id || !Number.isSafeInteger(total) || total! < 0) return [];
    const name = id.split(/[-_]/).map((part: string) => part ? part[0].toUpperCase() + part.slice(1) : "").join(" ");
    return [{ id, name, total: total! }];
  });
}

async function getLootCatalog(version: string, deadline?: AbortSignal): Promise<LootCatalog> {
  return providerJson<LootCatalog>(
    PZ_TILES_ROOT,
    `/${version}/tiles/containers/catalog.json`,
    2 * 1024 * 1024,
    deadline,
  );
}

router.get("/loot-types", async (req, res) => {
  const version = versionFromQuery(req);
  if (!version) return res.status(400).json({ error: "Invalid B42 version" });
  try {
    const catalog = await getLootCatalog(version);
    res.set("Cache-Control", "private, max-age=60");
    res.json({ types: normalizeLootTypes(catalog) });
  } catch (error) {
    errorResponse(res, error);
  }
});

function isPzcr(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "PZCR";
}

function decodeLootChunk(bytes: Buffer, filename: string, compression: unknown): Buffer {
  if (isPzcr(bytes)) return bytes;
  const format = typeof compression === "string" && compression
    ? compression
    : filename.endsWith(".gz") ? "gzip" : filename.endsWith(".zst") ? "zstd" : "";
  try {
    if (format === "gzip") {
      return zlib.gunzipSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_CHUNK_BYTES });
    }
    if (format === "zstd") {
      // Runtime check keeps the Node 22.13 minimum working for raw/gzip chunks.
      if (typeof zlib.zstdDecompressSync !== "function") {
        throw new Error("Zstd container chunks require Node 22.15 or newer");
      }
      return zlib.zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_CHUNK_BYTES });
    }
  } catch (error) {
    throw new ProviderError(`Could not decompress PZMap container chunk: ${error instanceof Error ? error.message : String(error)}`, 502);
  }
  throw new ProviderError("PZMap container chunk uses an unsupported compression format", 502);
}

function parsePzcr(bytes: Buffer, cellKey: string, expectedCellSize: number): Array<{ x: number; y: number; z: number }> {
  if (bytes.length < 15 || !isPzcr(bytes)) throw new ProviderError("Invalid PZCR container chunk", 502);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  const cellX = view.getUint16(5, true);
  const cellY = view.getUint16(7, true);
  const cellSize = view.getUint16(9, true);
  const count = view.getUint32(11, true);
  const [expectedX, expectedY] = cellKey.split("_").map(Number);
  if (
    version !== 1 || !cellSize || cellSize > 256 || cellSize !== expectedCellSize ||
    cellX !== expectedX || cellY !== expectedY || count > 100_000 ||
    bytes.length !== 15 + count * 3
  ) {
    throw new ProviderError("Invalid PZCR container chunk header or point count", 502);
  }
  const points: Array<{ x: number; y: number; z: number }> = [];
  for (let offset = 15; offset < bytes.length; offset += 3) {
    const localX = view.getUint8(offset);
    const localY = view.getUint8(offset + 1);
    if (localX >= cellSize || localY >= cellSize) {
      throw new ProviderError("Invalid PZCR local coordinates", 502);
    }
    points.push({
      x: cellX * cellSize + localX,
      y: cellY * cellSize + localY,
      z: view.getInt8(offset + 2),
    });
  }
  return points;
}

async function lootCellPoints(
  version: string,
  type: string,
  cellKey: string,
  cellSize: number,
  index: LootTypeIndex,
  deadline?: AbortSignal,
): Promise<Array<{ x: number; y: number; z: number }>> {
  const cells = index.cells;
  if (!cells || typeof cells !== "object" || Array.isArray(cells)) {
    providerDataError("PZMap returned an invalid container index");
  }
  const entry = (cells as Record<string, unknown>)[cellKey] as { f?: unknown; c?: unknown } | undefined;
  if (!entry) return [];
  const filename = entry.f;
  if (typeof filename !== "string" || !/^[A-Za-z0-9_-]{1,120}(?:\.pzcr)?(?:\.(?:gz|zst))?$/.test(filename)) {
    providerDataError("PZMap returned an invalid container chunk path", PZ_TILES_ROOT);
  }
  const bytes = await fetchProviderBody(
    PZ_TILES_ROOT,
    `/${version}/tiles/containers/${type}/${filename}`,
    MAX_COMPRESSED_CHUNK_BYTES,
    deadline,
  );
  return parsePzcr(decodeLootChunk(bytes, filename, entry.c), cellKey, cellSize);
}

router.get("/loot", async (req, res) => {
  const version = versionFromQuery(req);
  const typeValue = Array.isArray(req.query.type) ? req.query.type[0] : req.query.type;
  const type = lootSlug(typeValue) ? typeValue : null;
  const x = finite(Array.isArray(req.query.x) ? req.query.x[0] : req.query.x);
  const y = finite(Array.isArray(req.query.y) ? req.query.y[0] : req.query.y);
  const z = finite(Array.isArray(req.query.z) ? req.query.z[0] : req.query.z);
  if (!version || !type || x === null || y === null || z === null || !Number.isInteger(z) || x < 0 || y < 0 || x > 10_000_000 || y > 10_000_000 || Math.abs(z) > 128) {
    return res.status(400).json({ error: "Invalid version, type, or coordinates" });
  }

  try {
    const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    const catalog = await getLootCatalog(version, deadline);
    const types = normalizeLootTypes(catalog);
    if (!types.some((entry) => entry.id === type)) return res.status(404).json({ error: "Unknown container type" });
    const index = await providerJson<LootTypeIndex>(
      PZ_TILES_ROOT,
      `/${version}/tiles/containers/${type}/index.json`,
      4 * 1024 * 1024,
      deadline,
    );
    const cellSize = positiveInteger(catalog.cell_size, 4096);
    if (!cellSize) providerDataError("PZMap returned an invalid container cell size", PZ_TILES_ROOT);
    const cellX = Math.floor(x / cellSize);
    const cellY = Math.floor(y / cellSize);
    const cellKeys: string[] = [];
    for (let cy = cellY - 1; cy <= cellY + 1; cy += 1) {
      for (let cx = cellX - 1; cx <= cellX + 1; cx += 1) {
        if (cx >= 0 && cy >= 0 && cx <= 65_535 && cy <= 65_535) cellKeys.push(`${cx}_${cy}`);
      }
    }
    const results = await Promise.all(cellKeys.slice(0, MAX_LOOT_CHUNKS).map((key) =>
      lootCellPoints(version, type, key, cellSize, index, deadline),
    ));
    const nearby = results.flat().filter((point) => point.z === z).sort((a, b) =>
      (a.x - x) ** 2 + (a.y - y) ** 2 - ((b.x - x) ** 2 + (b.y - y) ** 2),
    );
    res.set("Cache-Control", "private, max-age=30");
    res.json({ points: nearby.slice(0, MAX_LOOT_POINTS), truncated: nearby.length > MAX_LOOT_POINTS });
  } catch (error) {
    errorResponse(res, error);
  }
});

export async function getWorldMapDiagnostics(): Promise<WorldMapDiagnostics> {
  let available = false;
  let version: string | undefined;
  let error = lastProviderError;
  try {
    const deadline = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    const build = await getDefaultBuild(deadline);
    await loadLayer(build.version, "base", "Base map", "base/", deadline);
    available = true;
    version = build.version;
    error = undefined;
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  return {
    provider: { ...lastProvider, ...(error ? { error } : {}) },
    tiles: { origin: PZ_TILES_ROOT, mode: "direct", referrerPolicy: "no-referrer" },
    available,
    ...(version || lastResolvedVersion ? { version: version || lastResolvedVersion } : {}),
    ...(error ? { error } : {}),
  };
}

export default router;
