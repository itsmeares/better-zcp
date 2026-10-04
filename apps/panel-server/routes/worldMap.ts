import { Router } from "../http/apiRouter.ts";
import type { Request, Response } from "../http/apiRouter.ts";
import {
  getWorldMapData,
  getWorldMapDataByKey,
  PYRAMID_ZOOM,
  readPyramidTile,
  searchWorldMap,
  type WorldMapData,
} from "../services/worldMapData.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("API:WorldMap");
const router = Router();
// Every data URL carries the build key, so responses never change in place.
const IMMUTABLE = "private, max-age=31536000, immutable";

function failure(res: Response, error: unknown): Response {
  log.warn(`World map request failed: ${error instanceof Error ? error.message : String(error)}`);
  return res.status(500).json({ error: "World map data could not be read." });
}

async function dataFor(req: Request, res: Response): Promise<WorldMapData | null> {
  const data = /^[0-9a-f]{16}$/.test(req.params.key) ? await getWorldMapDataByKey(req.params.key) : null;
  if (!data) res.status(404).json({ error: "This map version is no longer available. Reload the map." });
  return data;
}

function sendGzip(res: Response, body: Buffer): void {
  res.set({ "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": IMMUTABLE });
  res.end(body);
}

function integer(value: unknown): number | null {
  return typeof value === "string" && /^-?\d{1,6}$/.test(value) ? Number(value) : null;
}

/** Summary the client needs before it loads any layer. */
export function worldMapManifest(data: WorldMapData) {
  return {
    key: data.key,
    folders: data.folders.map((folder, index) => ({
      id: index,
      name: folder.name,
      source: folder.source,
      image: folder.pyramid ? { minZoom: PYRAMID_ZOOM - folder.pyramid.maxLevel, maxZoom: PYRAMID_ZOOM } : null,
    })),
    bounds: data.bounds,
    floors: data.floors,
    warnings: data.warnings,
  };
}

router.get("/manifest", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json(worldMapManifest(await getWorldMapData()));
  } catch (error) {
    failure(res, error);
  }
});

router.get("/:key/tiles/:folder/:z/:x/:y", async (req, res) => {
  const [folderId, z, x, y] = [req.params.folder, req.params.z, req.params.x, req.params.y].map(integer);
  if (folderId === null || z === null || x === null || y === null || x < 0 || y < 0) {
    return res.status(400).json({ error: "Invalid tile address" });
  }
  try {
    const data = await dataFor(req, res);
    if (!data) return;
    const pyramid = data.folders[folderId]?.pyramid;
    const tile = pyramid ? await readPyramidTile(pyramid, z, x, y) : null;
    if (!tile) return res.status(204).end();
    res.set({ "Content-Type": "image/png", "Cache-Control": IMMUTABLE });
    res.end(tile);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/:key/features", async (req, res) => {
  try {
    const data = await dataFor(req, res);
    if (data) sendGzip(res, data.features);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/:key/rooms/:z", async (req, res) => {
  const z = integer(req.params.z);
  if (z === null) return res.status(400).json({ error: "Invalid floor" });
  try {
    const data = await dataFor(req, res);
    if (!data) return;
    const rooms = data.rooms.get(z);
    if (!rooms) {
      res.set("Cache-Control", IMMUTABLE);
      return res.json([]);
    }
    sendGzip(res, rooms);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/:key/density", async (req, res) => {
  try {
    const data = await dataFor(req, res);
    if (data) sendGzip(res, data.density);
  } catch (error) {
    failure(res, error);
  }
});

router.get("/:key/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.slice(0, 80) : "";
  const x = Number(req.query.x);
  const y = Number(req.query.y);
  try {
    const data = await dataFor(req, res);
    if (!data) return;
    res.set("Cache-Control", "no-store");
    res.json({ results: searchWorldMap(data, query, { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }) });
  } catch (error) {
    failure(res, error);
  }
});


export async function getWorldMapDiagnostics() {
  const manifest = worldMapManifest(await getWorldMapData());
  return { available: manifest.folders.length > 0, ...manifest };
}

export default router;
