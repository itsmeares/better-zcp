import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cross-producer shape gate (2026-08-27 api.ts type-architecture survey,
// build order item 3): compares what MULTIPLE real routes actually return
// for "the same conceptual shape" against EACH OTHER, not against a
// hand-written client interface. This catches what a declared-type
// comparison structurally cannot: the survey's Finding 2
// (remoteConfigConfigured present on some Server-returning routes, absent
// on others) was invisible to tsc precisely because the field is correctly
// optional -- optional-and-genuinely-absent and optional-and-never-set are
// the same thing to a type checker. They are not the same thing to two
// routes compared against each other, and the optionality that made it
// invisible to tsc is irrelevant to this kind of check.
//
// Declares its own denominator, per instruction: reliably discovering
// "every route that returns shape X" by static reading alone is not
// something this file claims to do completely. The routes below were found
// by hand -- grepping apps/panel-server/routes/servers.js and apps/panel-server/routes/backup.js
// for `res.json({ server` / `res.json({ servers` / `res.json({ backups` /
// `backup:` on 2026-08-27 -- not an automated, self-maintaining discovery.
// A hand list is acceptable; a hand list that doesn't announce itself as
// one is not, so this comment is that announcement.

const getServers = vi.fn();
const getActiveServer = vi.fn();
const getServer = vi.fn();
const createServer = vi.fn();
const updateServer = vi.fn();
const deleteServer = vi.fn();
const setActiveServer = vi.fn();
const getAllSettings = vi.fn();
const setSetting = vi.fn();
const testRconConnection = vi.fn();

vi.mock("../database/init.js", () => ({
  getServers,
  getActiveServer,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  setActiveServer,
  getAllSettings,
  setSetting,
  getRoleByName: vi.fn(async () => null),
}));

vi.mock("../services/rcon.js", () => ({
  normalizeRconHost: (host) => host.trim(),
  testRconConnection,
}));

const { default: serversRouter } = await import("../routes/servers.js");
const { default: backupRouter } = await import("../routes/backup.js");

function getHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) {
    throw new Error(`No route registered for ${method.toUpperCase()} ${routePath}`);
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

async function invokeJson(router, routePath, method, req) {
  const response = createResponse();
  await getHandler(router, routePath, method)(req, response);
  if (response.json.mock.calls.length === 0) {
    throw new Error(
      `${method.toUpperCase()} ${routePath} never called res.json (status: ${response.status.mock.calls[0]?.[0] ?? "none"})`,
    );
  }
  return response.json.mock.calls[0][0];
}

function fakeApp(extra = {}) {
  return { get: (key) => extra[key] };
}

// The one real, currently-stored server row every producer below is fed --
// deliberately identical across every route, so a key-set difference in the
// response can only come from what each route itself adds or strips, not
// from the input differing between calls.
const FAKE_SERVER_ROW = {
  id: 1,
  name: "Test Server",
  serverName: "TestServer",
  installPath: "/srv/pz",
  zomboidDataPath: "/srv/zomboid",
  serverConfigPath: null,
  dockerContainerName: null,
  branch: "stable",
  rconHost: "127.0.0.1",
  rconPort: 27015,
  rconPassword: "secret",
  adminPassword: "adminsecret",
  serverPort: 16261,
  minMemory: 4,
  maxMemory: 8,
  useNoSteam: false,
  useDebug: false,
  useUpnp: true,
  isRemote: true,
  isActive: true,
};

const SFTP_SETTINGS = {
  panelBridgeSftpHost: "192.168.1.50",
  panelBridgeSftpConfigPath: "/home/pz/Server",
};

beforeEach(() => {
  getServers.mockReset().mockResolvedValue([FAKE_SERVER_ROW]);
  getActiveServer.mockReset().mockResolvedValue(FAKE_SERVER_ROW);
  getServer.mockReset().mockResolvedValue(FAKE_SERVER_ROW);
  createServer.mockReset().mockResolvedValue(FAKE_SERVER_ROW);
  updateServer.mockReset().mockResolvedValue(FAKE_SERVER_ROW);
  setActiveServer.mockReset().mockResolvedValue(FAKE_SERVER_ROW);
  getAllSettings.mockReset().mockResolvedValue(SFTP_SETTINGS);
  setSetting.mockReset().mockResolvedValue(undefined);
});

describe("cross-producer shape gate: Server (apps/panel-server/routes/servers.js)", () => {
  // servers.js:509-515 documents this exact pair as required to never
  // drift, via a helper (computeRemoteConfigConfigured) shared by both --
  // this test makes that comment machine-checked instead of comment-only.
  it("GET / (per-item) and GET /active return identical key sets for the same server", async () => {
    const list = await invokeJson(serversRouter, "/", "get", { app: fakeApp() });
    const active = await invokeJson(serversRouter, "/active", "get", { app: fakeApp() });

    const listKeys = Object.keys(list.servers[0]).sort();
    const activeKeys = Object.keys(active.server).sort();

    expect(listKeys.length, "producer returned an empty object -- nothing to compare").toBeGreaterThan(0);
    expect(activeKeys).toEqual(listKeys);
    expect(list.servers[0].remoteConfigConfigured).toBe(true);
    expect(active.server.remoteConfigConfigured).toBe(true);
  });

  // Break-verify: this file does not edit servers.js (not this task's file
  // to touch, and not something to perturb even temporarily) -- so instead
  // of reintroducing the historical bug in real route code, this proves the
  // key-set comparison used throughout this file actually fails on the
  // exact shape of that bug (a producer silently missing one field), the
  // same way the no-duplicate-interface-name ESLint rule was break-verified
  // by feeding it BackupFile's real pre-fix source instead of editing
  // eslint.config.js. If this test ever passed, every assertion above and
  // below it would be vacuous.
  it("the key-set comparison used above actually fails on a missing field (not a vacuous check)", () => {
    const withField = { id: 1, name: "A", remoteConfigConfigured: true };
    const withoutField = { id: 1, name: "A" };
    expect(Object.keys(withoutField).sort()).not.toEqual(Object.keys(withField).sort());
  });

  // Known, cited, self-documenting exception -- not a hidden allowlist.
  // These four routes never attach remoteConfigConfigured at all (verified
  // by reading servers.js directly, 2026-08-27: GET /:id res.json at line
  // 684, POST / at line 885, PUT /:id at line 1176, POST /:id/activate at
  // line 1306 all call sanitizeServerResponse(server) with no
  // remoteConfigConfigured merge -- contrast with GET / line 529 and GET
  // /active line 659, both of which do).
  //
  // Confirmed harmless today, not just assumed: apps/panel-client/src/lib/api.ts and
  // apps/panel-client/src/components/Layout.tsx were grepped for
  // "remoteConfigConfigured" and Layout.tsx:314 is the ONLY client
  // consumer, sourced exclusively from GET / -- Layout.tsx's two fetch
  // sites (initial load and the activeServerChanged socket handler, lines
  // ~558-563 and ~579-584) both call serversApi.getAll() (GET /), never GET
  // /active, GET /:id, or the body of a POST/PUT/activate response.
  //
  // This entry exists so a FUTURE consumer that starts reading
  // remoteConfigConfigured off one of these four routes fails LOUDLY here
  // first, instead of silently getting undefined -- same self-cleaning
  // shape as KNOWN_BROKEN_PATTERNS in
  // apps/panel-server/tests/rconRejectionGroundTruth.test.js: if one of these routes
  // starts returning the field, THIS assertion breaks and forces someone to
  // update or remove the exception, not silently keep passing.
  //
  // But the exception's OWN justification ("nothing reads it there") is
  // exactly the shape that created the original bug -- true right up until
  // it wasn't. See the "reader count" describe block below, which applies
  // the same self-cleaning trick to THIS exception's premise, not just to
  // the exception itself: it asserts Layout.tsx stays the field's only
  // client reader, so a second reader sourced from one of these four
  // routes fails loudly instead of silently shipping under a comment that
  // says it's fine.
  const ROUTES_WITHOUT_REMOTE_CONFIG_FIELD = new Set([
    "GET /:id",
    "POST / (create)",
    "PUT /:id (update)",
    "POST /:id/activate",
  ]);

  const OTHER_SERVER_PRODUCERS = [
    {
      label: "GET /:id",
      invoke: () =>
        invokeJson(serversRouter, "/:id", "get", { app: fakeApp(), params: { id: "1" } }).then(
          (p) => p.server,
        ),
    },
    {
      label: "POST / (create)",
      invoke: () =>
        invokeJson(serversRouter, "/", "post", {
          app: fakeApp(),
          body: {
            name: "Test Server",
            isRemote: true,
            rconHost: "127.0.0.1",
            rconPort: 27015,
            rconPassword: "secret",
          },
        }).then((p) => p.server),
    },
    {
      label: "PUT /:id (update)",
      invoke: () =>
        invokeJson(serversRouter, "/:id", "put", {
          app: fakeApp(),
          params: { id: "1" },
          body: { name: "Test Server" },
        }).then((p) => p.server),
    },
    {
      label: "POST /:id/activate",
      invoke: () =>
        invokeJson(serversRouter, "/:id/activate", "post", {
          app: fakeApp(),
          params: { id: "1" },
        }).then((p) => p.server),
    },
  ];

  it.each(OTHER_SERVER_PRODUCERS)(
    "$label returns the GET / shape minus only the documented, cited exception",
    async ({ label, invoke }) => {
      const list = await invokeJson(serversRouter, "/", "get", { app: fakeApp() });
      const baselineKeys = new Set(Object.keys(list.servers[0]));

      const payload = await invoke();
      const producedKeys = new Set(Object.keys(payload));

      const missing = [...baselineKeys].filter((k) => !producedKeys.has(k));
      const extra = [...producedKeys].filter((k) => !baselineKeys.has(k));

      expect(
        extra,
        `${label} returns a field GET / doesn't -- investigate, this isn't a documented exception`,
      ).toEqual([]);

      if (ROUTES_WITHOUT_REMOTE_CONFIG_FIELD.has(label)) {
        expect(
          missing,
          `${label}'s missing-field set changed -- update the citation above or remove this exception`,
        ).toEqual(["remoteConfigConfigured"]);
      } else {
        expect(missing).toEqual([]);
      }
    },
  );
});

// Self-cleaning guard on the exception above, not just the exception
// itself: "nothing reads remoteConfigConfigured off those four routes" is
// exactly the kind of premise that was true right up until it wasn't --
// the field going unread everywhere except GET / is the whole reason the
// original bug was invisible. Same technique as KNOWN_BROKEN_PATTERNS in
// apps/panel-server/tests/rconRejectionGroundTruth.test.js: don't just assert the
// exception, assert the FACT that justifies it, so the exception can't go
// stale silently.
//
// 2026-08-27: exactly two hits for "remoteConfigConfigured" in apps/panel-client/src
// -- apps/panel-client/src/lib/api.ts:1546 (the type's own declaration, not a read)
// and apps/panel-client/src/components/Layout.tsx:314 (the one real read). This is a
// grep-count check, deliberately not clever: it does not parse the AST or
// distinguish a real property read from an incidental comment mention. If
// it ever produces a false positive (a file that merely mentions the name
// without reading it), that is a five-minute look, not a real incident --
// cheap enough to be worth the loud failure on the day a second REAL
// reader shows up sourced from one of the four excepted routes above.
describe("remoteConfigConfigured reader-count guard (justifies the exception above)", () => {
  const CLIENT_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../panel-client/src");
  const API_TS = path.join(CLIENT_SRC, "lib", "api.ts");

  function listSourceFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...listSourceFiles(full));
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  it("has exactly one client-side reader of remoteConfigConfigured, and it's Layout.tsx", () => {
    const files = listSourceFiles(CLIENT_SRC);
    expect(files.length, "found zero source files under apps/panel-client/src -- the path resolution above is wrong, this check would otherwise pass vacuously").toBeGreaterThan(0);

    const readers = files
      .filter((f) => f !== API_TS) // the interface's own declaration is not a read
      .filter((f) => /remoteConfigConfigured/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(CLIENT_SRC, f).replace(/\\/g, "/"));

    expect(
      readers,
      "the set of client-side readers of remoteConfigConfigured changed -- this is the exact premise the four-route exception above relies on. For each new file listed here: does it source its server data from GET /servers (safe, already carries the field), or from GET /servers/:id, POST /servers, PUT /servers/:id, or POST /servers/:id/activate (all four are missing the field today -- this new reader will silently see undefined)? If any of the latter, either fix the route to attach remoteConfigConfigured or fix the reader to source from GET / instead, then update this list and the exception above together.",
    ).toEqual(["components/Layout.tsx"]);
  });
});

