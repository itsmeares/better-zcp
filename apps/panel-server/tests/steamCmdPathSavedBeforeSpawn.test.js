import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import { EventEmitter } from "events";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
}));
vi.mock("../database/init.ts", () => ({
  getSetting: getSettingMock,
  setSetting: setSettingMock,
  logServerEvent: vi.fn(async () => {}),
  getActiveServer: vi.fn(async () => null),
}));

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

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("GET /api/server/branches: a per-request steamcmdPath is saved before it's ever spawned", () => {
  it("calls setSetting(steamcmdPath, <candidate>) and awaits it to completion before spawn() runs", async () => {
    const currentlySaved = "/old/steamcmd";
    const candidate = "/new/steamcmd";
    getSettingMock.mockImplementation(async (key) =>
      key === "steamcmdPath" ? currentlySaved : null,
    );
    let setSettingResolved = false;
    setSettingMock.mockImplementation(async () => {
      await Promise.resolve();
      setSettingResolved = true;
    });

    const existsSpy = vi
      .spyOn(fs, "existsSync")
      .mockImplementation((p) => String(p).toLowerCase().includes("steamcmd"));
    const fakeProc = new EventEmitter();
    fakeProc.stdout = new EventEmitter();
    fakeProc.stderr = new EventEmitter();
    let spawnSawSettingResolved = null;
    spawnMock.mockImplementation(() => {
      spawnSawSettingResolved = setSettingResolved;
      queueMicrotask(() => fakeProc.emit("close", 0));
      return fakeProc;
    });

    try {
      const { default: router } = await import("../routes/server.js");
      const res = createResponse();
      await getRouteHandler(router, "/branches", "get")(
        { query: { steamcmdPath: candidate }, app: { get: () => undefined } },
        res,
      );

      expect(setSettingMock).toHaveBeenCalledWith("steamcmdPath", candidate);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnSawSettingResolved).toBe(true);
      expect(spawnMock).toHaveBeenCalledWith(
        expect.stringContaining("new"),
        expect.any(Array),
        expect.any(Object),
      );
    } finally {
      existsSpy.mockRestore();
    }
  });
});
