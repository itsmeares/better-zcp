import { describe, expect, it, afterEach } from "vitest";
import { createServer, deleteServer, getServer } from "../database/init.js";

// 2026-08-29 issue dead-allowlist-fields-on-server-update: startBat
// and batFile were already removed from ALLOWED_SERVER_UPDATE_FIELDS
// (2026-08-27, see the comment above the list in apps/panel-server/routes/servers.js).
// "description" was still on it. Grepped every `.description` reference on
// a server-shaped object across apps/panel-server/ and apps/panel-client/src/ -- every hit was
// mod metadata, Steam branch metadata, a toast's own `description` field, or
// an i18n key literally named `description`; nothing anywhere reads a
// server record's own description back out. updateServer() persists
// whatever lands in `updates` via a plain object spread (not a field-by-
// field write), so the value WAS being written to db.json on every request
// that included it -- this test proves that concretely, not just "grep
// found nothing".
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

    const { default: router } = await import("../routes/servers.js");
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
    // The allowlisted field alongside it in the same request DID apply --
    // proves the filtering is field-specific, not a broken PUT entirely.
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

    const { default: router } = await import("../routes/servers.js");
    const res = createResponse();
    await getRouteHandler(router, "/:id", "put")(
      {
        params: { id: String(server.id) },
        // startBat/batFile alone would leave `updates` empty after
        // filtering and trip the route's separate "no valid fields" 400 --
        // unrelated to whether these two fields themselves are dead.
        // Include a real field so a 200 here actually isolates that.
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
