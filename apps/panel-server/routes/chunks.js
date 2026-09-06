import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Chunks");
import {
  getSetting,
  setSetting,
  getActiveServer,
  updateServer,
  getServers,
} from "../database/init.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { requirePermission, getRoleByName } from "../services/permissions.js";
import { deleteVehiclesInBoxes } from "../utils/vehiclesDb.js";
import { confineToRoots } from "../utils/browseRoots.js";
import {
  normalizeUserPath,
  getCandidateZomboidPaths,
  invalidateCandidatePathsCache,
  inspectZomboidPath,
} from "../utils/zomboidPaths.js";
import { ErrorCode } from "../utils/errorCodes.js";

export { normalizeUserPath, getCandidateZomboidPaths, invalidateMapFolderScan };

const router = express.Router();

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await worker(items[i], i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function copyChunkBackup(sourcePath, destinationPath, exclusive = false) {
  try {
    await fs.promises.copyFile(
      sourcePath,
      destinationPath,
      exclusive ? fs.constants.COPYFILE_EXCL : 0,
    );
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function cellDivisorFor(isB42) {
  return isB42 ? 32 : 30;
}
function tilesPerChunkFor(isB42) {
  return isB42 ? 8 : 10;
}

function detectSaveIsB42Sync(savePath) {
  try {
    const mapPath = path.join(savePath, "map");
    if (fs.existsSync(mapPath)) {
      const entries = fs.readdirSync(mapPath, { withFileTypes: true });
      if (entries.some((e) => e.isDirectory() && /^\d+$/.test(e.name)))
        return true;
    }
  } catch {
    /* ignore */
  }
  const b42Indicators = [
    "WorldDictionary.bin",
    "global_mod_data.bin",
    "entity_data.bin",
  ];
  return b42Indicators.some((f) => {
    try {
      return fs.existsSync(path.join(savePath, f));
    } catch {
      return false;
    }
  });
}

async function cleanupEmptyCellFiles(
  savePath,
  touchedCells,
  isB42,
  backupPath = null,
) {
  if (!isB42 || touchedCells.size === 0) return { removed: [] };
  const divisor = cellDivisorFor(true);
  const mapPath = path.join(savePath, "map");
  const removed = [];

  for (const key of touchedCells) {
    const [cellX, cellY] = key.split(",").map(Number);
    if (!Number.isInteger(cellX) || !Number.isInteger(cellY)) continue;

    const minChunkX = cellX * divisor;
    const maxChunkX = minChunkX + divisor - 1;
    const minChunkY = cellY * divisor;
    const maxChunkY = minChunkY + divisor - 1;

    let hasSurvivor = false;
    for (let cx = minChunkX; cx <= maxChunkX && !hasSurvivor; cx++) {
      const xDir = path.join(mapPath, String(cx));
      let entries;
      try {
        entries = await fs.promises.readdir(xDir);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        hasSurvivor = true;
        break;
      }
      for (const name of entries) {
        const m = name.match(/^(\d+)\.bin$/);
        if (!m) continue;
        const y = parseInt(m[1], 10);
        if (y >= minChunkY && y <= maxChunkY) {
          hasSurvivor = true;
          break;
        }
      }
    }

    if (hasSurvivor) continue;

    const cellFiles = [
      ["chunkdata", `chunkdata_${cellX}_${cellY}.bin`],
      ["zpop", `zpop_${cellX}_${cellY}.bin`],
      ["metagrid", `metacell_${cellX}_${cellY}.bin`],
      ["apop", `apop_${cellX}_${cellY}.bin`],
    ];
    for (const [folder, file] of cellFiles) {
      const full = path.join(savePath, folder, file);
      try {
        if (backupPath) {
          const cellAuxDir = path.join(backupPath, "cellaux", folder);
          await fs.promises.mkdir(cellAuxDir, { recursive: true });
          await copyChunkBackup(full, path.join(cellAuxDir, file));
        }
        await fs.promises.unlink(full);
        removed.push(`${folder}/${file}`);
      } catch (e) {
        if (e.code !== "ENOENT") {
          log.debug(
            `Failed to delete cell file ${folder}/${file}: ${e.message}`,
          );
        }
      }
    }
  }
  return { removed };
}

router.use(async (req, res, next) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Map cleanup is not available for remote servers. The server filesystem is not accessible from this panel.",
        });
    }
    next();
  } catch (err) {
    next(err);
  }
});

async function getZomboidDataPath() {
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) {
    return normalizeUserPath(activeServer.zomboidDataPath);
  }

  const legacyPath = await getSetting("zomboidDataPath");
  return normalizeUserPath(legacyPath) || null;
}

function resolveSavesPath(zomboidDataPath) {
  let savesPath = path.join(zomboidDataPath, "Saves", "Multiplayer");

  if (!fs.existsSync(savesPath)) {
    const basename = path.basename(zomboidDataPath);
    const parentDir = path.dirname(zomboidDataPath);
    const parentBase = path.basename(parentDir);
    const grandparentBase = path.basename(path.dirname(parentDir));
    if (basename === "Multiplayer" && parentBase === "Saves") {
      savesPath = zomboidDataPath;
    } else if (basename === "Saves") {
      savesPath = path.join(zomboidDataPath, "Multiplayer");
    } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
      savesPath = parentDir;
    }
  }

  return savesPath;
}

