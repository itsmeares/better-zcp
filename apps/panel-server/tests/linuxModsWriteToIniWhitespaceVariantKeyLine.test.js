import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";

// 2026-08-29 hunt-wave13 follow-up (god's lead, verified real): POST
// /write-to-ini decided whether Mods=/WorkshopItems=/Map= already exist via
// a bare /^Mods=.*/m (etc.) match with NO whitespace tolerance, then used
// the SAME pattern to replace in place. A hand-edited file with "Mods = foo"
// (spaces around "=" -- exactly the formatting serverFiles.js's toIni() now
// correctly preserves, 573f63fd/edda9ca6) fails that match, so this route
// fell into its "doesn't exist yet" branch and APPENDED a second "Mods="
// line instead of replacing the first. findDuplicateIniKeys() (already
// whitespace-tolerant, matching parseIni()'s own tolerance) then correctly
// flags the resulting file as having a duplicated key, which 409-blocks
// every future PUT /ini structured save until the raw editor manually
// fixes it -- a real, reachable lockout, not hypothetical.
//
// Before edda9ca6, a structured PUT /ini would have silently "repaired"
// "Mods = foo" to "Mods=foo" the moment ANY field was saved, accidentally
// keeping this route's strict match working. edda9ca6 correctly stops that
// unrelated rewrite, which removes the accidental repair and widens the
// window this bug is reachable in -- pre-existing, not introduced, but
// worth closing in the same session per god's instruction.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getTrackedMods: vi.fn(async () => []),
  addTrackedMod: vi.fn(),
  removeTrackedMod: vi.fn(),
  clearModUpdates: vi.fn(),
  getModPresets: vi.fn(async () => []),
  createModPreset: vi.fn(),
  updateModPreset: vi.fn(),
  deleteModPreset: vi.fn(),
  addIgnoredMod: vi.fn(),
  getIgnoredMods: vi.fn(async () => []),
  removeIgnoredMod: vi.fn(),
  clearAllIgnoredMods: vi.fn(),
  isModIgnored: vi.fn(async () => false),
  getIgnoredModPairs: vi.fn(async () => []),
  addIgnoredModPair: vi.fn(),
  removeIgnoredModPair: vi.fn(),
}));

const { getActiveServer } = await import("../database/init.js");
const { default: router } = await import("../routes/mods.js");

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

describe("POST /write-to-ini: existing key line with whitespace around '='", () => {
  let dataRoot;
  let iniPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-write-to-ini-ws-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    // Spaces around "=" -- exactly what a hand-edited file, or a file
    // saved once through the structured PUT /ini editor post-edda9ca6, can
    // legitimately carry.
    fs.writeFileSync(iniPath, "Mods = OldMod\nWorkshopItems = 1111111111\n");
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("replaces the existing Mods=/WorkshopItems= line in place instead of appending a duplicate", async () => {
    const res = await runRoute("/write-to-ini", "post", {
      body: {
        mods: [{ workshopId: "2222222222", modId: "NewMod" }],
      },
    });

    expect(res.getStatusCode()).toBe(200);

    const after = fs.readFileSync(iniPath, "utf-8");

    // Exactly one Mods= line and one WorkshopItems= line -- not two.
    const modsLines = after.split(/\r?\n/).filter((l) => /^\s*Mods\s*=/.test(l));
    const workshopLines = after
      .split(/\r?\n/)
      .filter((l) => /^\s*WorkshopItems\s*=/.test(l));
    expect(modsLines).toHaveLength(1);
    expect(workshopLines).toHaveLength(1);
    expect(modsLines[0]).toBe("Mods=NewMod");
    expect(workshopLines[0]).toBe("WorkshopItems=2222222222");

    // The property that actually matters: no duplicate key, so the
    // structured editor's PUT /ini never 409-locks the operator out over
    // this write.
    expect(findDuplicateIniKeys(after)).toEqual([]);
  });
});
