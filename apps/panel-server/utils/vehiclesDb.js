
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import initSqlJs from 'sql.js';
import { createLogger } from './logger.ts';

const log = createLogger('VehiclesDB');

let sqlPromise = null;

function locateWasm() {
  const candidates = [];

  if (process.pkg) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'sql-wasm.wasm'));
    candidates.push(path.join(execDir, 'assets', 'sql-wasm.wasm'));
  }

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, '../node_modules/sql.js/dist/sql-wasm.wasm'));
  } catch { /* ignore */ }

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
        return file;
      },
    });
  }
  return sqlPromise;
}

async function withDatabase(dbPath, fn) {
  const SQL = await getSQL();
  const buffer = await fs.promises.readFile(dbPath);
  const db = new SQL.Database(buffer);
  try {
    const result = await fn(db);
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

export async function deleteVehiclesInBoxes(savePath, boxes, opts = {}) {
  const dbPath = path.join(savePath, 'vehicles.db');
  if (!fs.existsSync(dbPath)) {
    return { deleted: 0, skipped: true, reason: 'vehicles.db not found (no persisted vehicles)' };
  }
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return { deleted: 0, skipped: true, reason: 'no boxes provided' };
  }
  for (const b of boxes) {
    if (!b
      || !Number.isFinite(b.x0) || !Number.isFinite(b.x1)
      || !Number.isFinite(b.y0) || !Number.isFinite(b.y1)
      || b.x1 <= b.x0 || b.y1 <= b.y0) {
      return { deleted: 0, skipped: true, reason: 'invalid bounding box' };
    }
  }

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
      let hasWxColumn = false;
      try {
        const probe = db.prepare('SELECT wx, wy FROM vehicles LIMIT 1');
        probe.free();
        hasWxColumn = true;
      } catch { /* column missing — fall back to tile-only delete */ }

      db.exec('BEGIN');
      try {
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