function resolveCustomOrDefaultDataPath(customPath) {
  if (!customPath) return null;
  const cleaned = normalizeUserPath(customPath);
  if (!cleaned) return null;
  const normalized = path.resolve(cleaned);
  if (!fs.existsSync(normalized)) {
    const error = new Error(
      `Custom path does not exist: ${normalized}. ` +
        `Check for typos and verify the panel has read access to this folder.`,
    );
    error.statusCode = 400;
    error.details = { reason: "not-found", tried: normalized };
    throw error;
  }
  try {
    if (!fs.statSync(normalized).isDirectory()) {
      const error = new Error(`Custom path is not a directory: ${normalized}`);
      error.statusCode = 400;
      error.details = { reason: "not-a-directory", tried: normalized };
      throw error;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    const error = new Error(
      `Could not read custom path (${e.code || "error"}): ${normalized}`,
    );
    error.statusCode = 400;
    error.details = {
      reason: "stat-failed",
      tried: normalized,
      errorCode: e.code,
    };
    throw error;
  }

  const verdict = inspectZomboidPath(normalized);
  if (verdict.ok) return normalized;

  if (verdict.reason === "install-folder") {
    log.warn(
      `[ChunkCleaner] Rejected custom path (server install folder): ${normalized}`,
    );
    const error = new Error(
      "This folder looks like a Project Zomboid server install (it contains " +
        "ProjectZomboid64.exe / .json or similar). " +
        "Point at the user data folder instead — usually " +
        (process.platform === "win32"
          ? "C:\\Users\\<you>\\Zomboid"
          : "~/Zomboid") +
        " — not the server folder.",
    );
    error.statusCode = 400;
    error.details = {
      reason: "install-folder",
      tried: normalized,
      checks: verdict.checks,
    };
    throw error;
  }

  log.warn(
    `[ChunkCleaner] Rejected custom path (no Zomboid markers found): ${normalized}`,
  );
  let msg =
    "Path does not appear to be a Zomboid data directory. " +
    "Point at your Zomboid data folder (the one containing Saves/), " +
    "a Saves/Multiplayer folder, or an individual save directory.";
  if (verdict.parentSuggestion) {
    msg += ` Did you mean ${verdict.parentSuggestion}?`;
  }
  const error = new Error(msg);
  error.statusCode = 403;
  error.details = {
    reason: "no-zomboid-markers",
    tried: normalized,
    checks: verdict.checks,
    parentSuggestion: verdict.parentSuggestion || null,
  };
  throw error;
}

function assertRealSaveDataPath(zomboidDataPath) {
  const verdict = inspectZomboidPath(zomboidDataPath);
  const hasStructuralEvidence =
    verdict.checks.hasSavesDir ||
    verdict.checks.hasMultiplayerDir ||
    verdict.checks.hasSaveArtifacts;
  if (!hasStructuralEvidence) {
    const error = new Error(
      "This custom path doesn't contain an actual Saves/Multiplayer folder or " +
        "recognizable save data -- refusing to delete from it for safety. " +
        "Point at a real Zomboid data folder, not just a path with a suggestive name.",
    );
    error.statusCode = 400;
    error.details = { reason: "no-structural-save-evidence", checks: verdict.checks };
    throw error;
  }
}

async function assertKnownSaveRoot(zomboidDataPath) {
  const resolved = path.resolve(zomboidDataPath);
  const configuredServers = await getServers();
  const matchesConfiguredServer = configuredServers.some(
    (s) => s.zomboidDataPath && path.resolve(s.zomboidDataPath) === resolved,
  );
  if (matchesConfiguredServer) return;

  const candidates = getCandidateZomboidPaths();
  const matchesCandidate = candidates.some((c) => path.resolve(c.path) === resolved);
  if (matchesCandidate) return;

  const legacyPath = await getSetting("zomboidDataPath");
  if (legacyPath && path.resolve(normalizeUserPath(legacyPath)) === resolved) return;

  const error = new Error(
    "This custom path isn't a location the panel already recognizes -- not a configured " +
      "server's data folder, and not one of the standard OS locations Zomboid saves usually " +
      "live in. Refusing to delete from it for safety.",
  );
  error.statusCode = 400;
  error.details = { reason: "not-a-known-save-root", tried: resolved };
  throw error;
}

router.get("/saves", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    let zomboidDataPath;
    let autoPickedFrom = null;
    if (customPath) {
      const normalized = resolveCustomOrDefaultDataPath(customPath);
      zomboidDataPath = normalized;
      log.info(`[ChunkCleaner] Using custom path: ${normalized}`);
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      const candidates = getCandidateZomboidPaths();
      const withSaves = candidates.filter((c) => c.hasSaves);
      if (withSaves.length === 1) {
        zomboidDataPath = withSaves[0].path;
        autoPickedFrom = zomboidDataPath;
        log.info(
          `[ChunkCleaner] Auto-picked Zomboid data path: ${zomboidDataPath}`,
        );
      } else {
        return res.status(400).json({
          error:
            "Zomboid data path not set. " +
            "Configure a server in Settings → Servers, or use the Custom path field below to point at your Zomboid folder.",
          debug: {
            zomboidDataPath: null,
            savesPath: null,
            exists: false,
            usedCustomPath: false,
            hint:
              withSaves.length > 1
                ? `Found ${withSaves.length} candidate folders with saves — pick one below.`
                : "No Zomboid data folder is configured for this panel.",
            suggestedPaths: candidates,
          },
        });
      }
    }

    let savesPath = resolveSavesPath(zomboidDataPath);
    const attempted = [savesPath];

    if (!fs.existsSync(savesPath)) {
      const basename = path.basename(zomboidDataPath);
      const parentDir = path.dirname(zomboidDataPath);
      const parentBase = path.basename(parentDir);
      const grandparentBase = path.basename(path.dirname(parentDir));
      if (basename === "Multiplayer" && parentBase === "Saves") {
        savesPath = zomboidDataPath;
        log.info(`[ChunkCleaner] Path points directly to Saves/Multiplayer`);
      } else if (basename === "Saves") {
        savesPath = path.join(zomboidDataPath, "Multiplayer");
        attempted.push(savesPath);
        log.info(`[ChunkCleaner] Path points directly to Saves dir`);
      } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
        savesPath = parentDir;
        attempted.push(savesPath);
        log.info(
          `[ChunkCleaner] Path points to an individual save; using parent Saves/Multiplayer`,
        );
      } else {
        log.warn(`[ChunkCleaner] Saves path not found: ${savesPath}`);
        log.info(`[ChunkCleaner] zomboidDataPath: ${zomboidDataPath}`);
        return res.json({
          saves: [],
          debug: {
            zomboidDataPath,
            savesPath,
            exists: false,
            usedCustomPath: Boolean(customPath),
            attempted,
            hint:
              `Looked for ${path.join("Saves", "Multiplayer")} inside the data folder but didn't find it. ` +
              `Has this server ever been started, or is the data path pointing at the wrong place?`,
            suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
          },
        });
      }
    }

    if (!fs.existsSync(savesPath)) {
      log.warn(
        `[ChunkCleaner] Resolved saves path does not exist: ${savesPath}`,
      );
      return res.json({
        saves: [],
        debug: {
          zomboidDataPath,
          savesPath,
          exists: false,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint: `The resolved saves folder doesn't exist on disk. Start the server once to create it, or pick a different data path.`,
          suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
        },
      });
    }

    log.info(`[ChunkCleaner] Listing saves from: ${savesPath}`);

    let entries;
    try {
      entries = await fs.promises.readdir(savesPath, { withFileTypes: true });
    } catch (e) {
      log.warn(
        `[ChunkCleaner] Failed to read saves dir ${savesPath}: ${e.message}`,
      );
      const code = e.code || "EREAD";
      const permissionDenied = code === "EACCES" || code === "EPERM";
      const variant = process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "generic";
      const hint = !permissionDenied
        ? `Could not read the saves folder (${code}).`
        : variant === "linux"
          ? "Panel cannot read this folder. Check ownership and read permissions for the panel service user."
          : variant === "windows"
            ? "Panel cannot read this folder. Check that the panel service account has read access to it."
            : "Panel cannot read this folder. Check the folder permissions for the account running the panel.";
      return res.status(403).json({
        error: hint,
        variant,
        debug: {
          zomboidDataPath,
          savesPath,
          exists: true,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint,
          errorCode: code,
        },
      });
    }
    const directories = entries.filter(
      (d) => d.isDirectory() && d.name.toLowerCase() !== "backups",
    );

    log.info(
      `[ChunkCleaner] Found ${directories.length} save directories: ${directories.map((d) => d.name).join(", ")}`,
    );

    const saves = await Promise.all(
      directories.map(async (d) => {
        const savePath = path.join(savesPath, d.name);
        const stats = await fs.promises.stat(savePath);

        const mapPath = path.join(savePath, "map");
        const mapScan = await getMapFolderScan(mapPath);

        let chunkCount = mapScan.isB42Structure
          ? mapScan.totalBinFiles + mapScan.totalNonBinFiles
          : 0;
        if (chunkCount === 0) {
          const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
          try {
            const rootEntries = await fs.promises.readdir(savePath);
            chunkCount = rootEntries.filter((f) =>
              B41_CHUNK_REGEX.test(f),
            ).length;
          } catch (e) {
            log.debug(
              `B41 chunk count fallback failed for ${savePath}: ${e.message}`,
            );
          }
        }

        let size = 0;
        try {
          const topEntries = await fs.promises.readdir(savePath, {
            withFileTypes: true,
          });
          const topSizes = await Promise.all(
            topEntries.map(async (entry) => {
              if (entry.name === "map" && mapScan.isB42Structure) {
                const chunkSize = mapScan.rawChunks.reduce(
                  (sum, c) => sum + c.size,
                  0,
                );
                return chunkSize + mapScan.totalNonBinSize;
              }
              const fullPath = path.join(savePath, entry.name);
              if (entry.isDirectory()) return getDirSize(fullPath);
              try {
                return (await fs.promises.stat(fullPath)).size;
              } catch (e) {
                return 0;
              }
            }),
          );
          size = topSizes.reduce((a, b) => a + b, 0);
        } catch (e) {
          log.debug(`Save size scan failed for ${savePath}: ${e.message}`);
        }

        return {
          name: d.name,
          modified: stats.mtime,
          chunkCount,
          size,
          sizeFormatted: formatBytes(size),
        };
      }),
    );

    res.json({
      saves,
      debug: {
        zomboidDataPath,
        savesPath,
        exists: true,
        usedCustomPath: Boolean(customPath),
        autoPicked: autoPickedFrom,
        hint:
          saves.length === 0
            ? `Saves folder exists but contains no save directories. Start the server once, or pick a different folder.`
            : null,
        suggestedPaths:
          saves.length === 0 && !customPath ? getCandidateZomboidPaths() : [],
      },
    });
  } catch (error) {
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError) {
      log.warn(`Get saves rejected (${error.statusCode}): ${error.message}`);
    } else {
      log.error(`Failed to get saves: ${error.message}`);
    }
    const payload = { error: sanitizeError(error.message) };
    if (error.details) {
      payload.debug = {
        zomboidDataPath: null,
        savesPath: null,
        exists: false,
        usedCustomPath: true,
        hint: error.message,
        rejection: error.details,
        suggestedPaths: getCandidateZomboidPaths(),
      };
    }
    res.status(error.statusCode || 500).json(payload);
  }
});

