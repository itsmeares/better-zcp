import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-27: 13 of mods.js's 18 ini-write sites gated the replace-vs-append
// decision with `content.includes("Mods=")` (and the WorkshopItems=/Map=
// equivalents) -- a plain substring search -- while the actual update used
// the anchored regex `content.replace(/^Mods=.*/m, ...)`. These are not the
// same check. `.includes()` returns true for those characters ANYWHERE in
// the file, including inside an operator-controlled free-text field like
// ServerWelcomeMessage or PublicDescription. When that happens: the code
// takes the replace branch (since .includes() was true), the anchored
// regex matches nothing (because the real "Mods=" line either doesn't
// exist, or exists somewhere the substring-match didn't establish),
// content.replace() is a silent no-op, and the write proceeds anyway --
// backup taken, route returns success, the operator's requested change
// never lands.
//
// Fixed by reusing the regex match already computed for reading (or a
// direct content.match(/^Key=.*/m) where no such variable existed) as the
// existence check instead -- the pattern 5 of the file's 18 sites already
// used correctly.
//
// These two tests are the real trigger the bug needed, not a synthetic
// stand-in: a genuine ServerWelcomeMessage containing the literal text
// "Mods=" as ordinary prose, exercised against the real POST /toggle-mod-id
// route and a real temp ini file on disk.

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

describe("POST /toggle-mod-id: the requested change lands even when a free-text field mentions \"Mods=\"", () => {
  let dataRoot;
  let iniPath;

  afterEach(() => {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  it("a real Mods= line present: the new mod ID is actually written, not silently dropped", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-includes-guard-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    // A welcome message mentioning "Mods=" as prose, alongside a genuine
    // Mods= line elsewhere in the file. Whenever a real anchored line
    // exists, the anchored regex finds it regardless of what else in the
    // file also contains that substring -- so this case worked even before
    // the fix. It's here as the regression check: proving the fix (now
    // checking the regex match instead of .includes()) doesn't disturb the
    // ordinary case where a genuine key line coexists with an unrelated
    // mention of the same text elsewhere.
    fs.writeFileSync(
      iniPath,
      'ServerWelcomeMessage=Check our Mods=folder for the full list!\nMods=OldMod\nWorkshopItems=\n',
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1] || "";
    expect(modsLine.split(";")).toEqual(
      expect.arrayContaining(["OldMod", "NewMod"]),
    );
    // The welcome message itself must survive untouched -- this fix is
    // about the Mods= write path, not about mangling unrelated fields.
    expect(content).toContain("ServerWelcomeMessage=Check our Mods=folder for the full list!");
  });

  it("NO real Mods= line, only the free-text mention: the code appends one instead of silently no-opping", async () => {
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mods-includes-guard-append-"));
    const configPath = path.join(dataRoot, "Server");
    fs.mkdirSync(configPath, { recursive: true });
    iniPath = path.join(configPath, "TestServer.ini");
    // The exact failure shape: "Mods=" appears ONLY inside free text, no
    // real line-anchored Mods= assignment exists anywhere in the file.
    // Pre-fix: content.includes("Mods=") is true (found in the welcome
    // message), so the code took the REPLACE branch instead of APPEND --
    // content.replace(/^Mods=.*/m, ...) matched nothing and returned the
    // string unchanged, so the requested mod was silently never written
    // anywhere, while the route still reported success.
    fs.writeFileSync(
      iniPath,
      "ServerWelcomeMessage=Check our Mods=folder for the full list!\nWorkshopItems=\n",
    );
    getActiveServer.mockReset().mockResolvedValue({
      id: "server-1",
      serverConfigPath: configPath,
      serverName: "TestServer",
      isRemote: false,
    });

    const res = await runRoute("/toggle-mod-id", "post", {
      body: { modId: "NewMod", enabled: true },
    });

    expect(res.getStatusCode()).toBe(200);
    const content = fs.readFileSync(iniPath, "utf-8");
    const modsLine = content.match(/^Mods=(.*)$/m)?.[1];
    expect(modsLine, "no real Mods= line was ever written -- the change was silently dropped").toBeDefined();
    expect(modsLine.split(";")).toContain("NewMod");
  });
});
