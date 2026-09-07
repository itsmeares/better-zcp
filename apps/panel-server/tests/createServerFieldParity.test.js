import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";


const { createServerSpy } = vi.hoisted(() => ({ createServerSpy: vi.fn() }));
vi.mock("../database/init.ts", async (importOriginal) => {
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
    const { default: router } = await import("../routes/servers.ts");
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
    const { default: router } = await import("../routes/servers.ts");
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
    const { default: router } = await import("../routes/servers.ts");
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
    const { default: router } = await import("../routes/servers.ts");
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
