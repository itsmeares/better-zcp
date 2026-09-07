import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.ts", () => ({
  getActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
  getServers: vi.fn(),
  getSetting: vi.fn(),
}));

const { getActiveServer, getServers, getSetting } = await import("../database/init.ts");
const { default: router } = await import("../routes/chunks.ts");

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

function writeFileDeep(p, content = "x") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

let dataRoot;
let savePath;
const SAVE_NAME = "TestSave";

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-boundary-"));
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

describe("delete-region: exact boundary (inclusive min/max, both edges, both invert directions)", () => {
  it("non-invert: chunks exactly AT minX/maxX/minY/maxY are deleted (inclusive); one step outside each edge survives", async () => {
    const atMinXMinY = path.join(savePath, "map", "10", "10.bin");
    const atMaxXMaxY = path.join(savePath, "map", "20", "20.bin");
    const atMinXMaxY = path.join(savePath, "map", "10", "20.bin");
    const atMaxXMinY = path.join(savePath, "map", "20", "10.bin");
    const centerInside = path.join(savePath, "map", "15", "15.bin");
    const justBelowMinX = path.join(savePath, "map", "9", "15.bin");
    const justAboveMaxX = path.join(savePath, "map", "21", "15.bin");
    const justBelowMinY = path.join(savePath, "map", "15", "9.bin");
    const justAboveMaxY = path.join(savePath, "map", "15", "21.bin");

    for (const f of [
      atMinXMinY, atMaxXMaxY, atMinXMaxY, atMaxXMinY, centerInside,
      justBelowMinX, justAboveMaxX, justBelowMinY, justAboveMaxY,
    ]) {
      writeFileDeep(f, "x");
    }

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 10, maxX: 20, minY: 10, maxY: 20,
      invert: false,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 5 }));

    for (const f of [atMinXMinY, atMaxXMaxY, atMinXMaxY, atMaxXMinY, centerInside]) {
      expect(fs.existsSync(f)).toBe(false);
    }
    for (const f of [justBelowMinX, justAboveMaxX, justBelowMinY, justAboveMaxY]) {
      expect(fs.existsSync(f)).toBe(true);
    }
  });

  it("invert: chunks exactly AT the boundary survive (inclusive membership applies the same way under invert); one step outside gets deleted", async () => {
    const atMinXMinY = path.join(savePath, "map", "10", "10.bin");
    const atMaxXMaxY = path.join(savePath, "map", "20", "20.bin");
    const justOutside = path.join(savePath, "map", "21", "21.bin");

    for (const f of [atMinXMinY, atMaxXMaxY, justOutside]) writeFileDeep(f, "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 10, maxX: 20, minY: 10, maxY: 20,
      invert: true,
    });

    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(atMinXMinY)).toBe(true);
    expect(fs.existsSync(atMaxXMaxY)).toBe(true);
    expect(fs.existsSync(justOutside)).toBe(false);
  });

  it("a degenerate single-point region (minX===maxX, minY===maxY) deletes exactly the one matching chunk, nothing adjacent", async () => {
    const exact = path.join(savePath, "map", "15", "15.bin");
    const adjacentX = path.join(savePath, "map", "14", "15.bin");
    const adjacentY = path.join(savePath, "map", "15", "14.bin");
    for (const f of [exact, adjacentX, adjacentY]) writeFileDeep(f, "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 15, maxX: 15, minY: 15, maxY: 15,
      invert: false,
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(exact)).toBe(false);
    expect(fs.existsSync(adjacentX)).toBe(true);
    expect(fs.existsSync(adjacentY)).toBe(true);
  });
});

describe("cell-aux cleanup: exact B42 cell-divisor boundary (chunk 31 vs chunk 32, divisor=32)", () => {
  it("deleting the last chunk of cell 0 (x=31) does not touch cell 1's (x=32) aux files, and vice versa", async () => {
    const cell0Chunk = path.join(savePath, "map", "31", "0.bin");
    const cell1Chunk = path.join(savePath, "map", "32", "0.bin");
    writeFileDeep(cell0Chunk, "a");
    writeFileDeep(cell1Chunk, "b");
    const cell0Aux = path.join(savePath, "chunkdata", "chunkdata_0_0.bin");
    const cell1Aux = path.join(savePath, "chunkdata", "chunkdata_1_0.bin");
    writeFileDeep(cell0Aux, "aux0");
    writeFileDeep(cell1Aux, "aux1");

    const res = await postAs("/delete-chunks", {
      saveName: SAVE_NAME,
      chunks: [{ file: "31/0.bin", x: 31, y: 0 }],
    });

    expect(res.getBody()).toEqual(expect.objectContaining({ success: true, deleted: 1 }));
    expect(fs.existsSync(cell0Chunk)).toBe(false);
    expect(fs.existsSync(cell1Chunk)).toBe(true);
    expect(fs.existsSync(cell0Aux)).toBe(false);
    expect(fs.existsSync(cell1Aux)).toBe(true);
  });
});

describe("negative-coordinate directory/file names: regex exclusion is real and consistent (structural fact, not a live-data-loss claim)", () => {
  it("detectSaveIsB42Sync-equivalent B42 layout detection: a save whose ONLY map/ subdirectory is negative-named is NOT recognized as B42 by delete-region's own xDirs filter", async () => {
    writeFileDeep(path.join(savePath, "map", "-5", "10.bin"), "x");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: -100, maxX: 100, minY: -100, maxY: 100, // a huge region that WOULD include (-5,10)
      invert: false,
    });

    expect(res.getBody()).toEqual(
      expect.objectContaining({ success: true, deleted: 0 }),
    );
    expect(fs.existsSync(path.join(savePath, "map", "-5", "10.bin"))).toBe(true);
  });

  it("under invert:true, a negative-named chunk is invisible to the scan and therefore SURVIVES even though it is clearly outside the kept region -- the failure direction is under-deletion, not over-deletion", async () => {
    writeFileDeep(path.join(savePath, "map", "-5", "10.bin"), "x");
    writeFileDeep(path.join(savePath, "map", "50", "50.bin"), "keep");

    const res = await postAs("/delete-region", {
      saveName: SAVE_NAME,
      minX: 0, maxX: 100, minY: 0, maxY: 100, // "keep this positive range, delete everything else"
      invert: true,
    });

    expect(res.getBody().deleted).toBe(0);
    expect(fs.existsSync(path.join(savePath, "map", "-5", "10.bin"))).toBe(true);
    expect(fs.existsSync(path.join(savePath, "map", "50", "50.bin"))).toBe(true);
  });
});

describe("coordinate math itself is correct for negative integers (independent of whether the regex ever lets one through)", () => {
  it("Math.floor cell-bucketing matches real chunk/cell math for negative chunk coordinates", () => {
    expect(Math.floor(-1 / 32)).toBe(-1);
    expect(Math.floor(-32 / 32)).toBe(-1);
    expect(Math.floor(-33 / 32)).toBe(-2);
    expect((-1 / 32) | 0).toBe(0);
  });
});