router.get("/suggested-paths", requirePermission("chunks.manage"), async (req, res) => {
  try {
    if (req?.query?.refresh) invalidateCandidatePathsCache();
    res.json({
      candidates: getCandidateZomboidPaths(),
      platform: process.platform,
    });
  } catch (error) {
    log.error(`Failed to enumerate suggested paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/save-path", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { path: rawPath } = req.body || {};
    if (!rawPath || typeof rawPath !== "string") {
      return res.status(400).json({
        error: "Missing path.",
        code: ErrorCode.CHUNKS_SAVE_PATH_MISSING,
      });
    }
    let validated;
    try {
      validated = resolveCustomOrDefaultDataPath(rawPath);
    } catch (e) {
      const payload = { error: sanitizeError(e.message) };
      if (e.details) payload.rejection = e.details;
      return res.status(e.statusCode || 400).json(payload);
    }
    if (!validated) {
      return res.status(400).json({
        error: "Path is empty after normalization.",
        code: ErrorCode.CHUNKS_SAVE_PATH_EMPTY,
      });
    }

    const activeServer = await getActiveServer();

    const currentPath = activeServer?.zomboidDataPath || (await getSetting("zomboidDataPath")) || null;
    if (currentPath !== validated) {
      const role = req.user ? await getRoleByName(req.user.role) : null;
      const capabilities = Array.isArray(role?.capabilities) ? role.capabilities : [];
      if (!capabilities.includes("server.configure")) {
        return res.status(403).json({
          error: "Repointing the server's data path also requires server.configure.",
          code: ErrorCode.CHUNKS_SAVE_PATH_CAPABILITY_REQUIRED,
        });
      }
    }

    if (activeServer?.id) {
      const updated = await updateServer(activeServer.id, { zomboidDataPath: validated });
      if (!updated) {
        return res.status(404).json({ error: "Active server no longer exists." });
      }
      log.info(
        `[ChunkCleaner] Saved zomboidDataPath to active server "${activeServer.name}": ${validated}`,
      );
      return res.json({
        ok: true,
        target: "server",
        serverId: activeServer.id,
        path: validated,
      });
    }
    await setSetting("zomboidDataPath", validated);
    log.info(
      `[ChunkCleaner] Saved zomboidDataPath to legacy settings: ${validated}`,
    );
    res.json({ ok: true, target: "setting", path: validated });
  } catch (error) {
    log.error(`Failed to save zomboid data path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/chunks/:saveName", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    const scanId = req.query.scanId ? String(req.query.scanId) : null;
    const io = req.app.get("io");
    let lastProgressAt = 0;
    const emitProgress = (scanned, total, found, { force = false } = {}) => {
      if (!io || !scanId) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      io.emit("chunkScan:progress", { scanId, scanned, total, chunks: found });
    };

    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    let zomboidDataPath;
    if (customPath) {
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
      assertRealSaveDataPath(zomboidDataPath);
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    log.info(
      `[ChunkCleaner] Loading chunks for "${sanitizedSaveName}" from: ${mapPath}`,
    );

    if (!fs.existsSync(savePath)) {
      log.warn(`[ChunkCleaner] Save directory not found: ${savePath}`);
      return res.json({ chunks: [], bounds: null });
    }

    const chunks = [];
    const seenChunkCoords = new Set();
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let totalChunks = 0;

    const mapScan = await getMapFolderScan(mapPath, emitProgress);
    const mapExists = mapScan.mapExists;
    const mapContents = mapScan.mapContents || [];
    const flatBinFiles = mapContents.filter(
      (f) => f.isFile() && f.name.endsWith(".bin"),
    );

    log.info(
      `[ChunkCleaner] map/ ${mapExists ? "exists" : "missing"}: ${mapContents.length} entries, ${mapScan.isB42Structure ? "B42 structure" : "no B42 dirs"}, ${flatBinFiles.length} flat .bin files (B41)`,
    );

    const rememberChunkCoord = (x, y) => {
      const key = `${x},${y}`;
      if (seenChunkCoords.has(key)) return false;
      seenChunkCoords.add(key);
      totalChunks++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return true;
    };

    if (mapScan.isB42Structure) {
      for (const c of mapScan.rawChunks) {
        if (!rememberChunkCoord(c.x, c.y)) continue;
        chunks.push(c);
      }
    } else {
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      const chunkEntries = [];
      for (const file of files) {
        const match = file.match(
          /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ file, x, y });
        }
      }

      const legacyResults = await Promise.all(
        chunkEntries.map(async ({ file, x, y }) => {
          try {
            const stats = await fs.promises.stat(path.join(mapPath, file));
            return {
              file,
              x,
              y,
              size: stats.size,
              modified: stats.mtime,
            };
          } catch (e) {
            log.debug(`Stat failed for legacy chunk ${file}: ${e.message}`);
            return null;
          }
        }),
      );

      for (const res of legacyResults) {
        if (res) {
          chunks.push(res);
        }
      }
    }

    let isB42 = mapScan.isB42Structure;

    if (!isB42 && chunks.length === 0) {
      const b42Indicators = [
        "WorldDictionary.bin",
        "global_mod_data.bin",
        "entity_data.bin",
      ];
      const hasB42Files = b42Indicators.some((f) =>
        fs.existsSync(path.join(savePath, f)),
      );
      if (hasB42Files) {
        isB42 = true;
        log.info(
          `[ChunkCleaner] Detected B42 save via indicator files (map/ is empty)`,
        );
      }
    }

    if (!isB42 && totalChunks === 0) {
      const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
      const rootEntries = await fs.promises.readdir(savePath, {
        withFileTypes: true,
      });
      const rootBinFiles = rootEntries.filter(
        (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
      );

      if (rootBinFiles.length > 0) {
        log.info(
          `[ChunkCleaner] Found ${rootBinFiles.length} B41 chunk files in save root`,
        );

        const chunkEntries = [];
        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (!match) continue;

          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ entry, x, y });
        }

        const rootResults = await Promise.all(
          chunkEntries.map(async ({ entry, x, y }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(savePath, entry.name),
              );
              return {
                file: entry.name,
                x,
                y,
                size: stats.size,
                modified: stats.mtime,
                source: "saveroot",
              };
            } catch (e) {
              log.debug(
                `Stat failed for B41 root chunk ${entry.name}: ${e.message}`,
              );
              return null;
            }
          }),
        );

        for (const res of rootResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    const seenChunkDataCoords = new Set();
    {
      const chunkDataPath = path.join(savePath, "chunkdata");
      if (fs.existsSync(chunkDataPath)) {
        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter((f) => f.endsWith(".bin"));

        const chunkEntries = [];
        for (const file of validFiles) {
          const match = file.match(/^(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (match) {
            const rawX = parseInt(match[1], 10);
            const rawY = parseInt(match[2], 10);

            const displayX = isB42 ? rawX * 32 : rawX * 30;
            const displayY = isB42 ? rawY * 32 : rawY * 30;

            const cdKey = `${displayX},${displayY}`;
            if (seenChunkDataCoords.has(cdKey)) continue;
            seenChunkDataCoords.add(cdKey);
            minX = Math.min(minX, displayX);
            maxX = Math.max(maxX, displayX);
            minY = Math.min(minY, displayY);
            maxY = Math.max(maxY, displayY);
            totalChunks++;

            chunkEntries.push({ file, rawX, rawY, displayX, displayY });
          }
        }

        const chunkDataResults = await Promise.all(
          chunkEntries.map(async ({ file, rawX, rawY, displayX, displayY }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(chunkDataPath, file),
              );
              return {
                file,
                x: displayX,
                y: displayY,
                size: stats.size,
                modified: stats.mtime,
                source: "chunkdata",
                cellX: rawX,
                cellY: rawY,
              };
            } catch (e) {
              log.debug(`Stat failed for chunkdata ${file}: ${e.message}`);
              return null;
            }
          }),
        );

        for (const res of chunkDataResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    const bounds = chunks.length > 0 ? { minX, maxX, minY, maxY } : null;

    chunks.sort((a, b) => a.x - b.x || a.y - b.y);

    res.json({
      saveName,
      chunks,
      shownChunks: chunks.length,
      totalChunks,
      bounds,
      limitReached: false,
      maxChunks: null,
      isB42,
    });
  } catch (error) {
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get chunks rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get chunks: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

router.post("/delete-chunks", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const {
      saveName,
      chunks,
      createBackup = true,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;
    log.info(
      `POST /delete-chunks: saveName=${saveName}, chunkCount=${chunks?.length || 0}, createBackup=${createBackup}, deleteVehicles=${!!deleteVehicles}, force=${!!force}`,
    );

    if (!force) {
      const serverManager = req.app.get("serverManager");
      let details = null;
      if (serverManager) {
        try {
          details =
            typeof serverManager.getServerProcessDetails === "function"
              ? await serverManager.getServerProcessDetails()
              : null;
        } catch (e) {
          log.warn(
            `Server-running check failed, refusing to proceed: ${e.message}`,
          );
          details = null;
        }
      }
      if (!details || details.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (details.running) {
        return res.status(400).json({
          error:
            "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
          code: "server_running",
          matched: details.matched,
        });
      }
    } else {
      log.warn("delete-chunks: server-running check bypassed via force=true");
    }

    if (!saveName || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({
        error: "Save name and chunks array required",
        code: ErrorCode.DELETE_CHUNKS_FIELDS_REQUIRED,
      });
    }

    if (chunks.length > 100000) {
      return res.status(400).json({
        error: `Too many chunks (${chunks.length.toLocaleString()}). Maximum is 100,000 per request — split into smaller batches.`,
        code: ErrorCode.DELETE_CHUNKS_TOO_MANY,
        params: sanitizeErrorParams({ count: chunks.length }),
      });
    }

    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    for (const chunk of chunks) {
      if (!chunk.file) {
        return res.status(400).json({
          error: "Invalid chunk file name",
          code: ErrorCode.DELETE_CHUNKS_INVALID_FILE_NAME,
        });
      }
      const normalized = path.normalize(chunk.file);
      if (normalized.includes("..") || path.isAbsolute(normalized)) {
        return res.status(400).json({
          error: "Invalid chunk file path",
          code: ErrorCode.DELETE_CHUNKS_INVALID_FILE_PATH,
        });
      }
      if (chunk.x !== undefined && chunk.x !== null) {
        const nx = Number(chunk.x);
        if (!Number.isFinite(nx) || !Number.isInteger(nx)) {
          return res.status(400).json({
            error: "Invalid chunk x coordinate — must be an integer",
            code: ErrorCode.DELETE_CHUNKS_INVALID_X,
          });
        }
        chunk.x = nx;
      }
      if (chunk.y !== undefined && chunk.y !== null) {
        const ny = Number(chunk.y);
        if (!Number.isFinite(ny) || !Number.isInteger(ny)) {
          return res.status(400).json({
            error: "Invalid chunk y coordinate — must be an integer",
            code: ErrorCode.DELETE_CHUNKS_INVALID_Y,
          });
        }
        chunk.y = ny;
      }
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }
    if (customPath) await assertKnownSaveRoot(zomboidDataPath);

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    const isB42 = detectSaveIsB42Sync(savePath);
    const cellDivisor = cellDivisorFor(isB42);
    const tilesPerChunk = tilesPerChunkFor(isB42);

    for (const chunk of chunks) {
      if (chunk.source === "chunkdata" && chunk.cellX == null) {
        const cdMatch = chunk.file.match(/(\d+)_(\d+)/);
        if (cdMatch) {
          chunk.cellX = parseInt(cdMatch[1], 10);
          chunk.cellY = parseInt(cdMatch[2], 10);
        }
      }
      if (chunk.cellX == null) chunk.cellX = Math.floor(chunk.x / cellDivisor);
      if (chunk.cellY == null) chunk.cellY = Math.floor(chunk.y / cellDivisor);
    }

    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_chunks_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            const srcTag =
              chunk.source === "saveroot"
                ? "saveroot"
                : chunk.source === "chunkdata"
                  ? "chunkdata"
                  : "map";
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              const backupName = `${srcTag}_${chunk.file.replace(/[/\\]/g, "_")}`;
              await copyChunkBackup(
                mapFile,
                path.join(backupPath, backupName),
                true,
              );
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            if (chunk.source === "chunkdata") {
              const chunkDataFile = path.join(
                savePath,
                "chunkdata",
                chunk.file,
              );
              try {
                const backupName = `chunkdata_${chunk.file.replace(/[/\\]/g, "_")}`;
                await copyChunkBackup(
                  chunkDataFile,
                  path.join(backupPath, backupName),
                  true,
                );
              } catch (e) {
                if (e.code !== "ENOENT") throw e;
              }
            }
          } catch (e) {
            log.error(`Failed to backup chunk ${chunk.file}: ${e.message}`);
            throw e;
          }
        }),
      );

      log.info(`Created chunk backup at ${backupPath}`);
    }

    let deleted = 0;
    const errors = [];
    const touchedCells = new Set();

    const deleteResults = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          let wasDeleted = false;

          if (chunk.source === "chunkdata") {
            const chunkDataFile = path.join(savePath, "chunkdata", chunk.file);
            try {
              await fs.promises.unlink(chunkDataFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: `chunkdata: ${e.message}`,
                  file: chunk.file,
                };
            }
          } else {
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              await fs.promises.unlink(mapFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: sanitizeError(e.message),
                  file: chunk.file,
                };
            }
          }

          if (wasDeleted) {
            touchedCells.add(`${chunk.cellX},${chunk.cellY}`);
          }
          return { success: true, wasDeleted };
        } catch (err) {
          return {
            success: false,
            error: sanitizeError(err.message),
            file: chunk.file,
          };
        }
      }),
    );

    for (const r of deleteResults) {
      if (r.success) {
        if (r.wasDeleted) deleted++;
      } else errors.push(`${r.file}: ${r.error}`);
    }

    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      isB42,
      backupPath,
    );

    const deletedXDirs = new Set();
    for (const chunk of chunks) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xPath = path.join(savePath, "map", xDir);
        const remaining = await fs.promises.readdir(xPath);
        if (remaining.length === 0) await fs.promises.rmdir(xPath);
      } catch (e) {
        /* ignore */
      }
    }

    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const dbBackup = backupPath
        ? path.join(backupPath, "vehicles.db.bak")
        : null;
      const cellTileSpan = cellDivisor * tilesPerChunk;
      const boxes = chunks
        .filter((c) => c.cellX != null && c.cellY != null)
        .map((c) => {
          if (c.source === "chunkdata") {
            const x0 = c.cellX * cellTileSpan;
            const y0 = c.cellY * cellTileSpan;
            const wx0 = c.cellX * cellDivisor;
            const wy0 = c.cellY * cellDivisor;
            return {
              x0,
              x1: x0 + cellTileSpan,
              y0,
              y1: y0 + cellTileSpan,
              wx0,
              wx1: wx0 + cellDivisor,
              wy0,
              wy1: wy0 + cellDivisor,
            };
          }
          const x0 = c.x * tilesPerChunk;
          const y0 = c.y * tilesPerChunk;
          return {
            x0,
            x1: x0 + tilesPerChunk,
            y0,
            y1: y0 + tilesPerChunk,
            wx0: c.x,
            wx1: c.x + 1,
            wy0: c.y,
            wy1: c.y + 1,
          };
        });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(`vehicles.db: removed ${vehiclesResult.deleted} rows`);
      } catch (e) {
        log.warn(`vehicles.db cleanup failed: ${e.message}`);
        errors.push(`vehicles.db: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks from save ${sanitizedSaveName} (cell aux files removed: ${cellCleanup.removed.length}, vehicles removed: ${vehiclesResult.deleted})`,
    );

    invalidateMapFolderScan(path.join(savePath, "map"));

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      errors: errors.length > 0 ? errors : undefined,
      backupCreated: createBackup,
    });
  } catch (error) {
    log.error(`Failed to delete chunks: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

router.post("/delete-region", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const {
      saveName,
      minX,
      maxX,
      minY,
      maxY,
      createBackup = true,
      invert = false,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;

    if (!force) {
      const serverManager = req.app.get("serverManager");
      let details = null;
      if (serverManager) {
        try {
          details =
            typeof serverManager.getServerProcessDetails === "function"
              ? await serverManager.getServerProcessDetails()
              : null;
        } catch (e) {
          log.warn(
            `Server-running check failed, refusing to proceed: ${e.message}`,
          );
          details = null;
        }
      }
      if (!details || details.scanFailed) {
        return res.status(503).json({
          error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }
      if (details.running) {
        return res.status(400).json({
          error:
            "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
          code: "server_running",
          matched: details.matched,
        });
      }
    } else {
      log.warn("delete-region: server-running check bypassed via force=true");
    }

    if (
      !saveName ||
      minX === undefined ||
      maxX === undefined ||
      minY === undefined ||
      maxY === undefined
    ) {
      return res.status(400).json({
        error: "Save name and region bounds required",
        code: ErrorCode.DELETE_REGION_FIELDS_REQUIRED,
      });
    }

    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    if (
      typeof minX !== "number" ||
      typeof maxX !== "number" ||
      typeof minY !== "number" ||
      typeof maxY !== "number" ||
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxY)
    ) {
      return res.status(400).json({
        error: "Region bounds must be finite numbers",
        code: ErrorCode.DELETE_REGION_BOUNDS_NOT_FINITE,
      });
    }
    if (minX > maxX || minY > maxY) {
      return res.status(400).json({
        error: "Region bounds inverted (minX > maxX or minY > maxY)",
        code: ErrorCode.DELETE_REGION_BOUNDS_INVERTED,
      });
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }
    if (customPath) await assertKnownSaveRoot(zomboidDataPath);

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    const mapExists = fs.existsSync(mapPath);

    const regionIsB42 = detectSaveIsB42Sync(savePath);

    const chunksToDelete = [];
    let mapContents = [];
    let xDirs = [];

    if (mapExists) {
      mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
      xDirs = mapContents.filter(
        (d) => d.isDirectory() && /^\d+$/.test(d.name),
      );
    }

    if (xDirs.length > 0) {
      await Promise.all(
        xDirs.map(async (xDir) => {
          const x = parseInt(xDir.name, 10);
          if (!invert && (x < minX || x > maxX)) return;

          const xPath = path.join(mapPath, xDir.name);

          try {
            const yFiles = await fs.promises.readdir(xPath);
            const binFiles = yFiles.filter((f) => f.endsWith(".bin"));

            for (const yFile of binFiles) {
              const yMatch = yFile.match(/^(\d+)\.bin$/);
              if (yMatch) {
                const y = parseInt(yMatch[1], 10);

                const inRegion =
                  x >= minX && x <= maxX && y >= minY && y <= maxY;
                const shouldDelete = invert ? !inRegion : inRegion;

                if (shouldDelete) {
                  chunksToDelete.push({ file: `${x}/${yFile}`, x, y });
                }
              }
            }
          } catch (err) {
            log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
          }
        }),
      );
    } else {
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      for (const file of files) {
        const match = file.match(
          /^(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);

          const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;

          if (shouldDelete) {
            chunksToDelete.push({ file, x, y });
          }
        }
      }

      if (chunksToDelete.length === 0) {
        const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootBinFiles = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );

        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (match) {
            const x = parseInt(match[1], 10);
            const y = parseInt(match[2], 10);

            const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
            const shouldDelete = invert ? !inRegion : inRegion;

            if (shouldDelete) {
              chunksToDelete.push({
                file: entry.name,
                x,
                y,
                source: "saveroot",
              });
            }
          }
        }
      }
    }

    {
      const chunkDataPath = path.join(savePath, "chunkdata");
      if (fs.existsSync(chunkDataPath)) {
        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter((f) => f.endsWith(".bin"));

        for (const file of validFiles) {
          const match = file.match(/^(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (!match) continue;

          const rawX = parseInt(match[1], 10);
          const rawY = parseInt(match[2], 10);
          const displayX = regionIsB42 ? rawX * 32 : rawX * 30;
          const displayY = regionIsB42 ? rawY * 32 : rawY * 30;

          const inRegion =
            displayX >= minX &&
            displayX <= maxX &&
            displayY >= minY &&
            displayY <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;

          if (shouldDelete) {
            chunksToDelete.push({
              file,
              x: displayX,
              y: displayY,
              source: "chunkdata",
              cellX: rawX,
              cellY: rawY,
            });
          }
        }
      }
    }

    if (chunksToDelete.length === 0) {
      return res.json({
        success: true,
        deleted: 0,
        message: "No chunks in selected region",
      });
    }

    if (chunksToDelete.length > 100000) {
      return res.status(400).json({
        error: `Region too large (${chunksToDelete.length.toLocaleString()} chunks). Maximum is 100,000 at a time.`,
        code: ErrorCode.DELETE_REGION_TOO_LARGE,
        params: sanitizeErrorParams({ count: chunksToDelete.length }),
      });
    }

    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_region_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      await Promise.all(
        chunksToDelete.map(async (chunk) => {
          const srcTag =
            chunk.source === "saveroot"
              ? "saveroot"
              : chunk.source === "chunkdata"
                ? "chunkdata"
                : "map";
          const srcFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : chunk.source === "chunkdata"
                ? path.join(savePath, "chunkdata", chunk.file)
                : path.join(mapPath, chunk.file);
          try {
            const backupName = `${srcTag}_${chunk.file.replace(/[/\\]/g, "_")}`;
            await copyChunkBackup(
              srcFile,
              path.join(backupPath, backupName),
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }),
      );

      await fs.promises.writeFile(
        path.join(backupPath, "region_info.json"),
        JSON.stringify(
          {
            minX,
            maxX,
            minY,
            maxY,
            invert,
            chunksDeleted: chunksToDelete.length,
          },
          null,
          2,
        ),
      );

      log.info(`Created region backup at ${backupPath}`);
    }

    let deleted = 0;
    const errors = [];
    const touchedCells = new Set();
    const regionCellDiv = cellDivisorFor(regionIsB42);

    await Promise.all(
      chunksToDelete.map(async (chunk) => {
        try {
          const chunkFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : chunk.source === "chunkdata"
                ? path.join(savePath, "chunkdata", chunk.file)
                : path.join(mapPath, chunk.file);
          await fs.promises.unlink(chunkFile);
          deleted++;
          touchedCells.add(
            `${Math.floor(chunk.x / regionCellDiv)},${Math.floor(chunk.y / regionCellDiv)}`,
          );
        } catch (err) {
          if (err.code !== "ENOENT") {
            log.warn(`Failed to delete chunk ${chunk.file}: ${err.message}`);
            errors.push(`${chunk.file}: ${sanitizeError(err.message)}`);
          }
        }
      }),
    );

    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      regionIsB42,
      backupPath,
    );

    const deletedXDirs = new Set();
    for (const chunk of chunksToDelete) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xDirPath = path.join(mapPath, xDir);
        const remaining = await fs.promises.readdir(xDirPath);
        if (remaining.length === 0) await fs.promises.rmdir(xDirPath);
      } catch (e) {
        if (e.code !== "ENOENT")
          log.debug(`Failed to clean up empty dir ${xDir}: ${e.message}`);
      }
    }

    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const tilesPerChunk = tilesPerChunkFor(regionIsB42);
      const dbBackup =
        createBackup && typeof backupPath === "string"
          ? path.join(backupPath, "vehicles.db.bak")
          : null;
      const cellTileSpan = regionCellDiv * tilesPerChunk;
      const boxes = chunksToDelete.map((c) => {
        if (c.source === "chunkdata") {
          const x0 = c.cellX * cellTileSpan;
          const y0 = c.cellY * cellTileSpan;
          const wx0 = c.cellX * regionCellDiv;
          const wy0 = c.cellY * regionCellDiv;
          return {
            x0,
            x1: x0 + cellTileSpan,
            y0,
            y1: y0 + cellTileSpan,
            wx0,
            wx1: wx0 + regionCellDiv,
            wy0,
            wy1: wy0 + regionCellDiv,
          };
        }
        const x0 = c.x * tilesPerChunk;
        const y0 = c.y * tilesPerChunk;
        return {
          x0,
          x1: x0 + tilesPerChunk,
          y0,
          y1: y0 + tilesPerChunk,
          wx0: c.x,
          wx1: c.x + 1,
          wy0: c.y,
          wy1: c.y + 1,
        };
      });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(
          `vehicles.db: removed ${vehiclesResult.deleted} rows from region`,
        );
      } catch (e) {
        log.warn(`vehicles.db region cleanup failed: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks in region [${minX},${minY}]-[${maxX},${maxY}] from ${sanitizedSaveName} (cell files removed: ${cellCleanup.removed.length}, vehicles: ${vehiclesResult.deleted})`,
    );

    invalidateMapFolderScan(mapPath);

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      errors: errors.length > 0 ? errors : undefined,
      region: { minX, maxX, minY, maxY },
      inverted: invert,
    });
  } catch (error) {
    log.error(`Failed to delete region: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

router.get("/stats/:saveName", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    const sanitizedSaveName = path.basename(saveName);
    if (
      !sanitizedSaveName ||
      sanitizedSaveName !== saveName ||
      sanitizedSaveName === "." ||
      sanitizedSaveName === ".."
    ) {
      return res.status(400).json({
        error: "Invalid save name",
        code: ErrorCode.CHUNKS_INVALID_SAVE_NAME,
      });
    }

    let zomboidDataPath;
    if (customPath) {
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "Zomboid data path not set",
        code: ErrorCode.CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({
        error: "Save not found",
        code: ErrorCode.CHUNKS_SAVE_NOT_FOUND,
      });
    }

    const folders = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "metagrid",
      "apop",
      "radio",
    ];

    const folderStatsByName = {};
    for (const folder of folders) {
      const folderPath = path.join(savePath, folder);
      try {
        if (folder === "map") {
          const mapScan = await getMapFolderScan(folderPath);
          if (mapScan.isB42Structure) {
            const chunkSize = mapScan.rawChunks.reduce(
              (sum, c) => sum + c.size,
              0,
            );
            folderStatsByName.map = {
              count: mapScan.totalBinFiles + mapScan.totalNonBinFiles,
              size: chunkSize + mapScan.totalNonBinSize,
            };
          } else if (mapScan.mapExists) {
            const { count, size } = await getDirStats(folderPath);
            folderStatsByName.map = { count, size };
          }
          continue;
        }
        if (fs.existsSync(folderPath)) {
          const { count, size } = await getDirStats(folderPath);
          folderStatsByName[folder] = { count, size };
        }
      } catch (e) {
        log.debug(`Failed to stat folder ${folder}: ${e.message}`);
      }
    }

    let totalSize = 0;
    try {
      const topEntries = await fs.promises.readdir(savePath, { withFileTypes: true });
      const topSizes = await runWithConcurrency(topEntries, DIR_WALK_CONCURRENCY, async (entry) => {
        if (entry.isDirectory()) {
          if (Object.prototype.hasOwnProperty.call(folderStatsByName, entry.name)) {
            return folderStatsByName[entry.name].size;
          }
          return getDirSize(path.join(savePath, entry.name));
        }
        try {
          const s = await fs.promises.stat(path.join(savePath, entry.name));
          return s.size;
        } catch (e) {
          return 0;
        }
      });
      totalSize = topSizes.reduce((a, b) => a + b, 0);
    } catch (err) {
      if (err.code !== "EACCES" && err.code !== "ENOENT")
        log.debug(`Top-level size scan failed for ${savePath}: ${err.message}`);
    }

    const stats = {
      saveName,
      totalSize,
      folders: {},
    };

    for (const folder of folders) {
      if (folderStatsByName[folder]) {
        const { count, size } = folderStatsByName[folder];
        stats.folders[folder] = {
          fileCount: count,
          size,
          sizeFormatted: formatBytes(size),
        };
      }
    }

    if (!stats.folders.map || stats.folders.map.fileCount === 0) {
      const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
      try {
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootChunks = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );
        if (rootChunks.length > 0) {
          let rootChunkSize = 0;
          for (const f of rootChunks) {
            try {
              const s = await fs.promises.stat(path.join(savePath, f.name));
              rootChunkSize += s.size;
            } catch (e) {
              log.debug(`Stat failed for root chunk ${f.name}: ${e.message}`);
            }
          }
          stats.folders["map (root)"] = {
            fileCount: rootChunks.length,
            size: rootChunkSize,
            sizeFormatted: formatBytes(rootChunkSize),
          };
        }
      } catch (e) {
        log.debug(`B41 root chunk scan failed: ${e.message}`);
      }
    }

    const playersDb = path.join(savePath, "players.db");
    if (fs.existsSync(playersDb)) {
      try {
        const s = await fs.promises.stat(playersDb);
        stats.playersDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for players.db: ${e.message}`);
      }
    }

    const vehiclesDb = path.join(savePath, "vehicles.db");
    if (fs.existsSync(vehiclesDb)) {
      try {
        const s = await fs.promises.stat(vehiclesDb);
        stats.vehiclesDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for vehicles.db: ${e.message}`);
      }
    }

    stats.totalSizeFormatted = formatBytes(stats.totalSize);

    res.json(stats);
  } catch (error) {
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get stats rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get save stats: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

const DIR_WALK_CONCURRENCY = 8;

async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const sizes = await runWithConcurrency(files, DIR_WALK_CONCURRENCY, async (file) => {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        return getDirSize(filePath);
      }
      try {
        const stats = await fs.promises.stat(filePath);
        return stats.size;
      } catch (e) {
        return 0;
      }
    });
    totalSize = sizes.reduce((a, b) => a + b, 0);
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`getDirSize error for ${dirPath}: ${err.message}`);
  }
  return totalSize;
}

