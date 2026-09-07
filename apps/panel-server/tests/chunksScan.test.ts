import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const getActiveServer = vi.fn();
const getSetting = vi.fn();
const getServers = vi.fn();

vi.mock("../database/init.ts", () => ({
  getSetting,
  setSetting: vi.fn(),
  getActiveServer,
  updateServer: vi.fn(),
  getServers,
}));

const { default: router } = await import("../routes/chunks.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method = "get") {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function buildFixture(root, saveName) {
  const savePath = path.join(root, "Saves", "Multiplayer", saveName);
  const mapPath = path.join(savePath, "map");
  for (const x of [0, 1, 2]) {
    const xPath = path.join(mapPath, String(x));
    fs.mkdirSync(xPath, { recursive: true });
    for (const y of [0, 1]) {
      fs.closeSync(fs.openSync(path.join(xPath, `${y}.bin`), "w"));
    }
  }
  const chunkDataPath = path.join(savePath, "chunkdata");
  fs.mkdirSync(chunkDataPath, { recursive: true });
  fs.closeSync(fs.openSync(path.join(chunkDataPath, "0_0.bin"), "w"));
  return savePath;
}

describe("GET /api/chunks/chunks/:saveName and /api/chunks/stats/:saveName", () => {
  let dataRoot;
  const saveName = "PinnedTestSave";

  beforeEach(() => {
    getActiveServer.mockReset();
    getSetting.mockReset();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-scan-FakeZomboidData-"));
    buildFixture(dataRoot, saveName);
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("lists every chunk with correct coordinates, dedup, and bounds", async () => {
    const response = createResponse();
    await getHandler("/chunks/:saveName")(
      { params: { saveName }, query: { customPath: dataRoot }, app: { get: () => null } },
      response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledTimes(1);
    const body = response.json.mock.calls[0][0];

    expect(body.isB42).toBe(true);
    expect(body.totalChunks).toBe(7);
    expect(body.bounds).toEqual({ minX: 0, maxX: 2, minY: 0, maxY: 1 });

    const mapCoords = body.chunks
      .filter((c) => c.source !== "chunkdata")
      .map((c) => `${c.x},${c.y}`)
      .sort();
    expect(mapCoords).toEqual([
      "0,0", "0,1",
      "1,0", "1,1",
      "2,0", "2,1",
    ].sort());
    expect(body.chunks.some((c) => c.source === "chunkdata" && c.x === 0 && c.y === 0)).toBe(true);
    expect(body.chunks.every((c) => c.size === 0)).toBe(true);
  });

  it("reports folder counts and sizes without double-walking, and a matching totalSize", async () => {
    const response = createResponse();
    await getHandler("/stats/:saveName")(
      { params: { saveName }, query: { customPath: dataRoot } },
      response,
    );

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledTimes(1);
    const body = response.json.mock.calls[0][0];

    expect(body.folders.map).toEqual(
      expect.objectContaining({ fileCount: 6, size: 0 }),
    );
    expect(body.folders.chunkdata).toEqual(
      expect.objectContaining({ fileCount: 1, size: 0 }),
    );
    expect(body.totalSize).toBe(0);
  });
});

describe("map/ scan caching: TTL backstop + explicit invalidation on delete", () => {
  let dataRoot;
  const saveName = "PinnedTestSave";

  function postDeleteChunks(body) {
    return getHandler("/delete-chunks", "post")(
      {
        body: { force: true, createBackup: false, deleteVehicles: false, ...body },
        app: { get: () => null },
      },
      createResponse(),
    );
  }

  async function getChunks() {
    const response = createResponse();
    await getHandler("/chunks/:saveName")(
      { params: { saveName }, query: { customPath: dataRoot }, app: { get: () => null } },
      response,
    );
    return response.json.mock.calls[response.json.mock.calls.length - 1][0];
  }

  beforeEach(() => {
    getActiveServer.mockReset();
    getSetting.mockReset();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "chunks-scan-ttl-FakeZomboidData-"));
    buildFixture(dataRoot, saveName);
    getServers.mockReset().mockResolvedValue([{ id: "s1", zomboidDataPath: dataRoot }]);
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("serves a cached scan within the TTL even though a file was deleted directly on disk (simulating a writer this cache can't see, e.g. /wipe or a backup restore), then re-scans once the TTL elapses", async () => {
    const first = await getChunks();
    expect(first.totalChunks).toBe(7);

    fs.rmSync(path.join(dataRoot, "Saves", "Multiplayer", saveName, "map", "0", "0.bin"));

    const withinTtl = await getChunks();
    expect(withinTtl.totalChunks).toBe(7);

    vi.setSystemTime(3001);
    const afterTtl = await getChunks();
    expect(afterTtl.totalChunks).toBe(6);
  });

  it("delete-chunks invalidates the cache immediately -- the very next call sees the deletion, even though it lands well inside the TTL window", async () => {
    const first = await getChunks();
    expect(first.totalChunks).toBe(7);

    await postDeleteChunks({
      saveName,
      customPath: dataRoot,
      chunks: [{ file: "0/0.bin", x: 0, y: 0 }],
    });

    const afterDelete = await getChunks();
    expect(afterDelete.totalChunks).toBe(6);
  });
});
