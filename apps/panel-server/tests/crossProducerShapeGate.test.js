import { describe, expect, it, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";


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

vi.mock("../services/rcon.ts", () => ({
  normalizeRconHost: (host) => host.trim(),
  testRconConnection,
}));

const { default: serversRouter } = await import("../routes/servers.ts");
const { default: backupRouter } = await import("../routes/backup.ts");

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

describe("cross-producer shape gate: Server (apps/panel-server/routes/servers.ts)", () => {
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

  // eslint.config.js. If this test ever passed, every assertion above and
  it("the key-set comparison used above actually fails on a missing field (not a vacuous check)", () => {
    const withField = { id: 1, name: "A", remoteConfigConfigured: true };
    const withoutField = { id: 1, name: "A" };
    expect(Object.keys(withoutField).sort()).not.toEqual(Object.keys(withField).sort());
  });

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
      .filter((f) => f !== API_TS)
      .filter((f) => /remoteConfigConfigured/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(CLIENT_SRC, f).replace(/\\/g, "/"));

    expect(
      readers,
      "the set of client-side readers of remoteConfigConfigured changed -- this is the exact premise the four-route exception above relies on. For each new file listed here: does it source its server data from GET /servers (safe, already carries the field), or from GET /servers/:id, POST /servers, PUT /servers/:id, or POST /servers/:id/activate (all four are missing the field today -- this new reader will silently see undefined)? If any of the latter, either fix the route to attach remoteConfigConfigured or fix the reader to source from GET / instead, then update this list and the exception above together.",
    ).toEqual(["components/Layout.tsx"]);
  });
});

describe("cross-producer shape gate: ServerBackupArchive (apps/panel-server/routes/backup.ts)", () => {
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

  it("the key-set comparison used above actually fails on a missing field (not a vacuous check)", () => {
    const full = { name: "a.zip", path: "/a.zip", size: 1, created: "now" };
    const missingPath = { name: "a.zip", size: 1, created: "now" };
    expect(Object.keys(missingPath).sort()).not.toEqual(Object.keys(full).sort());
  });
});
