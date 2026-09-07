import { describe, expect, it, afterEach } from "vitest";
import { createServer, deleteServer, getServer } from "../database/init.ts";

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

describe("PUT /servers/:id -- description is not a real per-server field", () => {
  let createdServerId;

  afterEach(async () => {
    if (createdServerId != null) {
      await deleteServer(createdServerId);
      createdServerId = null;
    }
  });

  it("does not persist a description sent in the update body", async () => {
    const server = await createServer({
      name: "DeadFieldTest",
      serverName: "DeadFieldTest",
      installPath: "/tmp/dead-field-test",
      rconHost: "127.0.0.1",
      rconPort: 27015,
      rconPassword: "x",
    });
    createdServerId = server.id;

    const { default: router } = await import("../routes/servers.ts");
    const res = createResponse();
    await getRouteHandler(router, "/:id", "put")(
      {
        params: { id: String(server.id) },
        body: { description: "should never be stored", name: "DeadFieldTestRenamed" },
        app: { get: () => undefined },
      },
      res,
    );

    expect(res.getStatusCode()).toBe(200);
    const stored = await getServer(server.id);
    expect(stored.name).toBe("DeadFieldTestRenamed");
    expect(stored.description).toBeUndefined();
  });

  it("does not accept startBat/batFile either (already removed, guarding against reintroduction)", async () => {
    const server = await createServer({
      name: "DeadFieldTest2",
      serverName: "DeadFieldTest2",
      installPath: "/tmp/dead-field-test-2",
      rconHost: "127.0.0.1",
      rconPort: 27016,
      rconPassword: "x",
    });
    createdServerId = server.id;

    const { default: router } = await import("../routes/servers.ts");
    const res = createResponse();
    await getRouteHandler(router, "/:id", "put")(
      {
        params: { id: String(server.id) },
        body: {
          startBat: "Start.bat",
          batFile: "server.bat",
          name: "DeadFieldTest2Renamed",
        },
        app: { get: () => undefined },
      },
      res,
    );

    expect(res.getStatusCode()).toBe(200);
    const stored = await getServer(server.id);
    expect(stored.startBat).toBeUndefined();
    expect(stored.batFile).toBeUndefined();
  });
});
