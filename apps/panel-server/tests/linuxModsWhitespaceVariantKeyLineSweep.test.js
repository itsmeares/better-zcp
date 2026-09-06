import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findDuplicateIniKeys } from "../utils/iniDuplicateKeys.js";

// 2026-08-29/30 hunt-wave13 sweep (god's follow-up to 3d1921ad): the same
// asymmetry fixed in POST /write-to-ini recurs across the file at every
// site that decides whether Mods=/WorkshopItems=/Map= already exist via a
// bare, whitespace-intolerant regex. Verified per-site (not blind-applied)
// which sites are genuinely reachable -- every site examined reads content
// fresh via readTextFile() inside its own withIniLock() callback, so a
// whitespace-variant line written by a hand-edit (or, pre-edda9ca6, left
// behind by the structured editor) is always reachable there.
//
// Two DISTINCT failure shapes exist depending on whether the guarded branch
// has an else/append:
//   - DUPLICATE-KEY shape (toggle-mod-id, batch-toggle-mod-ids, add, etc.):
//     the exists-check fails, the code appends a SECOND key line, and
//     findDuplicateIniKeys() then 409-locks every future structured PUT
//     /ini save.
//   - SILENT-NO-OP shape (remove-from-ini, batch-remove, repair-map-entries,
//     etc. -- no else/append branch at all): the exists-check fails, the
//     update is skipped entirely, and the route reports success while the
//     live file is completely unchanged.
//
// This file covers one representative case of each shape; the full per-site
// census (34 sites confirmed needed, 1 confirmed not needed with reasoning)
// is in the hunt-wave13 report, not duplicated here as 34 near-identical
// tests -- these two prove the fix mechanism works for both shapes.

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

let dataRoot;
let iniPath;

beforeEach(() => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-ws-variant-sweep-"));
  const configPath = path.join(dataRoot, "Server");
  fs.mkdirSync(configPath, { recursive: true });
  iniPath = path.join(configPath, "TestServer.ini");
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

describe("POST /toggle-mod-id: whitespace-variant Mods= line (duplicate-key shape)", () => {
  it("replaces the existing line in place instead of appending a duplicate", async () => {
    fs.writeFileSync(iniPath, "Mods = ExistingMod\nWorkshopItems=\n");

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const after = fs.readFileSync(iniPath, "utf-8");
    const modsLines = after.split(/\r?\n/).filter((l) => /^\s*Mods\s*=/.test(l));
    expect(modsLines).toHaveLength(1);
    // Both the pre-existing (whitespace-variant) and the newly-toggled mod
    // must survive -- proves the read side was fixed too, not just the
    // write: pre-fix, the misparsed-as-empty current list would have lost
    // ExistingMod entirely even before the duplicate-key problem.
    expect(modsLines[0]).toContain("ExistingMod");
    expect(modsLines[0]).toContain("NewMod");
    expect(findDuplicateIniKeys(after)).toEqual([]);
  });
});

describe("POST /remove-from-ini: whitespace-variant WorkshopItems= line (silent-no-op shape)", () => {
  it("actually removes the workshop ID instead of silently leaving the line untouched", async () => {
    fs.writeFileSync(
      iniPath,
      "WorkshopItems = 1111111111;2222222222\nMods=\n",
    );

    const res = await runRoute("/remove-from-ini", "post", {
      body: { workshopId: "1111111111" },
    });

    expect(res.getStatusCode()).toBe(200);
    const body = res.getBody();
    // Pre-fix, this misreported remainingWorkshopItems as 0 (the line was
    // misparsed as empty from the start) instead of 1.
    expect(body.remainingWorkshopItems).toBe(1);

    const after = fs.readFileSync(iniPath, "utf-8");
    const wsLines = after
      .split(/\r?\n/)
      .filter((l) => /^\s*WorkshopItems\s*=/.test(l));
    expect(wsLines).toHaveLength(1);
    expect(wsLines[0]).toBe("WorkshopItems=2222222222");
  });
});

// 2026-08-30 hunt-wave13, second pass: the remaining 26 sites reported to
// god (line numbers + shape) after the first 8. These three cover the
// still-untested shapes: /batch-remove (3-key silent-no-op), /add-missing-dep
// (duplicate-key shape via a differently-structured route than /add), and
// /enable-disk-mod (the ternary content = x ? replace : append form, not
// if/else).

describe("POST /batch-remove: whitespace-variant lines across all three keys (silent-no-op shape)", () => {
  it("actually removes the workshop ID from a spaced WorkshopItems= line", async () => {
    fs.writeFileSync(
      iniPath,
      "WorkshopItems = 1111111111;2222222222\nMods=\n",
    );

    const res = await runRoute("/batch-remove", "post", {
      body: { workshopIds: ["1111111111"] },
    });

    expect(res.getStatusCode()).toBe(200);
    const after = fs.readFileSync(iniPath, "utf-8");
    const wsLines = after
      .split(/\r?\n/)
      .filter((l) => /^\s*WorkshopItems\s*=/.test(l));
    expect(wsLines).toHaveLength(1);
    expect(wsLines[0]).toBe("WorkshopItems=2222222222");
  });
});

describe("POST /add-missing-dep: whitespace-variant Mods= line (duplicate-key shape)", () => {
  it("replaces the existing line in place instead of appending a duplicate", async () => {
    fs.writeFileSync(
      iniPath,
      "WorkshopItems=\nMods = ExistingMod\n",
    );

    const res = await runRoute("/add-missing-dep", "post", {
      body: { workshopId: "3333333333", modId: "NewDepMod" },
    });

    expect(res.getStatusCode()).toBe(200);
    const after = fs.readFileSync(iniPath, "utf-8");
    const modsLines = after.split(/\r?\n/).filter((l) => /^\s*Mods\s*=/.test(l));
    expect(modsLines).toHaveLength(1);
    expect(modsLines[0]).toContain("ExistingMod");
    expect(modsLines[0]).toContain("NewDepMod");
    expect(findDuplicateIniKeys(after)).toEqual([]);
  });
});

describe("POST /enable-disk-mod: whitespace-variant Mods= line, ternary replace-or-append form", () => {
  it("replaces the existing line in place instead of appending a duplicate", async () => {
    fs.writeFileSync(
      iniPath,
      "WorkshopItems=\nMods = ExistingMod\n",
    );

    const res = await runRoute("/enable-disk-mod", "post", {
      body: { workshopId: "4444444444" },
    });

    expect(res.getStatusCode()).toBe(200);
    const after = fs.readFileSync(iniPath, "utf-8");
    const modsLines = after.split(/\r?\n/).filter((l) => /^\s*Mods\s*=/.test(l));
    expect(modsLines).toHaveLength(1);
    expect(modsLines[0]).toContain("ExistingMod");
    expect(findDuplicateIniKeys(after)).toEqual([]);
  });
});