async function getDirStats(dirPath) {
  let count = 0;
  let size = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    await runWithConcurrency(entries, DIR_WALK_CONCURRENCY, async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const sub = await getDirStats(entryPath);
        count += sub.count;
        size += sub.size;
        return;
      }
      count++;
      try {
        const stats = await fs.promises.stat(entryPath);
        size += stats.size;
      } catch (e) {
        // Matches getDirSize's silent-0-on-stat-failure — the file still
        // counts, it just doesn't contribute a known size.
      }
    });
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`getDirStats error for ${dirPath}: ${err.message}`);
  }
  return { count, size };
}

const MAP_SCAN_TTL_MS = 3000;
const _mapScanCache = new Map();
const _mapScanInflight = new Map();

async function getMapFolderScan(mapPath, emitProgress) {
  const cached = _mapScanCache.get(mapPath);
  if (cached && Date.now() - cached.at < MAP_SCAN_TTL_MS) {
    return cached.result;
  }
  const inflight = _mapScanInflight.get(mapPath);
  if (inflight) return inflight;
  const promise = scanMapFolder(mapPath, emitProgress)
    .then((result) => {
      _mapScanCache.set(mapPath, { result, at: Date.now() });
      return result;
    })
    .finally(() => {
      _mapScanInflight.delete(mapPath);
    });
  _mapScanInflight.set(mapPath, promise);
  return promise;
}

