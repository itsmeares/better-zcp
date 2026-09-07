import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";


vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.ts");
const { default: router } = await import("../routes/chunks.ts");

let sqlPromise = null;
const SQL_WASM_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/sql.js/dist/sql-wasm.wasm");
function getSQL() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({
      locateFile: () => SQL_WASM_PATH,
    });
  }
  return sqlPromise;
}

async function createVehiclesDb(dbPath, rows) {
  const SQL = await getSQL();
  const db = new SQL.Database();
  db.run(
    "CREATE TABLE vehicles (id INTEGER PRIMARY KEY AUTOINCREMENT, wx INTEGER, wy INTEGER, x FLOAT, y FLOAT, worldversion INTEGER, data BLOB)",
  );
  const stmt = db.prepare(
    "INSERT INTO vehicles (wx, wy, x, y, worldversion, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const r of rows) {
    stmt.run([r.wx, r.wy, r.x, r.y, r.worldversion ?? 1, r.data ?? null]);
  }
  stmt.free();
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

async function readVehicleIds(dbPath) {
  const SQL = await getSQL();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = db.prepare("SELECT id, x, y, wx, wy FROM vehicles ORDER BY id");
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  db.close();
  return rows;
}

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function writeDirDeep(p) {
  fs.mkdirSync(p, { recursive: true });
}

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  let body = null;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  return response;
}

function getRouteHandlers(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  return layer.route.stack.map((s) => s.handle);
}

async function runRoute(routePath, method, req) {
  const handlers = getRouteHandlers(routePath, method);
  const res = createResponse();
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function postAs(routePath, body) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    body: { force: true, createBackup: false, deleteVehicles: false, ...body },
  });
}

const SAVE_NAME = "TestSave";
let dataRoot;
let savePath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-deletion-"));
  savePath = path.join(dataRoot, "Saves", "Multiplayer", SAVE_NAME);
  fs.mkdirSync(savePath, { recursive: true });
  getActiveServer.mockReset().mockResolvedValue({
    id: "server-1",
    zomboidDataPath: dataRoot,
    isRemote: false,
  });
  getServers.mockReset().mockResolvedValue([]);
  getSetting.mockReset().mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

describe("delete-chunks: files that must survive (B42)", () => {
  it("a partial cell deletion leaves the untouched sibling chunk, an unrelated cell's chunk, and the cell's aux files intact -- then finishing the cell off removes the aux files without touching the unrelated cell", async () => {
    const chunkA = path.join(savePath, "map", "0", "0.bin");
    const chunkB = path.join(savePath, "map", "0", "1.bin");
    const chunkC = path.join(savePath, "map", "40", "5.bin");
    writeFileDeep(chunkA, "a");
    writeFileDeep(chunkB, "b");
    writeFileDeep(chunkC, "c");

    const auxFiles = [
      path.join(savePath, "chunkdata", "chunkdata_0_0.bin"),
      path.join(savePath, "zpop", "zpop_0_0.bin"),
      path.join(savePath, "metagrid", "metacell_0_0.bin"),
      path.join(savePath, "apop", "apop_0_0.bin"),
    ];
    for (const f of auxFiles) writeFileDeep(f, "aux");

    const res1 = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });
    expect(res1.getStatusCode()).toBe(200);
    expect(res1.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));

    expect(fs.existsSync(chunkA)).toBe(false);
    expect(fs.existsSync(chunkB)).toBe(true);
    expect(fs.existsSync(chunkC)).toBe(true);
    for (const f of auxFiles) {
      expect(fs.existsSync(f), `${f} should still exist -- cell (0,0) is not empty yet`).toBe(true);
    }

    const res2 = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/1.bin", x: 0, y: 1 }],
    });
    expect(res2.getStatusCode()).toBe(200);
    expect(res2.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, cellFilesRemoved: 4 }),
    );

    expect(fs.existsSync(chunkB)).toBe(false);
    expect(fs.existsSync(chunkC)).toBe(true);
    for (const f of auxFiles) {
      expect(fs.existsSync(f), `${f} should be gone -- cell (0,0) is now empty`).toBe(false);
    }
  });
});

