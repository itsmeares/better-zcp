import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// POST /auto-scan and POST /detect used to put the RCON password read off a
// discovered server's own ini straight into the JSON response, in plaintext
// -- the client copied it into a form and back into POST / when creating
// the server. This file proves: (1) neither discovery route puts the
// password on the wire any more (hasRcon survives, rconPassword doesn't),
// and (2) POST / can still create a working server from a detected config,
// by re-reading the password itself from the exact ini the scan already
// found (config.importIniFrom), gated by the SAME capability
// (servers.discover) that already gates reading arbitrary local ini files
// on the two discovery routes -- not just by servers.manage, which alone
// would let a caller who could never see the scan results make the server
// read an arbitrary ini path anyway.

const createServer = vi.fn();
const getServers = vi.fn();
const getAllSettings = vi.fn();
const testRconConnection = vi.fn();

import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";

vi.mock("../database/init.js", () => ({
  getServers,
  getSetting: vi.fn(),
  getAllSettings,
  getServer: vi.fn(),
  getActiveServer: vi.fn(),
  createServer,
  updateServer: vi.fn(),
  deleteServer: vi.fn(),
  setActiveServer: vi.fn(),
  getRoleByName: mockGetRoleByName,
}));

vi.mock("../services/rcon.js", () => ({
  normalizeRconHost: (host) => host.trim(),
  testRconConnection,
}));

const { default: router } = await import("../routes/servers.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

// Runs the FULL middleware stack for the route (not just the final
// handler), so the router-level requirePermission("servers.manage") gate on
// POST / is actually exercised alongside the inline servers.discover check
// inside the handler -- the whole point of the "requires both" test below.
async function runRoute(routePath, method, req, res) {
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
}

function writeIni(dataPath, serverName, contents) {
  const serverDir = path.join(dataPath, "Server");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(serverDir, `${serverName}.ini`), contents);
}

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-servers-iniimport-"));
  createServer.mockReset();
  createServer.mockResolvedValue({ id: "server-id", name: "Test Server" });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /auto-scan and POST /detect no longer return rconPassword", () => {
  it("auto-scan: hasRcon survives, rconPassword and the raw value do not", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=super-secret\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/auto-scan",
      "post",
      { body: { scanPath: tmpRoot }, user: { role: "admin" } },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.detectedConfigs).toHaveLength(1);
    expect(payload.detectedConfigs[0]).not.toHaveProperty("rconPassword");
    expect(payload.detectedConfigs[0].hasRcon).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });

  it("detect: hasRcon survives, rconPassword and the raw value do not", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=super-secret\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/detect",
      "post",
      { body: { dataPath: tmpRoot }, user: { role: "admin" } },
      response,
    );

    const payload = response.json.mock.calls[0][0];
    expect(payload.detectedServers).toHaveLength(1);
    expect(payload.detectedServers[0]).not.toHaveProperty("rconPassword");
    expect(payload.detectedServers[0].hasRcon).toBe(true);
    expect(JSON.stringify(payload)).not.toContain("super-secret");
  });
});

describe("POST / config.importIniFrom", () => {
  function importBody(overrides = {}) {
    return {
      name: "Imported",
      installPath: "C:\\PZ",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      importIniFrom: { dataPath: tmpRoot, serverName: "servertest" },
      ...overrides,
    };
  }

  it("re-reads the password server-side and uses it to create the server", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=import-me\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: importBody(), user: { role: "admin" } },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconPassword: "import-me" }),
    );
    expect(response.status).toHaveBeenCalledWith(201);
  });

  // 2026-09-03: importIniFrom read and applied rconPassword from the ini
  // but never wrote importIniFrom.dataPath back to zomboidDataPath -- the
  // created server saved successfully (rconPassword worked fine) but could
  // not start, since serverManager needs zomboidDataPath to resolve the
  // cachedir. Found via a real enrolment through this exact route. The sibling
  // route this handler's own comment says it mirrors -- POST
  // /create-from-discovery in discovery.js -- sets
  // `zomboidDataPath: discovered.dataPath` from the equivalent field, which is
  // the contract this pins.
  it("populates zomboidDataPath from importIniFrom.dataPath, not just rconPassword", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=import-me\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: importBody(), user: { role: "admin" } },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ zomboidDataPath: tmpRoot }),
    );
  });

  it("the imported zomboidDataPath overrides a client-supplied one, same precedence as rconPassword", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=import-me\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      {
        body: importBody({ zomboidDataPath: "C:\\some\\other\\path" }),
        user: { role: "admin" },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ zomboidDataPath: tmpRoot }),
    );
  });

  it("the re-read value overrides a client-supplied rconPassword", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=real-one\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      {
        body: importBody({ rconPassword: "attacker-supplied" }),
        user: { role: "admin" },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconPassword: "real-one" }),
    );
  });

  it("requires servers.discover in addition to the route's servers.manage gate", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=import-me\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    // Fixture technician role has servers.manage (passes the router-level
    // gate) but not servers.discover (must be refused by the inline check).
    await runRoute(
      "/",
      "post",
      { body: importBody(), user: { role: "technician" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a non-absolute importIniFrom.dataPath", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      {
        body: importBody({
          importIniFrom: { dataPath: "relative/path", serverName: "servertest" },
        }),
        user: { role: "admin" },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a traversing importIniFrom.serverName", async () => {
    writeIni(
      tmpRoot,
      "servertest",
      "RCONPassword=import-me\nRCONPort=27015\nDefaultPort=16261\n",
    );
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      {
        body: importBody({
          importIniFrom: { dataPath: tmpRoot, serverName: "../../secrets" },
        }),
        user: { role: "admin" },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("rejects a dataPath with no Server subfolder", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: importBody(), user: { role: "admin" } }, // tmpRoot has no Server/ yet
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(createServer).not.toHaveBeenCalled();
  });

  it("reports clearly when the ini has no RCON password set, instead of silently creating a passwordless server", async () => {
    writeIni(tmpRoot, "servertest", "RCONPort=27015\nDefaultPort=16261\n");
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      { body: importBody(), user: { role: "admin" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringMatching(/RCON password not set/i),
      }),
    );
    expect(createServer).not.toHaveBeenCalled();
  });

  it("manual entry (no importIniFrom) is unaffected", async () => {
    const response = createResponse();

    await runRoute(
      "/",
      "post",
      {
        body: {
          name: "Manual",
          installPath: "C:\\PZ",
          rconHost: "127.0.0.1",
          rconPort: 27015,
          rconPassword: "typed-by-hand",
        },
        user: { role: "admin" },
      },
      response,
    );

    expect(createServer).toHaveBeenCalledWith(
      expect.objectContaining({ rconPassword: "typed-by-hand" }),
    );
    expect(response.status).toHaveBeenCalledWith(201);
  });
});
