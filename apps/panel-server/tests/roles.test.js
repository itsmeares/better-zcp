import { describe, expect, it } from "vitest";

const { default: authRouter } = await import("../routes/auth.js");
const { default: dockerRouter } = await import("../routes/docker.js");

function createResponse() {
  const response = { status: () => response, json: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = () => response;
  response.getStatusCode = () => statusCode;
  return response;
}

function getLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getLayer(router, routePath, method);
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

describe("user management gate — users.manage capability, not a role name", () => {
  it("refuses a technician listing users (GET /users)", async () => {
    const res = await runRoute(authRouter, "/users", "get", {
      user: { role: "technician" },
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("admits an admin listing users (GET /users)", async () => {
    const res = await runRoute(authRouter, "/users", "get", {
      user: { role: "admin" },
    });
    expect(res.getStatusCode()).toBe(200);
  });

  it("refuses a technician creating a new user", async () => {
    const res = await runRoute(authRouter, "/users", "post", {
      body: { username: "x", password: "password123", role: "moderator" },
      user: { role: "technician" },
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin creating a user (may still fail downstream on a missing body)", async () => {
    const res = await runRoute(authRouter, "/users", "post", {
      body: {},
      user: { role: "admin" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("refuses a moderator changing a user's role", async () => {
    const res = await runRoute(authRouter, "/users/:id/role", "patch", {
      params: { id: "some-id" },
      body: { role: "admin" },
      user: { role: "moderator" },
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it("does not refuse an admin at the role gate (may still fail downstream on a fake id)", async () => {
    const res = await runRoute(authRouter, "/users/:id/role", "patch", {
      params: { id: "definitely-not-a-real-user-id" },
      body: { role: "admin" },
      user: { role: "admin" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });
});

describe("requireRole wiring — operate routes admit technician", () => {
  it("allows a technician to reach GET /api/docker/status — the direction that proves this isn't just locked down", async () => {
    const res = await runRoute(dockerRouter, "/status", "get", {
      app: { get: () => null },
      user: { role: "technician" },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("refuses a moderator at the same route — technician being admitted isn't 'any non-admin passes'", async () => {
    const res = await runRoute(dockerRouter, "/status", "get", {
      app: { get: () => null },
      user: { role: "moderator" },
    });
    expect(res.getStatusCode()).toBe(403);
  });
});