describe("B42 vs B41 layout detection", () => {
  it("delete-chunks on a B41 flat save deletes the flat file and never runs B42 cell-aux cleanup on it", async () => {
    const flatChunk = path.join(savePath, "map", "0_0.bin");
    writeFileDeep(flatChunk, "b41");

    const spuriousAux = path.join(savePath, "chunkdata", "chunkdata_0_0.bin");
    writeFileDeep(spuriousAux, "aux");

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0_0.bin", x: 0, y: 0 }],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, cellFilesRemoved: 0 }),
    );
    expect(fs.existsSync(flatChunk)).toBe(false);
    expect(fs.existsSync(spuriousAux), "B41 saves must never run B42 cell-aux cleanup").toBe(true);
  });

  it("delete-region on a B42 save only deletes chunks inside the region (both directions of invert)", async () => {
    const inRegion = path.join(savePath, "map", "2", "2.bin");
    const outRegionSameDir = path.join(savePath, "map", "2", "8.bin");
    const outRegionOtherDir = path.join(savePath, "map", "9", "9.bin");
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegionSameDir, "b");
    writeFileDeep(outRegionOtherDir, "c");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: false,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(inRegion)).toBe(false);
    expect(fs.existsSync(outRegionSameDir)).toBe(true);
    expect(fs.existsSync(outRegionOtherDir)).toBe(true);
  });

  it("delete-region with invert:true deletes everything OUTSIDE the region instead", async () => {
    const inRegion = path.join(savePath, "map", "2", "2.bin");
    const outRegionSameDir = path.join(savePath, "map", "2", "8.bin");
    const outRegionOtherDir = path.join(savePath, "map", "9", "9.bin");
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegionSameDir, "b");
    writeFileDeep(outRegionOtherDir, "c");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 2 }));
    expect(fs.existsSync(inRegion), "inside the region -- must survive an inverted delete").toBe(true);
    expect(fs.existsSync(outRegionSameDir)).toBe(false);
    expect(fs.existsSync(outRegionOtherDir)).toBe(false);
  });

  it("delete-region on a B41 flat save (files directly in map/, no subdirectories) uses the flat-file branch, not the B42 subdirectory scan", async () => {
    const inRegion = path.join(savePath, "map", "3_3.bin");
    const outRegion = path.join(savePath, "map", "20_20.bin");
    writeFileDeep(inRegion, "a");
    writeFileDeep(outRegion, "b");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(inRegion)).toBe(false);
    expect(fs.existsSync(outRegion)).toBe(true);
  });
});

describe("partial failure: does the response report what actually happened?", () => {
  it("delete-chunks: an undeletable chunk is excluded from the deleted count, surfaced in errors, and left on disk -- not silently counted as gone", async () => {
    const goodChunk = path.join(savePath, "map", "0", "0.bin");
    const badChunkPath = path.join(savePath, "map", "40", "0.bin");
    writeFileDeep(goodChunk, "a");
    writeDirDeep(badChunkPath);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [
        { file: "0/0.bin", x: 0, y: 0 },
        { file: "40/0.bin", x: 40, y: 0 },
      ],
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(1);
    expect(body.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("40/0.bin")]),
    );
    expect(fs.existsSync(goodChunk)).toBe(false);
    expect(fs.existsSync(badChunkPath), "the chunk that failed to delete must still be there").toBe(true);
  });

  it("delete-region: an undeletable chunk is excluded from the deleted count, surfaced in errors, and left on disk -- fixed to match delete-chunks' shape (was previously silent; see git history)", async () => {
    const goodChunk = path.join(savePath, "map", "2", "2.bin");
    const badChunkPath = path.join(savePath, "map", "2", "3.bin");
    writeFileDeep(goodChunk, "a");
    writeDirDeep(badChunkPath);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(1);
    expect(body.errors).toEqual(expect.arrayContaining([expect.stringContaining("2/3.bin")]));
    expect(fs.existsSync(goodChunk)).toBe(false);
    expect(fs.existsSync(badChunkPath), "the chunk that failed to delete must still be there").toBe(true);
  });

  it("delete-region: a clean delete with no failures omits errors entirely, not an empty array -- nothing in the client reads this response today (deleteRegion has zero callers), but the shape must still match delete-chunks' convention exactly", async () => {
    const onlyChunk = path.join(savePath, "map", "2", "2.bin");
    writeFileDeep(onlyChunk, "a");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    expect(body.success).toBe(true);
    expect(body.deleted).toBe(1);
    expect(body.errors).toBeUndefined();
  });
});

