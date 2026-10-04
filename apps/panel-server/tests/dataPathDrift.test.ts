import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import fs from "fs";
import os from "os";
import path from "path";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { Open } from "unzipper";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.ts";

const testPaths = vi.hoisted(() => ({ current: null as any }));
const testServer = vi.hoisted(() => ({ current: null as any }));

vi.mock("../database/init.ts", async () => {
  const actual = await vi.importActual("../database/init.ts");
  return {
    ...actual,
    getRoleByName: mockGetRoleByName,
    getCurrentServer: async () => testServer.current,
  };
});
vi.mock("../utils/paths.ts", async () => {
  const actual = await vi.importActual("../utils/paths.ts");
  return { ...actual, getDataPaths: () => testPaths.current };
});
vi.mock("../routes/worldMap.ts", () => ({
  getWorldMapDiagnostics: async () => ({
    available: false,
    key: "",
    folders: [],
    bounds: null,
    floors: { min: 0, max: 0 },
    warnings: [],
  }),
}));

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-debug-paths-"));
testPaths.current = {
  dataDir: path.join(testDataDir, "data"),
  logsDir: path.join(testDataDir, "logs"),
  dbPath: path.join(testDataDir, "data", "panel.sqlite"),
  configPath: path.join(testDataDir, "paths.config.json"),
};
fs.mkdirSync(testPaths.current.dataDir, { recursive: true });
fs.mkdirSync(testPaths.current.logsDir, { recursive: true });

const { getDataPaths } = await import("../utils/paths.ts");
const { default: debugRouter, formatDbAccessibleMessage } = await import("../routes/debug.ts");
const { closeDatabase } = await import("../database/init.ts");
const { handleApiRequest } = await import("../http/apiDispatcher.ts");
const { setPanelRuntime } = await import("../utils/panelRuntime.ts");

afterAll(() => {
  closeDatabase();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

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

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req, res = createResponse()) {
  const layer = getLayer(router, routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function withTimeout(promise, timeoutMs, message) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timeout));
}

async function readResponseBody(response, timeoutMs = 10000) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  })();
  try {
    return await withTimeout(read, timeoutMs, "HTTP response body timed out");
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function setAdminApiRuntime() {
  setPanelRuntime({
    authService: {
      authenticateApiRequest: async () => ({
        ok: true,
        user: { userId: "test-admin", username: "test", role: "admin" },
      }),
    },
  });
}

function createDownloadResponse() {
  const response = new PassThrough();
  let statusCode = 200;
  let body = "";
  const headers = new Map();
  response.on("data", (chunk) => (body += chunk.toString()));
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    body = payload;
    return response;
  };
  response.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
  response.getStatusCode = () => statusCode;
  response.getBody = () => body;
  response.getHeader = (name) => headers.get(name.toLowerCase());
  return response;
}

function createBinaryDownloadResponse() {
  const response = new PassThrough();
  const chunks: Buffer[] = [];
  let statusCode = 200;
  const headers = new Map();
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = (payload) => {
    chunks.length = 0;
    chunks.push(Buffer.from(JSON.stringify(payload)));
    return response;
  };
  response.setHeader = (name, value) => headers.set(name.toLowerCase(), value);
  response.getStatusCode = () => statusCode;
  response.getBody = () => Buffer.concat(chunks);
  response.getHeader = (name) => headers.get(name.toLowerCase());
  return response;
}

function adminReq(overrides = {}) {
  return {
    user: { role: "admin" },
    params: {},
    query: {},
    body: {},
    app: { get: () => undefined },
    ...overrides,
  };
}

