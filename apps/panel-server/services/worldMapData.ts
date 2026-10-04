import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import unzipper from "unzipper";
import { getCurrentServerContext } from "./sandboxPersistence.ts";
import { findMapFolderPathsFromWorkshop } from "../utils/workshopMaps.ts";
import { parseIni } from "../routes/serverFiles.ts";
import { readRegularFile } from "../utils/regularFile.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("WorldMapData");

const DEFAULT_MAP = "Muldraugh, KY";
// B42 cells are 256 squares; worldmap.xml still uses the old 300-square cells.
const CELL = 256;
const FEATURE_CELL = 300;
const CHUNK = 8;
const DENSITY_SIZE = (CELL / CHUNK) ** 2;
const TILE = 256;
// Web Mercator zoom at which one pyramid level-0 tile (256 squares) is one map tile.
export const PYRAMID_ZOOM = 7;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_CACHED = 4;
const SEARCH_LIMIT = 20;

type Rect = [number, number, number, number];
type ZipEntry = { path: string; type: string; buffer(): Promise<Buffer> };
type Ring = Array<[number, number]>;

export type Room = { name: string; z: number; rects: Rect[] };
export type LotHeader = { rooms: Room[]; density: Uint8Array };
export type MapFeature = { kind: string; value: string; roomTone?: string; name?: string; type: string; rings: Ring[] };
export type Street = { name: string; width: number; points: Ring };
export type MapLabel = { text: string; x: number; y: number; rotation: number; scale: number; layer: string };
type Pyramid = {
  file: string;
  entries: Map<string, ZipEntry>;
  originX: number;
  originY: number;
  maxLevel: number;
};
type Folder = { name: string; dir: string; source: "vanilla" | "workshop" };
type SearchEntry = {
  kind: "town" | "place" | "street" | "building" | "room";
  label: string;
  norm: string;
  /** Nearest town, so results with the same name can be told apart. */
  area?: string;
  x: number;
  y: number;
  z: number;
};
export type MapSearchResult = Omit<SearchEntry, "norm">;

export type WorldMapData = {
  key: string;
  folders: Array<Folder & { pyramid: Pyramid | null }>;
  bounds: [number, number, number, number] | null;
  floors: { min: number; max: number };
  warnings: string[];
  features: Buffer;
  rooms: Map<number, Buffer>;
  density: Buffer;
  search: SearchEntry[];
};

// ---------- parsers ----------

/** B42 .lotheader: tile names, then rooms (with floor), buildings, and a 32x32 zombie density grid. */
export function parseLotHeader(buffer: Buffer, cellX: number, cellY: number): LotHeader {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  const int = () => {
    if (offset + 4 > buffer.length) throw new Error("lotheader ended early");
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const count = (max: number) => {
    const value = int();
    if (value < 0 || value > max) throw new Error("lotheader count out of range");
    return value;
  };
  const line = () => {
    const end = buffer.indexOf(10, offset);
    if (end < 0) throw new Error("lotheader string not terminated");
    const value = buffer.toString("latin1", offset, end);
    offset = end + 1;
    return value;
  };

  if (buffer.toString("latin1", 0, 4) !== "LOTH") throw new Error("not a lotheader");
  offset = 4;
  const version = int();
  if (version !== 1) throw new Error(`unsupported lotheader version ${version}`);
  for (let names = count(1_000_000); names > 0; names--) line();
  int(); int(); int(); int(); // chunk width/height, min/max level
  const roomX = cellX * CELL;
  const roomY = cellY * CELL;
  const rooms: Room[] = [];
  for (let roomCount = count(1_000_000); roomCount > 0; roomCount--) {
    const name = line();
    const z = int();
    const rects: Rect[] = [];
    for (let rectCount = count(100_000); rectCount > 0; rectCount--) {
      rects.push([roomX + int(), roomY + int(), int(), int()]);
    }
    const objects = count(1_000_000); // room objects: type, x, y
    offset += objects * 12;
    rooms.push({ name, z, rects });
  }
  for (let buildings = count(1_000_000); buildings > 0; buildings--) {
    const roomIds = count(1_000_000);
    offset += roomIds * 4;
  }
  if (buffer.length - offset !== DENSITY_SIZE) throw new Error("lotheader size does not match its contents");
  return { rooms, density: buffer.subarray(offset) };
}

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => xmlEntities[name]);