describe("legacy flat-file regex: anchored to reject aux-family filenames", () => {
  it("delete-region ignores an aux-family filename sitting in map/, even though it falls inside the requested region", async () => {
    const realChunk = path.join(savePath, "map", "3_3.bin");
    const auxLookalike = path.join(savePath, "map", "zpop_4_4.bin");
    writeFileDeep(realChunk, "a");
    writeFileDeep(auxLookalike, "b");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 10,
      minY: 0,
      maxY: 10,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(realChunk)).toBe(false);
    expect(fs.existsSync(auxLookalike), "zpop_4_4.bin must survive -- it is not a chunk file").toBe(true);
  });
});

describe("DELETE_CHUNKS_TOO_MANY sends { count } on the wire, not just an unparameterized message", () => {
  it("reports the actual submitted chunk count when it exceeds the 100,000 cap", async () => {
    const chunks = Array.from({ length: 100001 }, (_, i) => ({
      file: `${i}/0.bin`,
      x: i,
      y: 0,
    }));
    const res = await postAs("/delete-chunks", { saveName: SAVE_NAME, chunks });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({
      code: "DELETE_CHUNKS_TOO_MANY",
      params: { count: 100001 },
    });
  });
});

describe("vehicles.db pruning", () => {
  it("deleting a chunk prunes vehicles matching it by tile coords OR by drifted chunk coords, and leaves an unrelated vehicle alone", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");

    const dbPath = path.join(savePath, "vehicles.db");
    await createVehiclesDb(dbPath, [
      { wx: 0, wy: 0, x: 3, y: 3 }, // tile coords land inside the deleted chunk's box -- prune
      { wx: 0, wy: 0, x: 999, y: 999 }, // tile coords drifted out, but chunk coords still match -- prune via the fallback pass
      { wx: 5, wy: 5, x: 500, y: 500 }, // neither tile nor chunk coords match -- must survive
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      deleteVehicles: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1, vehiclesDeleted: 2 }));

    const remaining = await readVehicleIds(dbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual(expect.objectContaining({ wx: 5, wy: 5 }));
  });
});

function postAsWithServerManager(routePath, body, serverManager) {
  return runRoute(routePath, "post", {
    user: { role: "technician" },
    app: { get: (key) => (key === "serverManager" ? serverManager : null) },
    body: { force: false, createBackup: false, deleteVehicles: false, ...body },
  });
}

describe("delete-chunks/delete-region: an undetermined server state must refuse, not be read as 'stopped'", () => {
  it("delete-chunks refuses with SERVER_STATE_UNKNOWN when the running-scan itself failed (scanFailed:true), and never touches the file", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-region refuses with SERVER_STATE_UNKNOWN when the running-scan itself failed (scanFailed:true), and never touches the file", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: true }),
    };

    const res = await postAsWithServerManager(
      "/delete-region",
      { saveName: SAVE_NAME, minX: 0, maxX: 10, minY: 0, maxY: 10 },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks refuses with SERVER_STATE_UNKNOWN rather than silently proceeding when the running-check itself throws", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => {
        throw new Error("boom-process-scan");
      },
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks still refuses on a confirmed-running server (running:true, scanFailed:false) -- unaffected by this fix", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({
        running: true,
        scanFailed: false,
        matched: [{ pid: "123", cmd: "java ... -servername TestSave" }],
      }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody()).toMatchObject({ code: "server_running" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks proceeds normally when the scan confirms the server is stopped (running:false, scanFailed:false)", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(200);
    expect(fs.existsSync(chunk)).toBe(false);
  });

  it("delete-chunks refuses with SERVER_STATE_UNKNOWN when the serverManager has no process-detection method at all", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      checkServerRunning: async () => false,
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-region refuses with SERVER_STATE_UNKNOWN when the serverManager has no process-detection method at all", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      checkServerRunning: async () => false,
    };

    const res = await postAsWithServerManager(
      "/delete-region",
      { saveName: SAVE_NAME, minX: 0, maxX: 10, minY: 0, maxY: 10 },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("delete-chunks refuses with SERVER_STATE_UNKNOWN when checkServerRunning would have said false but process detection actually threw", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    const serverManager = {
      getServerProcessDetails: async () => {
        throw new Error("boom-process-scan");
      },
      checkServerRunning: async () => false,
    };

    const res = await postAsWithServerManager(
      "/delete-chunks",
      { saveName: SAVE_NAME, chunks: [{ file: "0/0.bin", x: 0, y: 0 }] },
      serverManager,
    );

    expect(res.getStatusCode()).toBe(503);
    expect(res.getBody()).toMatchObject({ code: "SERVER_STATE_UNKNOWN" });
    expect(fs.existsSync(chunk)).toBe(true);
  });
});

