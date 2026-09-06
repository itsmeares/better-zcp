import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29 hunt (god): mods-and-the-workshop, suspect 2 (mod load order) x
// suspect 1 (workshop-id validation drift). Some mods legitimately use their
// Steam Workshop file ID as their mod.info `id=` value too -- this file's own
// enable-disk-mod/resolve-orphan-workshop handlers document a real example
// ("Tear All Clothes" 3519629457) and deliberately bypass the numeric-ID
// filter for exactly that reason when writing IDs resolved fresh off disk.
//
// POST /save-order and POST /presets/:id/apply did NOT get that bypass: both
// ran the ENTIRE client-submitted mod list through sanitizeModIdList, which
// drops any 5-15 digit entry as "looks like a misplaced workshop ID". The
// client's reorder UI (Mods.tsx) seeds its drag-and-drop list from the
// server's own most recent Mods= read (iniConfig.modIds) -- i.e. exactly the
// live, already-enabled set, not free-typed text -- so any mod already
// running with a numeric mod ID would be SILENTLY dropped from Mods= the
// moment an operator reordered mods (or (re)applied a preset containing one)
// and clicked Save. No error, no warning: the mod just stops loading on the
// next restart.
//
// Confirmed via git log this premise was never true by design: the two
// correct call sites explicitly comment on why the bypass is needed. save-
// order/presets-apply simply didn't get it.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
  getModPresets: vi.fn(),
}));

const { getActiveServer, getModPresets } = await import("../database/init.js");
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

describe("mod load order preservation for numeric-shaped mod IDs", () => {
  let dataRoot;
  let iniPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-save-order-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    fs.writeFileSync(
      iniPath,
      "Mods=AlphaMod;3519629457;BetaMod\nWorkshopItems=1111111111;3519629457\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });
    getModPresets.mockReset();
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /save-order preserves a numeric mod ID through a reorder instead of silently dropping it", async () => {
    // Simulate the client's actual reorder flow: it seeds orderedModIds from
    // the server's live Mods= read, then reorders and saves back the same
    // set (BetaMod moved first) -- no new IDs invented, nothing removed.
    const res = await runRoute("/save-order", "post", {
      body: { modIds: ["BetaMod", "3519629457", "AlphaMod"] },
    });

    expect(res.getStatusCode()).toBe(200);

    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1] || "";
    const ids = modsLine.split(";").filter(Boolean);

    // The predicted pre-fix symptom: "3519629457" silently vanishes even
    // though the operator never asked to remove it.
    expect(ids).toEqual(["BetaMod", "3519629457", "AlphaMod"]);
  });

  it("POST /presets/:id/apply preserves a numeric mod ID from the preset instead of silently dropping it", async () => {
    getModPresets.mockResolvedValue([
      {
        id: "preset-1",
        name: "Test Preset",
        workshop_ids: ["1111111111", "3519629457"],
        mods: ["AlphaMod", "3519629457"],
      },
    ]);

    const res = await runRoute("/presets/:id/apply", "post", {
      params: { id: "preset-1" },
      body: {},
    });

    expect(res.getStatusCode()).toBe(200);

    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1] || "";
    const ids = modsLine.split(";").filter(Boolean);

    expect(ids).toEqual(["AlphaMod", "3519629457"]);
  });
});
