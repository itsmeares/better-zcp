import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getServers = vi.fn(async () => [] as any[]);

vi.mock("../database/init.ts", () => ({
  getServers: (...args: unknown[]) => getServers(...args),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => undefined),
  getActiveServer: vi.fn(async () => null),
  logServerEvent: vi.fn(async () => undefined),
}));

vi.mock("../routes/chunks.ts", () => ({
  invalidateMapFolderScan: vi.fn(),
}));

const { default: router } = await import("../routes/server.ts");
const { acquireLifecycleLock } = await import(
  "../services/lifecycleCoordinator.ts"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getPostHandler(routePath: string) {
  const layer = router.stack.find(
    (entry: any) => entry.route?.path === routePath && entry.route.methods.post,
  );
  return layer.route.stack.at(-1).handle;
}

let root: string;
let steamcmdPath: string;
let installPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steam-lifecycle-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "server");
  fs.mkdirSync(steamcmdPath);
  fs.mkdirSync(installPath);
  getServers.mockResolvedValue([{ id: "server-1", installPath, name: "TestServer" }]);
});

afterEach(() => {
  const cleanup = acquireLifecycleLock("test-cleanup");
  cleanup?.release();
  fs.rmSync(root, { recursive: true, force: true });
});

const serverManager = {
  getServerProcessDetails: vi.fn(async () => ({ running: false, scanFailed: false })),
};
const app = {
  get: (key: string) =>
    key === "serverManager" ? serverManager : { emit: vi.fn() },
};

describe("SteamCMD route lifecycle guards", () => {
  it.each([
    "/install",
    "/quick-setup",
    "/steam-update",
  ])("refuses %s when the same target server is already locked", async (routePath) => {
    const body =
      routePath === "/install"
        ? { steamcmdPath, installPath, serverName: "TestServer" }
        : routePath === "/quick-setup"
          ? { installPath, serverName: "TestServer" }
          : { steamcmdPath, installPath };
    if (routePath === "/quick-setup") {
      fs.writeFileSync(path.join(installPath, "StartServer64.bat"), "");
    }
    const lock = acquireLifecycleLock("restore", "server-1");
    const response = createResponse();

    await getPostHandler(routePath)({ app, body }, response);

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "SERVER_LIFECYCLE_IN_PROGRESS" }),
    );
    lock?.release();
  });
});
