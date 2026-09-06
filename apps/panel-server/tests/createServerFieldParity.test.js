import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 2026-08-26, two real users + a same-night 14-field audit: createServer()
// (database/init.js) builds the persisted record from an explicit
// field-by-field object literal. THAT LITERAL HAS SILENTLY DROPPED FOUR
// FIELDS SO FAR: adminPassword (fixed this session -- the actual crash),
// dockerContainerName (live: a Docker-managed server created through the
// Add/Register dialog never got its container name persisted), branch
// (currently inert -- nothing reads server.branch yet, but a future
// feature that trusts it would silently get "stable" no matter what was
// picked), and useUpnp (wasn't even a column, let alone forwarded).
// updateServer() never had this bug -- it spreads `updates` generically --
// which is exactly why re-saving a field after the fact was the only
// workaround for adminPassword.
//
// god's instruction, verbatim: "A test that asserts every field the create
// ROUTE forwards is a field createServer actually PERSISTS would catch
// this entire class forever." This is that test -- it does not hand-copy a
// field list (which could itself go stale the same way the literal did);
// it spies on the REAL createServer() call servers.js's POST / route makes
// and checks the REAL persisted record against exactly what was forwarded,
// so a fifth dropped field fails this test the day it's introduced.

const { createServerSpy } = vi.hoisted(() => ({ createServerSpy: vi.fn() }));
vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createServer: async (config) => {
      const result = await actual.createServer(config);
      createServerSpy(config, result);
      return result;
    },
  };
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

function getRouteHandler(router, routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe("POST /servers -- every field forwarded to createServer() must survive onto the persisted record", () => {
  let tmpRoot;
  let installPath;
  let zomboidDataPath;

  beforeEach(() => {
    createServerSpy.mockClear();
    // Real, existing directories -- normalizeServerMemory() (database/init.js)
    // legitimately recomputes isRemote from whether the configured path
    // actually exists locally, unrelated to this test's own concern. Using
    // real paths means that recomputation agrees with what was forwarded
    // instead of silently overriding it, so the generic per-field
    // comparison below stays meaningful for isRemote too, not just every
    // other field.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-parity-"));
    installPath = path.join(tmpRoot, "server");
    zomboidDataPath = path.join(tmpRoot, "data");
    fs.mkdirSync(installPath, { recursive: true });
    fs.mkdirSync(zomboidDataPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("a comprehensive create request persists every meaningfully-set field it forwards, not just the ones already known to work", async () => {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    const body = {
      name: "ParityTest",
      serverName: "ParityTest",
      installPath,
      zomboidDataPath,
      dockerContainerName: "pz-container",
      branch: "unstable",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "rconpw123",
      adminPassword: "adminpw123",
      serverPort: 16262,
      minMemory: 2,
      maxMemory: 4,
      useNoSteam: true,
      useDebug: true,
      useUpnp: false,
      isRemote: false,
    };

    await getRouteHandler(router, "/", "post")({ body }, res);

    expect(res.getStatusCode()).toBe(201);
    expect(createServerSpy).toHaveBeenCalledTimes(1);
    const [forwarded, persisted] = createServerSpy.mock.calls[0];

    // persisted is createServer()'s own real return value -- unsanitized,
    // unlike res.getBody().server (which masks adminPassword/rconPassword
    // for the HTTP response and would make this comparison falsely fail
    // for exactly the two fields this test cares most about).
    for (const [key, value] of Object.entries(forwarded)) {
      if (value === undefined || value === null || value === "") continue;
      expect(
        persisted,
        `field "${key}" was forwarded to createServer() as ${JSON.stringify(value)} but is missing from the persisted record`,
      ).toHaveProperty(key);
      expect(
        persisted[key],
        `field "${key}" was forwarded as ${JSON.stringify(value)} but persisted as ${JSON.stringify(persisted[key])}`,
      ).toEqual(value);
    }
  });

  it("dockerContainerName specifically -- the live regression (a Docker-managed server registered through the Add/Register dialog)", async () => {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await getRouteHandler(router, "/", "post")(
      {
        body: {
          name: "DockerServer",
          serverName: "DockerServer",
          installPath,
          rconHost: "127.0.0.1",
          rconPort: 27016,
          rconPassword: "rconpw",
          dockerContainerName: "my-pz-container",
        },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(201);
    const [, persisted] = createServerSpy.mock.calls[0];
    expect(persisted.dockerContainerName).toBe("my-pz-container");
  });

  it("useUpnp specifically -- explicit false must persist as false, not be coerced to the true default", async () => {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await getRouteHandler(router, "/", "post")(
      {
        body: {
          name: "UpnpOffServer",
          serverName: "UpnpOffServer",
          installPath,
          rconHost: "127.0.0.1",
          rconPort: 27017,
          rconPassword: "rconpw",
          useUpnp: false,
        },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(201);
    const [, persisted] = createServerSpy.mock.calls[0];
    expect(persisted.useUpnp).toBe(false);
  });

  it("useUpnp omitted entirely defaults to true, matching the wizard's own default checkbox state", async () => {
    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await getRouteHandler(router, "/", "post")(
      {
        body: {
          name: "UpnpDefaultServer",
          serverName: "UpnpDefaultServer",
          installPath,
          rconHost: "127.0.0.1",
          rconPort: 27018,
          rconPassword: "rconpw",
        },
      },
      res,
    );
    expect(res.getStatusCode()).toBe(201);
    const [, persisted] = createServerSpy.mock.calls[0];
    expect(persisted.useUpnp).toBe(true);
  });
});
