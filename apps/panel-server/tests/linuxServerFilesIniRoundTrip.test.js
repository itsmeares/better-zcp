import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";


const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer,
  getAllSettings: vi.fn(async () => ({})),
  getRoleByName: mockGetRoleByName,
}));

const { default: router } = await import("../routes/serverFiles.ts");

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

const SERVER_NAME = "RoundTripTest";
let configDir;
let iniPath;

const FIXTURE = [
  "# ZomboidINI",
  "version=1",
  "",
  "PVP=true",
  "PublicName=My Test Server",
  "PublicDescription=",
  "MaxPlayers=32",
  "DefaultPort=16261",
  "; comment about UDP",
  "UDPPort=16262",
  "SomeFutureEngineKeyThisPanelHasNoUiFor=42",
  "",
].join("\n");

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ini-roundtrip-"));
  iniPath = path.join(configDir, `${SERVER_NAME}.ini`);
  fs.writeFileSync(iniPath, FIXTURE);
  getActiveServer.mockReset().mockResolvedValue({
    serverConfigPath: configDir,
    serverName: SERVER_NAME,
  });
});

afterEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe("GET /ini -> PUT /ini round trip with no changes", () => {
  it("preserves every key's value, including one the panel's schema has no UI for", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    expect(getRes.getStatusCode()).toBe(200);
    const { settings } = getRes.getBody();

    const putRes = await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings },
    });
    expect(putRes.getStatusCode()).toBe(200);

    const after = fs.readFileSync(iniPath, "utf-8");
    const afterLines = after.split(/\r?\n/).filter(Boolean);

    expect(afterLines).toEqual(
      expect.arrayContaining([
        "PVP=true",
        "PublicName=My Test Server",
        "MaxPlayers=32",
        "DefaultPort=16261",
        "UDPPort=16262",
        "SomeFutureEngineKeyThisPanelHasNoUiFor=42",
      ]),
    );

    expect(after).toContain("# ZomboidINI");
    expect(after).toContain("; comment about UDP");
  });

  it("changing one field does not disturb any other line's value", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    const putRes = await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });
    expect(putRes.getStatusCode()).toBe(200);

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PublicName=Renamed Server");
    expect(after).toContain("PVP=true");
    expect(after).toContain("MaxPlayers=32");
    expect(after).toContain("SomeFutureEngineKeyThisPanelHasNoUiFor=42");
  });

  it("is byte-for-byte identical to the original, not just line-for-line equivalent, when nothing changed", async () => {
    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(FIXTURE);
  });
});

describe("GET /ini -> PUT /ini round trip: line endings and encoding (case 3)", () => {
  it("preserves CRLF line endings through an unchanged save instead of silently converting to LF", async () => {
    const crlfFixture = FIXTURE.replace(/\n/g, "\r\n");
    fs.writeFileSync(iniPath, crlfFixture);

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(crlfFixture);
  });

  it("preserves CRLF line endings when one field actually changes", async () => {
    const crlfFixture = FIXTURE.replace(/\n/g, "\r\n");
    fs.writeFileSync(iniPath, crlfFixture);

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PublicName=Renamed Server\r\n");
    expect(after).not.toMatch(/[^\r]\n/);
  });

  it("non-ASCII values survive an unchanged save byte-for-byte (already correct, pinned as a regression check)", async () => {
    const unicodeFixture = FIXTURE.replace(
      "PublicName=My Test Server",
      "PublicName=Café Zómboid 日本サーバー",
    );
    fs.writeFileSync(iniPath, unicodeFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(unicodeFixture);
  });

  it("a value containing the '=' separator character round-trips unchanged (already correct, pinned as a regression check)", async () => {
    const eqFixture = FIXTURE.replace(
      "PublicName=My Test Server",
      "PublicName=My=Test=Server",
    );
    fs.writeFileSync(iniPath, eqFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    expect(settings.PublicName).toBe("My=Test=Server");
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(eqFixture);
  });

  it("a missing trailing newline at EOF is not silently added", async () => {
    const noTrailingNewline = FIXTURE.replace(/\n$/, "");
    fs.writeFileSync(iniPath, noTrailingNewline, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(noTrailingNewline);
  });
});

describe("GET /ini -> PUT /ini round trip: per-line formatting the panel never asked to change (case 7)", () => {
  const spacedFixture = [
    "# ZomboidINI",
    "version=1",
    "",
    "PVP = true",
    "  MaxPlayers=32",
    "DefaultPort =16261",
    "",
  ].join("\n");

  it("preserves spacing around '=' and leading indentation on an unrelated field change", async () => {
    fs.writeFileSync(iniPath, spacedFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    await runRoute("/ini", "put", {
      user: { role: "admin" },
      body: { settings: { ...settings, PublicName: "Renamed Server" } },
    });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toContain("PVP = true");
    expect(after).toContain("  MaxPlayers=32");
    expect(after).toContain("DefaultPort =16261");
  });

  it("preserves spacing around '=' on an unchanged save", async () => {
    fs.writeFileSync(iniPath, spacedFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();
    await runRoute("/ini", "put", { user: { role: "admin" }, body: { settings } });

    const after = fs.readFileSync(iniPath, "utf-8");
    expect(after).toBe(spacedFixture);
  });
});

describe("GET /ini -> PUT /ini round trip: byte-order mark (case 8)", () => {
  const BOM = "﻿";

  it("does not mangle the first key's name with a leading BOM", async () => {
    const bomFixture = BOM + "version=1\nPVP=true\n";
    fs.writeFileSync(iniPath, bomFixture, "utf-8");

    const getRes = await runRoute("/ini", "get", { user: { role: "admin" } });
    const { settings } = getRes.getBody();

    expect(settings.version).toBe("1");
    expect(Object.keys(settings).some((k) => k.includes("﻿"))).toBe(false);
  });
});