/** worldmap.xml as written by WorldEd. Returns features grouped by their 300-square cell. */
export function parseWorldMapXml(xml: string): Map<string, MapFeature[]> {
  const cells = new Map<string, MapFeature[]>();
  for (const cell of xml.matchAll(/<cell x="(-?\d+)" y="(-?\d+)">([\s\S]*?)<\/cell>/g)) {
    const originX = Number(cell[1]) * FEATURE_CELL;
    const originY = Number(cell[2]) * FEATURE_CELL;
    const features: MapFeature[] = [];
    for (const feature of cell[3].matchAll(/<feature>([\s\S]*?)<\/feature>/g)) {
      const type = /<geometry type="(\w+)"/.exec(feature[1])?.[1] ?? "";
      const rings = [...feature[1].matchAll(/<coordinates>([\s\S]*?)<\/coordinates>/g)].map((ring) =>
        [...ring[1].matchAll(/<point x="(-?[\d.]+)" y="(-?[\d.]+)"/g)].map(
          (point) => [originX + Number(point[1]), originY + Number(point[2])] as [number, number],
        ),
      );
      const properties = Object.fromEntries(
        [...feature[1].matchAll(/<property name="([^"]*)" value="([^"]*)"/g)].map((p) => [p[1], decodeXml(p[2])]),
      );
      const kind = ["building", "water", "highway", "railway", "place"].find((name) => name in properties);
      if (!kind || rings.length === 0 || rings[0].length === 0) continue;
      features.push({
        kind,
        value: properties[kind],
        type,
        rings,
        ...(properties.RoomTone ? { roomTone: properties.RoomTone } : {}),
        ...(properties.name_en || properties.name ? { name: properties.name_en || properties.name } : {}),
      });
    }
    cells.set(`${cell[1]},${cell[2]}`, features);
  }
  return cells;
}

export function parseStreetsXml(xml: string): Street[] {
  return [...xml.matchAll(/<street name="([^"]*)"(?: width="([\d.]+)")?[^>]*>([\s\S]*?)<\/street>/g)].flatMap((street) => {
    const points = [...street[3].matchAll(/<point x="(-?[\d.]+)" y="(-?[\d.]+)"/g)].map(
      (point) => [Number(point[1]), Number(point[2])] as [number, number],
    );
    const name = decodeXml(street[1]).trim();
    return name && points.length > 1 ? [{ name, width: Number(street[2]) || 8, points }] : [];
  });
}

/** worldmap-annotations.lua is read as text, never executed. */
export function parseAnnotations(lua: string, translations: Record<string, string>): MapLabel[] {
  return lua.split(/\baddUntranslatedText\(/).slice(1).flatMap((block) => {
    const call = /^\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(block);
    if (!call) return [];
    const key = call[1];
    const text = (translations[key] ?? key.replace(/^MapLabel_/, "").replace(/([a-z])([A-Z])/g, "$1 $2"))
      .replace(/<br\s*\/?>/gi, "\n");
    return [{
      text,
      layer: call[2],
      x: Number(call[3]),
      y: Number(call[4]),
      rotation: Number(/setRotation\((-?[\d.]+)\)/.exec(block)?.[1] ?? 0),
      scale: Number(/setScale\((-?[\d.]+)\)/.exec(block)?.[1] ?? 1),
    }];
  });
}

// ---------- folder resolution ----------

async function resolveFolders(): Promise<{ folders: Folder[]; warnings: string[]; installPath: string | null }> {
  const context = await getCurrentServerContext();
  const installPath: string | null = context.activeServer?.installPath || process.env.PZ_SERVER_PATH || null;
  const warnings: string[] = [];
  let settings: Record<string, string> = {};
  if (context.serverConfigPath && context.serverName) {
    try {
      settings = parseIni(readRegularFile(path.join(context.serverConfigPath, `${context.serverName}.ini`), 1024 * 1024));
    } catch (error) {
      log.warn(`Could not read server INI for the world map: ${error instanceof Error ? error.message : String(error)}`);
      warnings.push("Could not read the server INI, so the default map is shown.");
    }
  }
  const setting = (name: string) => Object.entries(settings).find(([key]) => key.toLowerCase() === name)?.[1] ?? "";
  const list = (value: string) => value.split(";").map((entry) => entry.trim()).filter(Boolean);
  const mapOrder = list(setting("map"));
  if (mapOrder.length === 0) mapOrder.push(DEFAULT_MAP);
  const workshopIds = list(setting("workshopitems")).filter((id) => /^\d{1,15}$/.test(id));

  if (!installPath) {
    warnings.push("The server install path is not set, so map files cannot be found.");
    return { folders: [], warnings, installPath };
  }

  let workshopFolders: Array<{ name: string; path: string }> | null = null;
  const folders: Folder[] = [];
  for (const entry of mapOrder) {
    if (path.basename(entry) !== entry || entry === "." || entry === "..") {
      warnings.push(`Map=${entry} is not a folder name and was skipped.`);
      continue;
    }
    workshopFolders ??= workshopIds.flatMap((id) => findMapFolderPathsFromWorkshop(id, installPath));
    const workshop = workshopFolders.find((folder) => folder.name === entry);
    const vanilla = path.join(installPath, "media", "maps", entry);
    if (workshop) folders.push({ name: entry, dir: workshop.path, source: "workshop" });
    else if (fs.existsSync(vanilla)) folders.push({ name: entry, dir: vanilla, source: "vanilla" });
    else warnings.push(`Map folder "${entry}" was not found in the install or workshop mods.`);
  }
  return { folders, warnings, installPath };
}

const SOURCE_FILES = ["worldmap.xml", "streets.xml", "worldmap-annotations.lua", "pyramid.zip"];

function folderKey(folders: Folder[]): string {
  const hash = crypto.createHash("sha1");
  for (const folder of folders) {
    hash.update(`${folder.dir}\0${statKey(folder.dir)}\0`);
    for (const file of SOURCE_FILES) hash.update(`${file}:${statKey(path.join(folder.dir, file))}\0`);
  }
  return hash.digest("hex").slice(0, 16);
}

function statKey(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return "-";
  }
}

