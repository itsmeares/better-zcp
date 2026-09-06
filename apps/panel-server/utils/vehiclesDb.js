// Vehicle database helper for the chunk cleaner.
// PZ saves store all persisted vehicles in <save>/vehicles.db (SQLite).
// Schema (B41 & B42 identical):
//   CREATE TABLE vehicles (
//     id INTEGER PRIMARY KEY AUTOINCREMENT,
//     wx INTEGER,        -- world chunk X
//     wy INTEGER,        -- world chunk Y
//     x  FLOAT,          -- world tile X (absolute)
//     y  FLOAT,          -- world tile Y (absolute)
//     worldversion INTEGER,
//     data BLOB          -- serialized vehicle state
//   )
//
// We must operate on the DB directly because the PanelBridge runtime path only
// removes vehicles that are currently *loaded* in memory. Vehicles in cells not
// actively streamed by any player stay untouched in vehicles.db and re-materialize
// as soon as a player re-enters the cell — even if map/X/Y.bin was deleted.
//
// Uses sql.js (pure-JS WASM SQLite) so it works inside pkg binaries without
// any native build toolchain or per-platform prebuilds.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { createLogger } from './logger.js';

const log = createLogger('VehiclesDB');

let sqlPromise = null;

// Resolve the sql-wasm.wasm file. In dev it sits inside node_modules; inside a
// pkg binary the wasm must be shipped next to the executable (see scripts/release/build.mjs).
function locateWasm() {
  const candidates = [];

  // 1. Alongside the current executable (pkg build)
  if (process.pkg) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'sql-wasm.wasm'));
    candidates.push(path.join(execDir, 'assets', 'sql-wasm.wasm'));
  }

  // 2. Next to this file (dev mode — node_modules resolved)
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, '../node_modules/sql.js/dist/sql-wasm.wasm'));
  } catch { /* ignore */ }

  // 3. CWD fallback
  candidates.push(path.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'));
  candidates.push(path.resolve(process.cwd(), 'sql-wasm.wasm'));

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return null;
}

async function getSQL() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: (file) => {
        const wasmPath = locateWasm();
        if (wasmPath) return wasmPath;
        // Fall back to relative; initSqlJs will fail with a useful error
        return file;
      },
    });
  }
  return sqlPromise;
}

/**
 * Open a vehicles.db file, run a user-supplied function, and persist changes.
 * Caller is responsible for making a backup before calling if desired.
 *
 * @param {string} dbPath Absolute path to vehicles.db
 * @param {(db: import('sql.js').Database) => Promise<any>|any} fn
 * @returns {Promise<any>} Whatever fn returned
 */
