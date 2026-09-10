import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "linux",
  configurable: true,
});

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, exec: (...args: any[]) => execMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(async () => null),
  setSettingMock: vi.fn(async () => {}),
}));
vi.mock("../database/init.ts", () => ({
  getSetting: (...args: any[]) => getSettingMock(...args),
  setSetting: (...args: any[]) => setSettingMock(...args),
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
}));

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getDownloadHandler(router: any) {
  const layer = router.stack.find(
    (entry: any) =>
      entry.route?.path === "/steamcmd/download" && entry.route.methods.post,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

async function freshRouter() {
  vi.resetModules();
  const { default: router } = await import("../routes/server.ts");
  return router;
}

describe("POST /api/server/steamcmd/download concurrency guard", () => {
  it("refuses an overlapping download before starting a second shell command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steamcmd-race-"));
    const installPath = path.join(root, "steamcmd");
    const io = { emit: vi.fn() };
    const app = { get: (key: string) => (key === "io" ? io : undefined) };

    try {
      execMock.mockImplementation(() => {});
      const handler = getDownloadHandler(await freshRouter());
      const request = () => ({ app, body: { installPath } });
      const responseA = createResponse();
      const responseB = createResponse();

      await Promise.all([
        handler(request(), responseA),
        handler(request(), responseB),
      ]);

      expect(responseA.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
      expect(responseB.status).toHaveBeenCalledWith(409);
      expect(responseB.json).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "STEAMCMD_DOWNLOAD_ALREADY_IN_PROGRESS",
        }),
      );
      expect(execMock).toHaveBeenCalledOnce();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("releases the guard after curl and wget both fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-steamcmd-race-"));
    const installPath = path.join(root, "steamcmd");
    const io = { emit: vi.fn() };
    const app = { get: (key: string) => (key === "io" ? io : undefined) };
    const callbacks: Array<(error: Error) => void> = [];

    try {
      execMock.mockImplementation((_command: string, _options: unknown, callback: (error: Error) => void) => {
        callbacks.push(callback);
      });
      const handler = getDownloadHandler(await freshRouter());
      const request = () => ({ app, body: { installPath } });
      const responseA = createResponse();

      await handler(request(), responseA);
      callbacks[0](new Error("curl unavailable"));
      callbacks[1](new Error("wget unavailable"));

      const responseB = createResponse();
      await handler(request(), responseB);

      expect(responseB.status).not.toHaveBeenCalledWith(409);
      expect(responseB.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
