import { describe, expect, it, vi } from "vitest";
import fs from "fs";
import { EventEmitter } from "events";

// CodeQL js/command-line-injection #10,11,12,13,297 (2026-08-27 triage,
// operator-ruled fix): every steamcmd spawn() call site resolved the
// executable from a per-request steamcmdPath/installPath value, checked
// only for absoluteness and no traversal (isValidPath) -- the directory a
// binary got spawned from was fully caller-chosen within one request, with
// no persistent record of intent. Operator's ruling: resolve from the
// SAVED steamcmdPath setting instead, via saveAndResolveSteamCmdExe()
// (server.js) -- "a gate on top of a per-request executable path still
// leaves a per-request executable path."
//
// This proves the actual ORDERING invariant the fix is about, not just
// that the right value ends up spawned (unvalidatedPathFixes.test.js
// already covers that the happy path still works): setSetting() must be
// awaited to completion BEFORE spawn() ever runs, for a per-request path
// that differs from what's currently saved. A fix that saved the setting
// AFTER spawning, or in parallel with it, would pass a same-value
// assertion just as well while missing the actual property being fixed.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawn: (...args) => spawnMock(...args) };
});

const { getSettingMock, setSettingMock } = vi.hoisted(() => ({
  getSettingMock: vi.fn(),
  setSettingMock: vi.fn(),
}));
vi.mock("../database/init.js", () => ({
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
      // A deliberate microtask delay: if the route awaited this call
      // properly, spawn() cannot run until after it resolves. If the
      // route instead fired-and-forgot the save (or saved after
      // resolving the executable), spawn() would run first and this
      // flag would still be false when it does.
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
      // The spawned executable path is derived from the candidate that was
      // just saved, not left pointing at the stale previously-saved value.
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
