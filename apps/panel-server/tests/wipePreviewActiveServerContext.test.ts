import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("../database/init.ts", () => ({
  logServerEvent: vi.fn(),
  setSetting: vi.fn(),
  getSetting: vi.fn(),
  getActiveServer: vi.fn(),
}));

const { default: router } = await import("../routes/server.ts");
const { getActiveServer } = await import("../database/init.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getPreviewHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/wipe/preview" && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

let dataPath;

beforeEach(() => {
  dataPath = fs.mkdtempSync(path.join(os.tmpdir(), "pz-wipe-preview-"));
  fs.mkdirSync(path.join(dataPath, "Saves", "Multiplayer", "fresh-server", "map"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataPath, "Saves", "Multiplayer", "fresh-server", "map", "0_0.bin"),
    "chunk",
  );
  getActiveServer.mockResolvedValue({
    serverName: "fresh-server",
    zomboidDataPath: dataPath,
  });
});

afterEach(() => {
  fs.rmSync(dataPath, { recursive: true, force: true });
});

describe("POST /api/server/wipe/preview active server snapshot", () => {
  it("uses the database snapshot instead of stale server-manager fields", async () => {
    const reloadConfig = vi.fn(async () => {});
    const response = createResponse();

    await getPreviewHandler()(
      {
        app: {
          get: () => ({
            reloadConfig,
            serverName: "stale-server",
            savePath: path.join(dataPath, "stale-data"),
          }),
        },
        body: { targets: ["map"] },
      },
      response,
    );

    expect(reloadConfig).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "fresh-server",
        saveDir: path.join(dataPath, "Saves", "Multiplayer", "fresh-server"),
        totalFiles: 1,
      }),
    );
  });

  it("fails closed when the active server configuration cannot be reloaded", async () => {
    const response = createResponse();

    await getPreviewHandler()(
      {
        app: { get: () => ({ reloadConfig: vi.fn(async () => { throw new Error("stale"); }) }) },
        body: { targets: ["map"] },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_STATE_UNKNOWN" }),
    );
  });
});
