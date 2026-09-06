import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-29 hunt follow-up (god): the mods/workshop hunt's suspect 1
// (workshop-id validation drift). /toggle-mod-id and /batch-toggle-mod-ids
// treated any 5-15 digit modId as an unverifiable "that's a Workshop ID, not
// a mod ID" 400 -- but enable-disk-mod/resolve-orphan-workshop already
// established the correct precedent for this exact ambiguity: disk
// verification (reading the real mod.info off the installed workshop
// folder) is strictly MORE evidence than the regex that flagged it
// ambiguous, so a disk-confirmed numeric mod ID should be allowed, not
// rejected. Teaching toggle/batch-toggle that same bypass, per god's
// explicit "this is not a UX tradeoff, converging on a sibling's proven
// pattern is the absence of one" instruction.
//
// A second, worse bug hid behind the first: toggle/batch-toggle rebuild
// Mods= via `sanitizeModIdList(currentModIds)` on the FULL current list on
// every write, not just the entry being toggled -- so toggling ANY
// unrelated mod on/off silently stripped a *pre-existing*, already-disk-
// verified numeric-ID mod elsewhere in the same Mods= line as collateral
// damage. Both bugs share one fix: sanitize the full list through the same
// disk-verification bypass, not just gate the one entry being added.

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(),
  getSetting: vi.fn(async () => null),
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

const REAL_MOD_ID = "3519629457"; // "Tear All Clothes" -- a real all-numeric mod.info id=
const WS_ID = "9999999999";

describe("toggle/batch-toggle: disk-verified numeric mod IDs", () => {
  let dataRoot;
  let iniPath;
  let installPath;

  beforeEach(() => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-toggle-numeric-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");

    installPath = path.join(dataRoot, "install");
    const modFolder = path.join(
      installPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      WS_ID,
      "mods",
      "TearAllClothes",
    );
    fs.mkdirSync(modFolder, { recursive: true });
    fs.writeFileSync(
      path.join(modFolder, "mod.info"),
      `name=Tear All Clothes\nid=${REAL_MOD_ID}\n`,
    );

    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      installPath,
      isRemote: false,
    });
  });

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("POST /toggle-mod-id allows enabling a numeric mod ID once it's disk-verified", async () => {
    fs.writeFileSync(iniPath, `Mods=\nWorkshopItems=${WS_ID}\n`);

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: REAL_MOD_ID, enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const ids = (content.match(/^Mods=(.*)$/m)?.[1] || "").split(";").filter(Boolean);
    expect(ids).toContain(REAL_MOD_ID);
  });

  it("POST /toggle-mod-id still rejects a numeric modId that cannot be disk-verified", async () => {
    fs.writeFileSync(iniPath, `Mods=\nWorkshopItems=${WS_ID}\n`);

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "1234567890", enabled: true },
    });

    expect(res.getStatusCode()).toBe(400);
    const content = fs.readFileSync(iniPath, "utf-8");
    const ids = (content.match(/^Mods=(.*)$/m)?.[1] || "").split(";").filter(Boolean);
    expect(ids).not.toContain("1234567890");
  });

  it("POST /toggle-mod-id does not collaterally delete a pre-existing disk-verified numeric mod when toggling an unrelated mod", async () => {
    fs.writeFileSync(
      iniPath,
      `Mods=AlphaMod;${REAL_MOD_ID}\nWorkshopItems=${WS_ID}\n`,
    );

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "BetaMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const ids = (content.match(/^Mods=(.*)$/m)?.[1] || "").split(";").filter(Boolean);
    // The predicted pre-fix symptom: REAL_MOD_ID silently vanishes even
    // though only BetaMod was toggled.
    expect(ids).toEqual(["AlphaMod", REAL_MOD_ID, "BetaMod"]);
  });

  it("POST /batch-toggle-mod-ids allows enabling a numeric mod ID once it's disk-verified", async () => {
    fs.writeFileSync(iniPath, `Mods=\nWorkshopItems=${WS_ID}\n`);

    const res = await runRoute("/batch-toggle-mod-ids", "post", {
      body: { changes: [{ modId: REAL_MOD_ID, enabled: true }] },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const ids = (content.match(/^Mods=(.*)$/m)?.[1] || "").split(";").filter(Boolean);
    expect(ids).toContain(REAL_MOD_ID);
  });

  it("POST /batch-toggle-mod-ids does not collaterally delete a pre-existing disk-verified numeric mod when toggling an unrelated mod", async () => {
    fs.writeFileSync(
      iniPath,
      `Mods=AlphaMod;${REAL_MOD_ID}\nWorkshopItems=${WS_ID}\n`,
    );

    const res = await runRoute("/batch-toggle-mod-ids", "post", {
      body: { changes: [{ modId: "BetaMod", enabled: true }] },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const ids = (content.match(/^Mods=(.*)$/m)?.[1] || "").split(";").filter(Boolean);
    expect(ids).toEqual(["AlphaMod", REAL_MOD_ID, "BetaMod"]);
  });
});