describe("customPath must resolve to a location the panel already recognizes", () => {
  it("refuses delete-chunks when customPath matches no configured server and no OS-standard candidate", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      customPath: dataRoot,
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/isn't a location the panel already recognizes/i);
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("refuses delete-region the same way", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 1,
      minY: 0,
      maxY: 1,
      customPath: dataRoot,
    });

    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().error).toMatch(/isn't a location the panel already recognizes/i);
    expect(fs.existsSync(chunk)).toBe(true);
  });

  it("still deletes via customPath when it matches a DIFFERENT configured server's zomboidDataPath (not just the active one)", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");
    getServers.mockResolvedValue([
      { id: "server-1", zomboidDataPath: path.join(os.tmpdir(), "unrelated-active-server") },
      { id: "server-2", zomboidDataPath: dataRoot },
    ]);

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
      customPath: dataRoot,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(chunk)).toBe(false);
  });

  it("still deletes when no customPath is given at all (the active server's own path is trusted by default, unaffected by this gate)", async () => {
    const chunk = path.join(savePath, "map", "0", "0.bin");
    writeFileDeep(chunk, "a");

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(chunk)).toBe(false);
  });
});

describe("delete-region: chunkdata-only cells (gap a)", () => {
  it("deletes a chunkdata-only cell inside the region even though it has no matching map/X/Y.bin file at all", async () => {
    const unrelatedChunk = path.join(savePath, "map", "50", "50.bin");
    writeFileDeep(unrelatedChunk, "u");

    const chunkDataOnly = path.join(savePath, "chunkdata", "0_0.bin");
    writeFileDeep(chunkDataOnly, "cd");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(chunkDataOnly), "the chunkdata-only cell must be deleted").toBe(false);
    expect(fs.existsSync(unrelatedChunk), "unrelated cell must survive").toBe(true);
  });

  it("leaves a chunkdata entry outside the region untouched, and invert:true deletes it instead while sparing the in-region one", async () => {
    const insideRegion = path.join(savePath, "chunkdata", "0_0.bin");
    const outsideRegion = path.join(savePath, "chunkdata", "9_9.bin");
    writeFileDeep(insideRegion, "a");
    writeFileDeep(outsideRegion, "b");

    const res1 = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: false,
    });
    expect(res1.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(insideRegion)).toBe(false);
    expect(fs.existsSync(outsideRegion), "outside the region -- must survive a non-inverted delete").toBe(true);

    const res2 = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      invert: true,
    });
    expect(res2.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(outsideRegion), "inverted delete removes what's outside the region").toBe(false);
  });
});

describe("delete-region: B42 vs B41 classification for chunkdata coordinates (gap b)", () => {
  it("converts chunkdata cell coords using the B42 divisor (32), not B41 (30), even when map/ has no numeric subdirectories yet", async () => {
    fs.mkdirSync(path.join(savePath, "map"), { recursive: true });
    writeFileDeep(path.join(savePath, "WorldDictionary.bin"), "indicator");

    const cell = path.join(savePath, "chunkdata", "1_0.bin");
    writeFileDeep(cell, "cd");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 31,
      maxX: 40,
      minY: 0,
      maxY: 0,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(cell), "misclassifying this save as B41 would compute displayX=30, outside [31,40], and silently skip it").toBe(false);
  });
});

describe("delete-region: chunkdata deletion prunes vehicles across the WHOLE cell, not just its corner chunk", () => {
  it("prunes a vehicle sitting in the cell's interior (well outside the corner chunk's own 8x8 tile box) when deleting a chunkdata-only cell", async () => {
    writeFileDeep(path.join(savePath, "map", "50", "50.bin"), "u");

    const chunkDataOnly = path.join(savePath, "chunkdata", "0_0.bin");
    writeFileDeep(chunkDataOnly, "cd");

    const dbPath = path.join(savePath, "vehicles.db");
    await createVehiclesDb(dbPath, [
      { wx: 999, wy: 999, x: 100, y: 50 },
      { wx: 999, wy: 999, x: 500, y: 500 }, // outside the cell entirely -- must survive
    ]);

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0,
      maxX: 5,
      minY: 0,
      maxY: 5,
      deleteVehicles: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 1, vehiclesDeleted: 1 }),
    );
    const remaining = await readVehicleIds(dbPath);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toEqual(expect.objectContaining({ x: 500, y: 500 }));
  });
});
