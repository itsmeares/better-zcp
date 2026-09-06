import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import initSqlJs from 'sql.js';
import { fileURLToPath } from 'node:url';
import { deleteVehiclesInBoxes, countVehiclesInBoxes, deleteVehiclesInChunks } from '../utils/vehiclesDb.ts';


const FIXTURES = [
  { id: 1, wx: 100, wy: 100, x: 800.5,  y: 800.5,  worldversion: 240 },
  { id: 2, wx: 100, wy: 100, x: 807.9,  y: 807.9,  worldversion: 240 },  // same chunk as #1
  { id: 3, wx: 101, wy: 100, x: 808.0,  y: 803.0,  worldversion: 240 },  // next chunk east
  { id: 4, wx: 200, wy: 200, x: 1600.0, y: 1600.0, worldversion: 240 },  // far away
  { id: 5, wx: 101, wy: 101, x: 810.0,  y: 810.0,  worldversion: 240 },  // diagonal neighbour
];
const SQL_WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../node_modules/sql.js/dist/sql-wasm.wasm');

async function buildFixtureDb(dbPath) {
  const SQL = await initSqlJs({
    locateFile: () => SQL_WASM_PATH,
  });
  const db = new SQL.Database();
  db.exec(`CREATE TABLE vehicles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wx INTEGER, wy INTEGER,
    x FLOAT, y FLOAT,
    worldversion INTEGER,
    data BLOB
  )`);
  const stmt = db.prepare('INSERT INTO vehicles (id, wx, wy, x, y, worldversion, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const row of FIXTURES) {
    stmt.bind([row.id, row.wx, row.wy, row.x, row.y, row.worldversion, new Uint8Array([0, 1, 2])]);
    stmt.step();
    stmt.reset();
  }
  stmt.free();
  await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.promises.writeFile(dbPath, Buffer.from(db.export()));
  db.close();
}

async function makeSave(tmpDir, name) {
  const saveDir = path.join(tmpDir, name);
  await fs.promises.mkdir(saveDir, { recursive: true });
  await buildFixtureDb(path.join(saveDir, 'vehicles.db'));
  return saveDir;
}

async function getAllIds(dbPath) {
  const SQL = await initSqlJs({
    locateFile: () => SQL_WASM_PATH,
  });
  const buf = await fs.promises.readFile(dbPath);
  const db = new SQL.Database(buf);
  const rows = db.exec('SELECT id FROM vehicles ORDER BY id');
  db.close();
  return rows.length ? rows[0].values.map(r => r[0]) : [];
}

describe('vehiclesDb (chunk cleaner)', () => {
  let tmpDir;

  beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pzvdb-'));
  });

  afterAll(async () => {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('deletes only vehicles whose tile coords fall inside the bbox', async () => {
    const save = await makeSave(tmpDir, 'a');
    const result = await deleteVehiclesInBoxes(save, [
      { x0: 800, x1: 808, y0: 800, y1: 808 },
    ]);
    expect(result.skipped).toBe(false);
    expect(result.deleted).toBe(2);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([3, 4, 5]);
  });

  it('leaves far-away vehicles untouched', async () => {
    const save = await makeSave(tmpDir, 'b');
    await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }]);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toContain(4);
  });

  it('respects the half-open bbox (x1 is exclusive)', async () => {
    const save = await makeSave(tmpDir, 'c');
    await deleteVehiclesInBoxes(save, [{ x0: 800, x1: 808, y0: 800, y1: 808 }]);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toContain(3);
  });

  it('deleteVehiclesInChunks expands (chunkX,chunkY) into the right tile bbox', async () => {
    const save = await makeSave(tmpDir, 'd');
    const result = await deleteVehiclesInChunks(save, [{ x: 101, y: 100 }], 8);
    expect(result.deleted).toBe(1);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([1, 2, 4, 5]);
  });

  it('countVehiclesInBoxes reports correct totals without mutating', async () => {
    const save = await makeSave(tmpDir, 'e');
    const count = await countVehiclesInBoxes(save, [
      { x0: 800, x1: 816, y0: 800, y1: 816 }, // 2x2 chunks → #1,#2,#3,#5
    ]);
    expect(count).toBe(4);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles multiple bboxes in one transaction', async () => {
    const save = await makeSave(tmpDir, 'f');
    const result = await deleteVehiclesInBoxes(save, [
      { x0: 800, x1: 808, y0: 800, y1: 808 },       // #1, #2
      { x0: 1600, x1: 1608, y0: 1600, y1: 1608 },   // #4
    ]);
    expect(result.deleted).toBe(3);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([3, 5]);
  });

  it('returns skipped when DB is missing', async () => {
    const emptySave = path.join(tmpDir, 'empty');
    await fs.promises.mkdir(emptySave, { recursive: true });
    const result = await deleteVehiclesInBoxes(
      emptySave,
      [{ x0: 0, x1: 8, y0: 0, y1: 8 }],
    );
    expect(result.skipped).toBe(true);
    expect(result.deleted).toBe(0);
  });

  it('rejects invalid bboxes (NaN/inverted/empty)', async () => {
    const save = await makeSave(tmpDir, 'g');
    const cases = [
      [{ x0: NaN, x1: 8, y0: 0, y1: 8 }],
      [{ x0: 8, x1: 0, y0: 0, y1: 8 }],       // inverted X
      [{ x0: 0, x1: 8, y0: Infinity, y1: 8 }],
    ];
    for (const boxes of cases) {
      const result = await deleteVehiclesInBoxes(save, boxes);
      expect(result.skipped).toBe(true);
    }
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('creates a backup copy before mutating when backupPath is set', async () => {
    const save = await makeSave(tmpDir, 'h');
    const backupPath = path.join(tmpDir, 'backups', 'h.db.bak');
    const result = await deleteVehiclesInBoxes(
      save,
      [{ x0: 800, x1: 808, y0: 800, y1: 808 }],
      { backupPath },
    );
    expect(result.deleted).toBe(2);
    expect(fs.existsSync(backupPath)).toBe(true);
    const backupIds = await getAllIds(backupPath);
    expect(backupIds).toEqual([1, 2, 3, 4, 5]);
  });

  it('aborts (does not mutate) when backup path is unwritable', async () => {
    const save = await makeSave(tmpDir, 'i');
    const result = await deleteVehiclesInBoxes(
      save,
      [{ x0: 800, x1: 808, y0: 800, y1: 808 }],
      { backupPath: path.join(tmpDir, 'bad\u0000path', 'x.bak') },
    );
    expect(result.skipped).toBe(true);
    expect(await getAllIds(path.join(save, 'vehicles.db'))).toEqual([1, 2, 3, 4, 5]);
  });
});