function invalidateMapFolderScan(mapPath) {
  _mapScanCache.delete(mapPath);
}

async function scanMapFolder(mapPath, emitProgress) {
  const mapExists = fs.existsSync(mapPath);
  if (!mapExists) {
    return { mapExists: false, isB42Structure: false };
  }

  const mapContents = await fs.promises.readdir(mapPath, {
    withFileTypes: true,
  });
  const xDirs = mapContents.filter(
    (d) => d.isDirectory() && /^\d+$/.test(d.name),
  );

  if (xDirs.length === 0) {
    return { mapExists: true, isB42Structure: false, mapContents };
  }

  const XDIR_SCAN_CONCURRENCY = 8;
  let totalBinFiles = 0;
  let totalNonBinFiles = 0;
  let totalNonBinSize = 0;
  let sampleNonBinFiles = [];
  let emptyDirs = 0;
  let scannedDirs = 0;
  const rawChunks = [];
  emitProgress?.(0, xDirs.length, 0, { force: true });

  await runWithConcurrency(xDirs, XDIR_SCAN_CONCURRENCY, async (xDir) => {
    const x = parseInt(xDir.name, 10);
    const xPath = path.join(mapPath, xDir.name);

    try {
      const yEntries = await fs.promises.readdir(xPath, {
        withFileTypes: true,
      });
      const yFiles = yEntries.filter((e) => e.isFile()).map((e) => e.name);

      if (yFiles.length === 0) {
        emptyDirs++;
        return;
      }

      const binFiles = yFiles.filter((f) => f.endsWith(".bin"));
      const nonBinFiles = yFiles.filter((f) => !f.endsWith(".bin"));
      totalBinFiles += binFiles.length;
      totalNonBinFiles += nonBinFiles.length;
      if (nonBinFiles.length > 0 && sampleNonBinFiles.length < 5) {
        sampleNonBinFiles.push(
          ...nonBinFiles.slice(0, 3).map((f) => `${xDir.name}/${f}`),
        );
      }

      const yMatches = [];
      for (const yFile of binFiles) {
        const yMatch = yFile.match(/^(\d+)\.bin$/);
        if (!yMatch) continue;
        yMatches.push({ y: parseInt(yMatch[1], 10), yFile });
      }

      const [chunkResults, nonBinSizes] = await Promise.all([
        Promise.all(
          yMatches.map(async ({ y, yFile }) => {
            const filePath = path.join(xPath, yFile);
            try {
              const stats = await fs.promises.stat(filePath);
              return {
                file: `${x}/${yFile}`,
                x,
                y,
                size: stats.size,
                modified: stats.mtime,
              };
            } catch (e) {
              log.debug(`Stat failed for chunk ${x}/${yFile}: ${e.message}`);
              return null;
            }
          }),
        ),
        Promise.all(
          nonBinFiles.map(async (f) => {
            try {
              const s = await fs.promises.stat(path.join(xPath, f));
              return s.size;
            } catch (e) {
              return 0;
            }
          }),
        ),
      ]);

      for (const chunk of chunkResults) {
        if (chunk) rawChunks.push(chunk);
      }
      totalNonBinSize += nonBinSizes.reduce((a, b) => a + b, 0);
    } catch (err) {
      log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
    }

    scannedDirs++;
    emitProgress?.(scannedDirs, xDirs.length, rawChunks.length);
  });

  log.info(
    `[ChunkCleaner] B42 scan: ${rawChunks.length} chunks loaded, ${totalBinFiles} .bin files, ${emptyDirs} empty dirs, ${totalNonBinFiles} non-.bin files${sampleNonBinFiles.length > 0 ? " (samples: " + sampleNonBinFiles.join(", ") + ")" : ""}`,
  );
  emitProgress?.(xDirs.length, xDirs.length, rawChunks.length, {
    force: true,
  });

  return {
    mapExists: true,
    isB42Structure: true,
    rawChunks,
    totalBinFiles,
    totalNonBinFiles,
    totalNonBinSize,
    emptyDirs,
    mapContents,
  };
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

router.get("/browse", requirePermission("chunks.manage"), async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const zomboidDataPath = await getZomboidDataPath();

    if (!browsePath) {
      return res.json({
        currentPath: zomboidDataPath || "",
        directories: [],
        hasSaves: false,
      });
    }

    if (!zomboidDataPath) {
      return res.status(400).json({
        error: "No Zomboid data path configured to browse",
        code: ErrorCode.BROWSE_CHUNKS_DATA_PATH_NOT_SET,
      });
    }

    const allowedRoots = [path.resolve(zomboidDataPath)];
    const resolved = confineToRoots(browsePath, allowedRoots);
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside the server's save directory",
        code: ErrorCode.BROWSE_CHUNKS_ACCESS_DENIED,
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(400).json({
        error: "Path does not exist",
        code: ErrorCode.BROWSE_CHUNKS_PATH_NOT_FOUND,
      });
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({
        error: "Path is not a directory",
        code: ErrorCode.BROWSE_CHUNKS_PATH_NOT_DIRECTORY,
      });
    }

    const entries = await fs.promises.readdir(resolved, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    const savesMultiplayer = path.join(resolved, "Saves", "Multiplayer");
    const hasSavesMultiplayer = fs.existsSync(savesMultiplayer);

    const basename = path.basename(resolved);
    const parentBase = path.basename(path.dirname(resolved));
    const isSavesMultiplayer =
      basename === "Multiplayer" && parentBase === "Saves";

    const B41_ROOT_REGEX = /^map_\d+_\d+\.bin$/i;
    const hasMapFolders = directories.some((d) => {
      const childPath = path.join(resolved, d);
      if (fs.existsSync(path.join(childPath, "map"))) return true;
      try {
        const childFiles = fs.readdirSync(childPath);
        return childFiles.some((f) => B41_ROOT_REGEX.test(f));
      } catch (e) {
        log.debug(`B41 check failed for ${d}: ${e.message}`);
        return false;
      }
    });

    res.json({
      currentPath: resolved,
      directories,
      hasSaves: hasSavesMultiplayer || isSavesMultiplayer || hasMapFolders,
      parent:
        path.dirname(resolved) !== resolved &&
        confineToRoots(path.dirname(resolved), allowedRoots)
          ? path.dirname(resolved)
          : null,
    });
  } catch (error) {
    log.error(`Failed to browse path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
