import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { invalidateMapFolderScanMock } = vi.hoisted(() => ({
  invalidateMapFolderScanMock: vi.fn(),
}));
vi.mock("../routes/chunks.js", () => ({
  invalidateMapFolderScan: invalidateMapFolderScanMock,
}));

const { default: router } = await import("../routes/server.js");

const SERVER_NAME = "servertest";

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getWipeHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let savePath;
let saveDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-"));
  savePath = root;
  saveDir = path.join(savePath, "Saves", "Multiplayer", SERVER_NAME);
  fs.mkdirSync(path.join(saveDir, "map"), { recursive: true });
  fs.writeFileSync(path.join(saveDir, "map", "0_0.bin"), "chunk");
  invalidateMapFolderScanMock.mockClear();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/server/wipe invalidates chunks.js's cached map/ folder scan", () => {
  it("invalidates the map/ scan cache after wiping the map target", async () => {
    const serverManager = {
      loadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
      savePath,
      serverName: SERVER_NAME,
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        body: { targets: ["map"], confirm: true, createBackup: false },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(invalidateMapFolderScanMock).toHaveBeenCalledWith(
      path.join(saveDir, "map"),
    );
  });

  it("does not invalidate the map/ scan cache when only non-map targets are wiped", async () => {
    const serverManager = {
      loadConfig: async () => {},
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
      savePath,
      serverName: SERVER_NAME,
    };

    const handler = getWipeHandler();
    const response = createResponse();
    await handler(
      {
        app: { get: () => serverManager },
        body: { targets: ["players"], confirm: true, createBackup: false },
      },
      response,
    );

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
    expect(invalidateMapFolderScanMock).not.toHaveBeenCalled();
  });
});