async function withDatabase(dbPath, fn) {
  const SQL = await getSQL();
  const buffer = await fs.promises.readFile(dbPath);
  const db = new SQL.Database(buffer);
  try {
    const result = await fn(db);
    // Persist changes atomically: write to temp then rename.
    const exported = db.export();
    const tmp = `${dbPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, Buffer.from(exported));
    await fs.promises.rename(tmp, dbPath);
    return result;
  } finally {
    db.close();
  }
}

async function withReadOnlyDatabase(dbPath, fn) {
  const SQL = await getSQL();
  const buffer = await fs.promises.readFile(dbPath);
  const db = new SQL.Database(buffer);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/**
 * List persisted vehicle positions without modifying the live save database.
 * Runtime bridge data only includes currently loaded cells; this covers parked
 * vehicles while no player is near them.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {number} [limit]
 * @returns {Promise<Array<{id:number,x:number,y:number}>>}
 */
export async function listPersistedVehicles(savePath, limit = 10000) {
  const dbPath = path.join(savePath, 'vehicles.db');
  if (!fs.existsSync(dbPath)) return [];
  const safeLimit = Math.max(1, Math.min(50000, Math.floor(limit) || 10000));
  try {
    return await withReadOnlyDatabase(dbPath, (db) => {
      const stmt = db.prepare(
        'SELECT id, x, y FROM vehicles WHERE x IS NOT NULL AND y IS NOT NULL LIMIT ?'
      );
      const vehicles = [];
      try {
        stmt.bind([safeLimit]);
        while (stmt.step()) {
          const row = stmt.getAsObject();
          const id = Number(row.id);
          const x = Number(row.x);
          const y = Number(row.y);
          if (Number.isFinite(id) && Number.isFinite(x) && Number.isFinite(y)) {
            vehicles.push({ id, x, y });
          }
        }
      } finally {
        stmt.free();
      }
      return vehicles;
    });
  } catch (err) {
    log.warn(`listPersistedVehicles failed on ${dbPath}: ${err.message}`);
    return [];
  }
}

/**
 * Count vehicles in vehicles.db whose tile coords fall inside any of the
 * provided tile bounding boxes. Read-only.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} boxes Tile bboxes (half-open: [x0,x1))
 * @returns {Promise<number>} count (0 if vehicles.db missing)
 */
export async function countVehiclesInBoxes(savePath, boxes) {
  const dbPath = path.join(savePath, 'vehicles.db');
  if (!fs.existsSync(dbPath)) return 0;
  if (!Array.isArray(boxes) || boxes.length === 0) return 0;
  try {
    return await withDatabase(dbPath, (db) => {
      let total = 0;
      const stmt = db.prepare(
        'SELECT COUNT(*) AS n FROM vehicles WHERE x >= ? AND x < ? AND y >= ? AND y < ?'
      );
      try {
        for (const b of boxes) {
          stmt.bind([b.x0, b.x1, b.y0, b.y1]);
          if (stmt.step()) {
            const row = stmt.getAsObject();
            total += Number(row.n) || 0;
          }
          stmt.reset();
        }
      } finally {
        stmt.free();
      }
      return total;
    });
  } catch (err) {
    log.warn(`countVehiclesInBoxes failed on ${dbPath}: ${err.message}`);
    return 0;
  }
}

/**
 * Delete rows from vehicles.db for every vehicle whose tile coordinates fall
 * inside any of the provided tile bounding boxes.
 *
 * If a box also provides wx0/wx1/wy0/wy1 (chunk-coord bounds), those are
 * OR'd into the WHERE clause. PZ stores both tile (x,y) and chunk (wx,wy)
 * coords on each vehicle row, and there are rare cases where a vehicle mid-
 * move has drifted tile coords out of sync with its chunk coords. Matching
 * on BOTH guarantees we catch everything the chunk file represented.
 *
 * This works whether the server is stopped or running, but the caller SHOULD
 * stop the server first — otherwise the running process may hold the DB file
 * open (on Windows) or write back stale state when it shuts down.
 *
 * @param {string} savePath Absolute path to the save directory
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,wx0?:number,wx1?:number,wy0?:number,wy1?:number}>} boxes Tile bboxes (half-open: [x0,x1)), optionally with chunk-coord bboxes
 * @param {object}   [opts]
 * @param {string}   [opts.backupPath]  If set, copy vehicles.db here before mutation
 * @returns {Promise<{deleted:number, skipped:boolean, reason?:string}>}
 */
export async function deleteVehiclesInBoxes(savePath, boxes, opts = {}) {
  const dbPath = path.join(savePath, 'vehicles.db');
  if (!fs.existsSync(dbPath)) {
    return { deleted: 0, skipped: true, reason: 'vehicles.db not found (no persisted vehicles)' };
  }
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { deleted: 0, skipped: true, reason: 'no boxes provided' };
  }
  // Validate boxes — refuse NaN/Infinity that would match everything or nothing.
  for (const b of boxes) {
    if (!b
      || !Number.isFinite(b.x0) || !Number.isFinite(b.x1)
      || !Number.isFinite(b.y0) || !Number.isFinite(b.y1)
      || b.x1 <= b.x0 || b.y1 <= b.y0) {
      return { deleted: 0, skipped: true, reason: 'invalid bounding box' };
    }
  }

  // Backup BEFORE any mutation so rollback is always possible.
  if (opts.backupPath) {
    try {
      await fs.promises.mkdir(path.dirname(opts.backupPath), { recursive: true });
      await fs.promises.copyFile(dbPath, opts.backupPath);
    } catch (err) {
      log.warn(`Failed to backup vehicles.db to ${opts.backupPath}: ${err.message}`);
      return { deleted: 0, skipped: true, reason: `backup failed: ${err.message}` };
    }
  }

  try {
    return await withDatabase(dbPath, (db) => {
      // Verify table exists. Rather than poke sqlite_master (whose exact
      // layout differs between sql.js builds) we simply try to compile a
      // statement against the table — missing table throws SQLITE_ERROR.
      let hasTable = false;
      try {
        const probe = db.prepare('SELECT 1 FROM vehicles LIMIT 1');
        probe.free();
        hasTable = true;
      } catch (e) {
        log.warn(`vehicles.db at ${dbPath} has no 'vehicles' table (${e.message}) — skipping`);
      }
      if (!hasTable) {
        return { deleted: 0, skipped: true, reason: 'no vehicles table' };
      }

      let deleted = 0;
      // Detect whether a wx column exists (should on all PZ versions, but
      // be defensive — some early B42 builds/modded schemas may differ).
      let hasWxColumn = false;
      try {
        const probe = db.prepare('SELECT wx, wy FROM vehicles LIMIT 1');
        probe.free();
        hasWxColumn = true;
      } catch { /* column missing — fall back to tile-only delete */ }

      db.exec('BEGIN');
      try {
        // Tile-coord pass — primary match on (x, y) in tile space.
        const tileStmt = db.prepare(
          'DELETE FROM vehicles WHERE x >= ? AND x < ? AND y >= ? AND y < ?'
        );
        try {
          for (const b of boxes) {
            tileStmt.bind([b.x0, b.x1, b.y0, b.y1]);
            tileStmt.step();
            tileStmt.reset();
            deleted += db.getRowsModified();
          }
        } finally {
          tileStmt.free();
        }

        // Chunk-coord pass — catches vehicles whose tile coords drifted out
        // of sync with their chunk coords (rare but observed when a vehicle
        // was mid-move at save time). Only runs for boxes that supplied
        // wx0/wx1/wy0/wy1 AND on schemas that actually have the columns.
        if (hasWxColumn) {
          const chunkStmt = db.prepare(
            'DELETE FROM vehicles WHERE wx >= ? AND wx < ? AND wy >= ? AND wy < ?'
          );
          try {
            for (const b of boxes) {
              if (!Number.isFinite(b.wx0) || !Number.isFinite(b.wx1)
                || !Number.isFinite(b.wy0) || !Number.isFinite(b.wy1)
                || b.wx1 <= b.wx0 || b.wy1 <= b.wy0) continue;
              chunkStmt.bind([b.wx0, b.wx1, b.wy0, b.wy1]);
              chunkStmt.step();
              chunkStmt.reset();
              deleted += db.getRowsModified();
            }
          } finally {
            chunkStmt.free();
          }
        }

        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
      return { deleted, skipped: false };
    });
  } catch (err) {
    log.error(`deleteVehiclesInBoxes failed on ${dbPath}: ${err.message}`);
    throw err;
  }
}

/**
 * Convenience wrapper: convert per-chunk coords to tile bboxes and delegate.
 * Use deleteVehiclesInBoxes directly for multi-chunk (cell) spans.
 *
 * @param {string} savePath
 * @param {Array<{x:number,y:number}>} chunks Chunk coords
 * @param {number} tilesPerChunk 8 (B42) or 10 (B41)
 * @param {object} [opts]
 */
export async function deleteVehiclesInChunks(savePath, chunks, tilesPerChunk, opts = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { deleted: 0, skipped: true, reason: 'no chunks provided' };
  }
  if (!Number.isFinite(tilesPerChunk) || tilesPerChunk <= 0) {
    return { deleted: 0, skipped: true, reason: 'invalid tilesPerChunk' };
  }
  const boxes = chunks.map(c => ({
    x0: c.x * tilesPerChunk,
    x1: c.x * tilesPerChunk + tilesPerChunk,
    y0: c.y * tilesPerChunk,
    y1: c.y * tilesPerChunk + tilesPerChunk,
    wx0: c.x,
    wx1: c.x + 1,
    wy0: c.y,
    wy1: c.y + 1,
  }));
  return deleteVehiclesInBoxes(savePath, boxes, opts);
}