describe("cross-producer shape gate: ServerBackupArchive (apps/panel-server/routes/backup.js)", () => {
  // The two real producers of this shape found in apps/panel-server/routes:
  // GET /backup/list's per-item shape (backupService.listBackups(),
  // backupService.js:662-697) and POST /backup/create's .backup field
  // (backupService.js:512-517's this.lastBackup). Both are the full .zip
  // server-backup shape -- api.ts's ServerBackupArchive after the
  // 2026-08-27 BackupFile-collision fix, distinct from ConfigBackupFile
  // (server-files/backups' unrelated config-file .bak shape, single
  // producer, nothing to cross-compare it against today).
  const FAKE_ARCHIVE = {
    name: "servertest_2026-08-27.zip",
    path: "/backups/servertest_2026-08-27.zip",
    size: 123456,
    created: "2026-08-27T00:00:00.000Z",
  };

  it("GET /list (per-item) and POST /create's .backup return identical key sets", async () => {
    const backupService = {
      listBackups: vi.fn(async () => [FAKE_ARCHIVE]),
      createBackup: vi.fn(async () => ({
        success: true,
        backup: FAKE_ARCHIVE,
        duration: 1.2,
        skippedFiles: [],
      })),
    };
    getActiveServer.mockResolvedValue({ isRemote: false });
    const app = fakeApp({ backupService });

    const list = await invokeJson(backupRouter, "/list", "get", { app });
    const created = await invokeJson(backupRouter, "/create", "post", { app, body: {} });

    const listKeys = Object.keys(list.backups[0]).sort();
    const createKeys = Object.keys(created.backup).sort();

    expect(listKeys.length, "producer returned an empty object -- nothing to compare").toBeGreaterThan(0);
    expect(createKeys).toEqual(listKeys);
  });

  // Break-verify, same reasoning as the Server group above: proves the
  // comparison isn't vacuous without touching backup.js/backupService.js.
  it("the key-set comparison used above actually fails on a missing field (not a vacuous check)", () => {
    const full = { name: "a.zip", path: "/a.zip", size: 1, created: "now" };
    const missingPath = { name: "a.zip", size: 1, created: "now" };
    expect(Object.keys(missingPath).sort()).not.toEqual(Object.keys(full).sort());
  });
});