describe("debug.js crash-logs: scans the configured logs directory, not process.cwd()", () => {
  it("GET /crash-logs finds a crash-shaped file placed in getDataPaths().logsDir", async () => {
    const { logsDir } = getDataPaths();
    const markerFile = path.join(logsDir, "hs_err_pid99999.log");
    fs.writeFileSync(markerFile, "fake crash dump for this test");
    try {
      const res = await runRoute(debugRouter, "/crash-logs", "get", adminReq());
      expect(res.getStatusCode()).toBe(200);
      const names = res.getBody().crashLogs.map((c) => c.name);
      expect(names).toContain("hs_err_pid99999.log");
    } finally {
      fs.rmSync(markerFile, { force: true });
    }
  });

  it("GET /crash-logs/:filename reads the same file's content from the configured logs directory", async () => {
    const { logsDir } = getDataPaths();
    const markerFile = path.join(logsDir, "crash-drift-test.log");
    fs.writeFileSync(markerFile, "distinctive content only this test writes");
    try {
      const res = await runRoute(debugRouter, "/crash-logs/:filename", "get", adminReq({
        params: { filename: "crash-drift-test.log" },
      }));
      expect(res.getStatusCode()).toBe(200);
      expect(res.getBody().content).toContain("distinctive content only this test writes");
    } finally {
      fs.rmSync(markerFile, { force: true });
    }
  });

  it("GET /crash-logs/:filename refuses an arbitrary install-root file", async () => {
    const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pz-crash-install-"));
    const scriptName = "StartServer_TestServer.bat";
    fs.writeFileSync(
      path.join(installRoot, scriptName),
      'start ProjectZomboid64.exe -adminpassword "not-a-log"',
    );
    try {
      const res = await runRoute(
        debugRouter,
        "/crash-logs/:filename",
        "get",
        adminReq({
          params: { filename: scriptName },
          app: { get: () => ({ serverPath: installRoot }) },
        }),
      );
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody()).not.toHaveProperty("content");
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
  });

  it("lists and previews the configured server crash root, then downloads the full log", async () => {
    const zomboidDataPath = path.join(testDataDir, "crash-profile");
    const logsDir = path.join(zomboidDataPath, "Logs");
    const content = "crash line\n".repeat(12000);
    const filename = "hs_err_pid88888.log";
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(path.join(logsDir, filename), content);
    testServer.current = {
      id: "crash-profile",
      name: "Crash profile",
      serverName: "Crash profile",
      serverPath: "",
      installPath: "",
      zomboidDataPath,
    };
    try {
      const listed = await runRoute(debugRouter, "/crash-logs", "get", adminReq());
      expect(listed.getBody().crashLogs.map((log) => log.name)).toContain(filename);

      const preview = await runRoute(
        debugRouter,
        "/crash-logs/:filename",
        "get",
        adminReq({ params: { filename } }),
      );
      expect(preview.getStatusCode()).toBe(200);
      expect(preview.getBody()).toMatchObject({ truncated: true, size: Buffer.byteLength(content) });

      const res = createDownloadResponse();
      await runRoute(
        debugRouter,
        "/crash-logs/:filename/download",
        "get",
        adminReq({ params: { filename } }),
        res,
      );
      await finished(res);
      expect(res.getStatusCode()).toBe(200);
      expect(res.getHeader("content-disposition")).toContain(filename);
      expect(res.getBody()).toBe(content);
    } finally {
      testServer.current = null;
      fs.rmSync(zomboidDataPath, { recursive: true, force: true });
    }
  });

  it("rejects traversal and only lists regular text crash files", async () => {
    const { logsDir } = getDataPaths();
    const filename = "crash-guard-test.log";
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-crash-guard-"));
    const externalFile = path.join(externalDir, filename);
    fs.writeFileSync(externalFile, "outside log root");

    let symlinkCreated = false;
    try {
      fs.symlinkSync(externalFile, path.join(logsDir, filename));
      symlinkCreated = true;
    } catch {
      // Windows may not permit symlink creation without an elevated test user.
    }

    try {
      const listed = await runRoute(
        debugRouter,
        "/crash-logs",
        "get",
        adminReq(),
      );
      expect(listed.getBody().crashLogs.map((entry) => entry.name)).not.toContain(
        filename,
      );

      const traversal = await runRoute(
        debugRouter,
        "/crash-logs/:filename",
        "get",
        adminReq({ params: { filename: "../crash-guard-test.log" } }),
      );
      expect(traversal.getStatusCode()).toBe(400);

      if (symlinkCreated) {
        const preview = await runRoute(
          debugRouter,
          "/crash-logs/:filename",
          "get",
          adminReq({ params: { filename } }),
        );
        const download = await runRoute(
          debugRouter,
          "/crash-logs/:filename/download",
          "get",
          adminReq({ params: { filename } }),
        );
        expect(preview.getStatusCode()).toBe(404);
        expect(download.getStatusCode()).toBe(404);
      }
    } finally {
      fs.rmSync(path.join(logsDir, filename), { force: true });
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("limits panel log downloads to regular .log files", async () => {
    const { logsDir } = getDataPaths();
    const filePath = path.join(logsDir, "available-panel.log");
    fs.writeFileSync(filePath, "panel log contents");
    try {
      const response = createDownloadResponse();
      await runRoute(
        debugRouter,
        "/logs/download/:filename",
        "get",
        adminReq({ params: { filename: "available-panel.log" } }),
        response,
      );
      await finished(response);
      expect(response.getStatusCode()).toBe(200);
      expect(response.getBody()).toBe("panel log contents");

      const database = await runRoute(
        debugRouter,
        "/logs/download/:filename",
        "get",
        adminReq({ params: { filename: "panel.sqlite" } }),
      );
      expect(database.getStatusCode()).toBe(400);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
  });

  it("rejects a symlinked combined log download", async () => {
    const { logsDir } = getDataPaths();
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-combined-log-"));
    const externalFile = path.join(externalDir, "combined.log");
    fs.writeFileSync(externalFile, "outside log contents");
    const combinedPath = path.join(logsDir, "combined.log");
    const backupPath = path.join(logsDir, "combined.log.test-backup");
    const hadCombinedLog = fs.existsSync(combinedPath);
    if (hadCombinedLog) fs.renameSync(combinedPath, backupPath);
    let symlinkCreated = false;
    try {
      try {
        fs.symlinkSync(externalFile, combinedPath);
        symlinkCreated = true;
      } catch (error: any) {
        if (error?.code !== "EPERM" && error?.code !== "EACCES") throw error;
      }
      if (symlinkCreated) {
        const response = createDownloadResponse();
        await runRoute(debugRouter, "/logs/download", "get", adminReq(), response);
        expect(response.getStatusCode()).toBe(404);
        expect(response.getBody()).not.toContain("outside log contents");
      }
    } finally {
      if (symlinkCreated) fs.rmSync(combinedPath, { force: true });
      if (hadCombinedLog) fs.renameSync(backupPath, combinedPath);
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("builds a scoped support bundle with redacted logs but no Saves or panel database", async () => {
    const { logsDir, dataDir } = getDataPaths();
    const zomboidDataPath = path.join(testDataDir, "configured-profile");
    const unrelatedPath = path.join(testDataDir, "unrelated-profile");
    const archivePath = path.join(testDataDir, "support-bundle.zip");
    fs.mkdirSync(path.join(zomboidDataPath, "Logs"), { recursive: true });
    fs.mkdirSync(path.join(zomboidDataPath, "Saves", "Multiplayer"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(unrelatedPath, "Logs"), { recursive: true });
    fs.writeFileSync(
      path.join(zomboidDataPath, "Logs", "server-error.log"),
      "https://api.steampowered.com/?key=0123456789ABCDEF\n",
    );
    fs.writeFileSync(
      path.join(zomboidDataPath, "Saves", "Multiplayer", "ignored.log"),
      "save data must stay out",
    );
    fs.writeFileSync(
      path.join(zomboidDataPath, "Saves", "error.log"),
      "save data must stay out even when the filename looks like a crash log",
    );
    fs.writeFileSync(
      path.join(unrelatedPath, "Logs", "other-profile-error.log"),
      "other profile must stay out",
    );
    fs.writeFileSync(path.join(logsDir, "combined.log"), "panel log\n");
    testServer.current = {
      id: "support-fixture",
      name: "Support fixture",
      serverName: "Support fixture",
      installPath: "",
      serverPath: "",
      zomboidDataPath,
    };
    const oldSavePath = process.env.PZ_SAVE_PATH;
    process.env.PZ_SAVE_PATH = unrelatedPath;
    const response = createBinaryDownloadResponse();

    try {
      await runRoute(
        debugRouter,
        "/logs/download-zip",
        "get",
        adminReq(),
        response,
      );
      await finished(response);
      expect(response.getStatusCode()).toBe(200);
      fs.writeFileSync(archivePath, response.getBody());
      const archive = await Open.file(archivePath);
      const names = archive.files.map((entry) => entry.path);
      const configuredLog = names.find((name) => name.endsWith("/server-error.log"));
      expect(configuredLog).toBeTruthy();
      expect(names.some((name) => /\/Saves(?:\/|$)/i.test(name))).toBe(false);
      expect(names.some((name) => name.includes("other-profile-error.log"))).toBe(false);
      expect(names.some((name) => name.endsWith("panel.sqlite"))).toBe(false);
      const log = await archive.files
        .find((entry) => entry.path === configuredLog)
        .buffer();
      expect(log.toString()).toContain("key=[REDACTED]");
      expect(log.toString()).not.toContain("0123456789ABCDEF");
      expect(fs.existsSync(path.join(dataDir, "panel.sqlite"))).toBe(true);
    } finally {
      testServer.current = null;
      if (oldSavePath === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = oldSavePath;
    }
  });

  it("does not scan the home fallback for an incomplete active profile", async () => {
    const homePath = path.join(testDataDir, "home", "Zomboid");
    fs.mkdirSync(path.join(homePath, "Logs"), { recursive: true });
    fs.writeFileSync(path.join(homePath, "Logs", "crash-home-profile.log"), "home");
    testServer.current = {
      id: "incomplete-profile",
      name: "Incomplete profile",
      serverName: "Incomplete profile",
      serverPath: "",
      zomboidDataPath: null,
    };
    const oldSavePath = process.env.PZ_SAVE_PATH;
    delete process.env.PZ_SAVE_PATH;
    const homedir = vi.spyOn(os, "homedir").mockReturnValue(path.join(testDataDir, "home"));

    try {
      const response = await runRoute(debugRouter, "/crash-logs", "get", adminReq());
      expect(response.getBody().crashLogs.map((entry) => entry.name)).not.toContain(
        "crash-home-profile.log",
      );
    } finally {
      homedir.mockRestore();
      if (oldSavePath === undefined) delete process.env.PZ_SAVE_PATH;
      else process.env.PZ_SAVE_PATH = oldSavePath;
      testServer.current = null;
    }
  });
});

describe("debug downloads through the API dispatcher", () => {
  it("streams a full crash log larger than 200 KB", async () => {
    const { logsDir } = getDataPaths();
    const filename = "hs_err_pid77777.log";
    const filePath = path.join(logsDir, filename);
    const contents = randomBytes(320 * 1024);
    fs.writeFileSync(filePath, contents);
    setAdminApiRuntime();

    try {
      const response = await handleApiRequest(
        new Request(`http://panel.test/api/debug/crash-logs/${filename}/download`),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers.get("content-disposition")).toContain(filename);
      expect(await readResponseBody(response!)).toEqual(contents);
    } finally {
      setPanelRuntime({});
      fs.rmSync(filePath, { force: true });
    }
  });

  it("closes support-bundle log readers when the response is cancelled", async () => {
    const { logsDir } = getDataPaths();
    const filePath = path.join(logsDir, "cancel-stream-fixture.log");
    fs.writeFileSync(filePath, randomBytes(8 * 1024 * 1024));
    let resolveSource;
    const sourceReady = new Promise((resolve) => {
      resolveSource = resolve;
    });
    let source;
    const createReadStream = fs.createReadStream;
    const sourceSpy = vi
      .spyOn(fs, "createReadStream")
      .mockImplementation((file, ...args) => {
        const stream = createReadStream.call(fs, file, ...args);
        if (path.resolve(String(file)) === path.resolve(filePath)) {
          source = stream;
          resolveSource(stream);
        }
        return stream;
      });
    setAdminApiRuntime();
    let reader;

    try {
      const response = await handleApiRequest(
        new Request("http://panel.test/api/debug/logs/download-zip"),
      );
      expect(response?.status).toBe(200);
      reader = response!.body!.getReader();
      const firstChunk = await withTimeout(
        reader.read(),
        10000,
        "support bundle did not start streaming",
      );
      expect(firstChunk.done).toBe(false);

      const openedSource = await withTimeout(
        sourceReady,
        10000,
        "support bundle did not open the fixture log",
      );
      expect(openedSource).toBe(source);
      expect(source.destroyed).toBe(false);
      const closed = source.closed
        ? Promise.resolve()
        : new Promise((resolve) => source.once("close", resolve));

      await reader.cancel();
      await withTimeout(closed, 5000, "support log reader stayed open after cancel");
      expect(source.destroyed).toBe(true);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      sourceSpy.mockRestore();
      setPanelRuntime({});
      fs.rmSync(filePath, { force: true });
    }
  });
});

describe("debug.js formatDbAccessibleMessage: the diagnostics 'Database accessible' check", () => {
  it("was structurally incapable of ever printing anything but '? collections, 0 MB' -- reports the real numbers now", () => {
    const dbStats = {
      fileSizeBytes: 5 * 1024 * 1024, // 5 MB
      collections: {
        command_history: 3,
        scheduled_tasks: 0,
        servers: 1,
      },
    };
    expect(formatDbAccessibleMessage(dbStats)).toBe("3 collections, 5 MB.");
  });

  it("still reports '?' when dbStats itself is unavailable (timeout/failure upstream), not a crash", () => {
    expect(formatDbAccessibleMessage(null)).toBe("? collections, ?.");
    expect(formatDbAccessibleMessage(undefined)).toBe("? collections, ?.");
  });

  it("reports 0 MB honestly (not '?') for a real, empty database file", () => {
    expect(formatDbAccessibleMessage({ fileSizeBytes: 0, collections: {} })).toBe("0 collections, 0 MB.");
  });
});
