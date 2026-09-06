import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const getSettingMock = vi.fn(async () => null);
const setSettingMock = vi.fn(async () => {});

vi.mock("../database/init.js", () => ({
  logServerEvent: vi.fn(async () => {}),
  setSetting: (...args) => setSettingMock(...args),
  getSetting: (...args) => getSettingMock(...args),
  getActiveServer: vi.fn(async () => null),
}));

const { default: router } = await import("../routes/server.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getSteamUpdateHandler() {
  const layer = router.stack.find(
    (entry) =>
      entry.route?.path === "/steam-update" && entry.route.methods.post,
  );
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

let root;
let steamcmdPath;
let installPath;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-steamupdate-race-"));
  steamcmdPath = path.join(root, "steamcmd");
  installPath = path.join(root, "install");
  fs.mkdirSync(steamcmdPath, { recursive: true });
  fs.mkdirSync(installPath, { recursive: true });
  const fakeSteamcmd = path.join(steamcmdPath, "steamcmd.sh");
  fs.writeFileSync(fakeSteamcmd, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fakeSteamcmd, 0o755);

  getSettingMock.mockReset();
  setSettingMock.mockReset();
  setSettingMock.mockResolvedValue(undefined);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const isWindows = process.platform === "win32";

describe("POST /api/server/steam-update concurrency guard", () => {
  it.skipIf(isWindows)("a second update for the SAME install path, suspended inside saveAndResolveSteamCmdExe while the first claims and spawns, is refused with 409 once it resumes", async () => {
    const serverManager = {
      getServerProcessDetails: async () => ({ running: false, scanFailed: false }),
    };
    const io = { emit: vi.fn() };
    const app = {
      get: (key) => (key === "serverManager" ? serverManager : key === "io" ? io : undefined),
    };

    let getSettingCalls = 0;
    let releaseSuspended;
    getSettingMock.mockImplementation(async (key) => {
      if (key !== "steamcmdPath") return null;
      getSettingCalls += 1;
      if (getSettingCalls === 1) {
        return new Promise((resolve) => {
          releaseSuspended = () => resolve(steamcmdPath);
        });
      }
      return steamcmdPath;
    });

    const handler = getSteamUpdateHandler();
    const buildRequest = () => ({
      app,
      body: { steamcmdPath, installPath, branch: "stable" },
    });

    const responseA = createResponse();
    const responseB = createResponse();

    const callA = handler(buildRequest(), responseA);
    await Promise.resolve();
    await Promise.resolve();

    const callB = handler(buildRequest(), responseB);
    await callB;

    releaseSuspended();
    await callA;

    expect(responseB.status).not.toHaveBeenCalledWith(409);
    expect(responseA.status).toHaveBeenCalledWith(409);
    expect(responseA.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "STEAM_OPERATION_IN_PROGRESS_SERVER" }),
    );

    await new Promise((resolve) => setTimeout(resolve, 200));
  });
});