// ---------- data build ----------

async function readText(file: string): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
    return await fs.promises.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function openPyramid(dir: string, warnings: string[], name: string): Promise<Pyramid | null> {
  const file = path.join(dir, "pyramid.zip");
  if (!fs.existsSync(file)) return null;
  try {
    const zip: { files: ZipEntry[] } = await unzipper.Open.file(file);
    const entries = new Map(zip.files.filter((entry) => entry.type === "File").map((entry) => [entry.path, entry]));
    const info = (await entries.get("pyramid.txt")?.buffer())?.toString("utf8") ?? "";
    const numbers = (key: string) =>
      new RegExp(`^${key}=(.*)$`, "m").exec(info)?.[1].trim().split(/\s+/).map(Number) ?? [];
    const [x0, y0, x1, y1] = numbers("bounds");
    const [width, height] = numbers("imageSize");
    const levels = [...entries.keys()].map((entry) => Number(/^(\d+)\//.exec(entry)?.[1])).filter(Number.isInteger);
    const maxLevel = Math.max(...levels);
    // ponytail: only 1 px per square, grid-aligned pyramids map onto map tiles directly; others need resampling.
    if (
      levels.length === 0 || !Number.isFinite(x0) || x1 - x0 !== width || y1 - y0 !== height ||
      x0 % (TILE << maxLevel) !== 0 || y0 % (TILE << maxLevel) !== 0 || maxLevel > PYRAMID_ZOOM
    ) {
      warnings.push(`The map image for "${name}" uses a layout the panel cannot show yet; its outlines are still drawn.`);
      return null;
    }
    return { file, entries, originX: x0, originY: y0, maxLevel };
  } catch (error) {
    warnings.push(`The map image for "${name}" could not be opened.`);
    log.warn(`Could not open ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function readTranslations(installPath: string | null): Promise<Record<string, string>> {
  if (!installPath) return {};
  const text = await readText(path.join(installPath, "media", "lua", "shared", "Translate", "EN", "MapLabel.json"));
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const humanize = (value: string) => value.replace(/([a-z])([A-Z])/g, "$1 $2");
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function centroid(rings: Ring[]): [number, number] {
  const ring = rings[0];
  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point[0];
    y += point[1];
  }
  return [x / ring.length, y / ring.length];
}

async function buildData(key: string, folders: Folder[], warnings: string[], installPath: string | null): Promise<WorldMapData> {
  const translations = await readTranslations(installPath);
  const takenFeatureCells = new Set<string>();
  const takenLotCells = new Set<string>();
  const features: object[] = [];
  const search: SearchEntry[] = [];
  const roomsByFloor = new Map<number, Array<[string, Rect[]]>>();
  const densityRows = new Map<number, Array<[number, number]>>();
  let bounds: [number, number, number, number] | null = null;
  const built: WorldMapData["folders"] = [];

  for (const folder of folders) {
    const xml = await readText(path.join(folder.dir, "worldmap.xml"));
    if (xml) {
      for (const [cell, cellFeatures] of parseWorldMapXml(xml)) {
        // The game uses the first folder that has features for a cell (see MapUtils.initDirectoryMapData).
        if (takenFeatureCells.has(cell)) continue;
        takenFeatureCells.add(cell);
        for (const feature of cellFeatures) {
          const geometry = feature.type === "Polygon"
            ? { type: "Polygon", coordinates: feature.rings }
            : feature.type === "Point"
              ? { type: "Point", coordinates: feature.rings[0][0] }
              : { type: "LineString", coordinates: feature.rings[0] };
          features.push({
            type: "Feature",
            properties: { kind: feature.kind, value: feature.value, ...(feature.roomTone ? { roomTone: feature.roomTone } : {}), ...(feature.name ? { name: feature.name } : {}) },
            geometry,
          });
          const [x, y] = centroid(feature.rings);
          if (feature.kind === "building" && feature.roomTone) {
            const label = humanize(feature.roomTone);
            search.push({ kind: "building", label, norm: normalize(label), x, y, z: 0 });
          } else if (feature.kind === "place" && feature.name) {
            search.push({ kind: "town", label: feature.name, norm: normalize(feature.name), x, y, z: 0 });
          }
        }
      }
    }

    const streets = await readText(path.join(folder.dir, "streets.xml"));
    for (const street of streets ? parseStreetsXml(streets) : []) {
      features.push({ type: "Feature", properties: { kind: "street", name: street.name, width: street.width }, geometry: { type: "LineString", coordinates: street.points } });
      const middle = street.points[Math.floor(street.points.length / 2)];
      search.push({ kind: "street", label: street.name, norm: normalize(street.name), x: middle[0], y: middle[1], z: 0 });
    }

    const annotations = await readText(path.join(folder.dir, "worldmap-annotations.lua"));
    for (const label of annotations ? parseAnnotations(annotations, translations) : []) {
      features.push({ type: "Feature", properties: { kind: "label", name: label.text, layer: label.layer, rotation: label.rotation, scale: label.scale }, geometry: { type: "Point", coordinates: [label.x, label.y] } });
      const text = label.text.replace(/\s+/g, " ");
      const title = text === text.toUpperCase() ? text.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase()) : text;
      search.push({ kind: label.layer === "text-town" ? "town" : "place", label: title, norm: normalize(title), x: label.x, y: label.y, z: 0 });
    }

    let files: string[] = [];
    try {
      files = await fs.promises.readdir(folder.dir);
    } catch {
      warnings.push(`Map folder "${folder.name}" could not be read.`);
    }
    let unreadable = 0;
    for (const file of files) {
      const match = /^(\d+)_(\d+)\.lotheader$/.exec(file);
      if (!match || takenLotCells.has(`${match[1]},${match[2]}`)) continue;
      takenLotCells.add(`${match[1]},${match[2]}`);
      const cellX = Number(match[1]);
      const cellY = Number(match[2]);
      let header: LotHeader;
      try {
        header = parseLotHeader(await fs.promises.readFile(path.join(folder.dir, file)), cellX, cellY);
      } catch {
        unreadable += 1;
        continue;
      }
      bounds = bounds
        ? [Math.min(bounds[0], cellX * CELL), Math.min(bounds[1], cellY * CELL), Math.max(bounds[2], (cellX + 1) * CELL), Math.max(bounds[3], (cellY + 1) * CELL)]
        : [cellX * CELL, cellY * CELL, (cellX + 1) * CELL, (cellY + 1) * CELL];
      for (const room of header.rooms) {
        if (room.rects.length === 0) continue;
        let floor = roomsByFloor.get(room.z);
        if (!floor) roomsByFloor.set(room.z, (floor = []));
        floor.push([room.name, room.rects]);
        const [x, y, w, h] = room.rects[0];
        search.push({ kind: "room", label: room.name, norm: normalize(room.name), x: x + w / 2, y: y + h / 2, z: room.z });
      }
      const chunksPerCell = CELL / CHUNK;
      for (let index = 0; index < header.density.length; index++) {
        const value = header.density[index];
        if (value === 0) continue;
        // Grid is stored column by column: index = chunkX * 32 + chunkY.
        const chunkY = cellY * chunksPerCell + (index % chunksPerCell);
        let row = densityRows.get(chunkY);
        if (!row) densityRows.set(chunkY, (row = []));
        row.push([cellX * chunksPerCell + Math.floor(index / chunksPerCell), value]);
      }
    }
    if (unreadable > 0) warnings.push(`${unreadable} cell header(s) in "${folder.name}" could not be read; their rooms are missing.`);

    built.push({ ...folder, pyramid: await openPyramid(folder.dir, warnings, folder.name) });
  }

  const towns = search.filter((entry) => entry.kind === "town");
  for (const entry of search) {
    if (entry.kind === "town" || towns.length === 0) continue;
    let nearest = towns[0];
    for (const town of towns) {
      if ((town.x - entry.x) ** 2 + (town.y - entry.y) ** 2 < (nearest.x - entry.x) ** 2 + (nearest.y - entry.y) ** 2) nearest = town;
    }
    entry.area = nearest.label;
  }

  // Neighbouring chunks in a row with the same value become one run: [x, y, length, value].
  const densityRuns: number[] = [];
  for (const [y, row] of densityRows) {
    row.sort((a, b) => a[0] - b[0]);
    for (let index = 0; index < row.length;) {
      const [x, value] = row[index];
      let length = 1;
      while (index + length < row.length && row[index + length][0] === x + length && row[index + length][1] === value) length++;
      densityRuns.push(x, y, length, value);
      index += length;
    }
  }

  const floorNumbers = [...roomsByFloor.keys()];
  const gzipJson = (value: unknown) => zlib.gzipSync(JSON.stringify(value));
  return {
    key,
    folders: built,
    bounds,
    floors: floorNumbers.length ? { min: Math.min(0, ...floorNumbers), max: Math.max(0, ...floorNumbers) } : { min: 0, max: 0 },
    warnings,
    features: gzipJson({ type: "FeatureCollection", features }),
    rooms: new Map([...roomsByFloor].map(([floor, rooms]) => [floor, gzipJson(rooms)])),
    density: gzipJson({ chunk: CHUNK, runs: densityRuns }),
    search,
  };
}

// ---------- cache and lookups ----------

const cache = new Map<string, WorldMapData>();
const inflight = new Map<string, Promise<WorldMapData>>();

/** Map data for the active server. Rebuilt only when its folders or their files change. */
export async function getWorldMapData(): Promise<WorldMapData> {
  const { folders, warnings, installPath } = await resolveFolders();
  const key = folderKey(folders);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let pending = inflight.get(key);
  if (!pending) {
    pending = buildData(key, folders, warnings, installPath).then((data) => {
      cache.set(key, data);
      while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
      return data;
    }).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

/** Cached data by key; falls back to rebuilding so links survive a panel restart. */
export async function getWorldMapDataByKey(key: string): Promise<WorldMapData | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const current = await getWorldMapData();
  return current.key === key ? current : null;
}

/** One pyramid tile for a Web Mercator tile address, or null when the image has no such tile. */
export async function readPyramidTile(pyramid: Pyramid, z: number, x: number, y: number): Promise<Buffer | null> {
  const level = PYRAMID_ZOOM - z;
  if (level < 0 || level > pyramid.maxLevel) return null;
  const span = TILE << level;
  const entry = pyramid.entries.get(`${level}/tile${x - pyramid.originX / span}x${y - pyramid.originY / span}.png`);
  return entry ? entry.buffer() : null;
}

export function searchWorldMap(data: WorldMapData, query: string, near: { x: number; y: number }): MapSearchResult[] {
  const norm = normalize(query);
  if (!norm) return [];
  const scored: Array<{ entry: SearchEntry; rank: number; distance: number }> = [];
  for (const entry of data.search) {
    const rank = entry.norm === norm ? 0 : entry.norm.startsWith(norm) ? 1 : entry.norm.includes(norm) ? 2 : -1;
    if (rank < 0) continue;
    scored.push({ entry, rank, distance: (entry.x - near.x) ** 2 + (entry.y - near.y) ** 2 });
  }
  const kindOrder = { town: 0, place: 1, street: 2, building: 3, room: 4 };
  scored.sort((a, b) => a.rank - b.rank || kindOrder[a.entry.kind] - kindOrder[b.entry.kind] || a.distance - b.distance);
  const results: MapSearchResult[] = [];
  for (const { entry: { norm: _norm, ...result } } of scored) {
    // Streets are split into many segments and towns appear as both a label and a place.
    const duplicate = results.some((other) =>
      other.kind === result.kind && normalize(other.label) === normalize(result.label) && other.z === result.z &&
      (result.kind === "town" || Math.hypot(other.x - result.x, other.y - result.y) < 300),
    );
    if (!duplicate) results.push(result);
    if (results.length === SEARCH_LIMIT) break;
  }
  return results;
}
