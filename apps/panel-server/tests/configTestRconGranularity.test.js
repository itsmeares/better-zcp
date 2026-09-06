import { describe, expect, it, vi } from "vitest";
import net from "net";

vi.mock("../database/init.js", () => ({
  getAllSettings: vi.fn(async () => ({})),
  getSetting: vi.fn(async () => undefined),
  setSetting: vi.fn(async () => {}),
}));

const router = (await import("../routes/config.js")).default;
const { RCON_UNREACHABLE_DETAIL, RCON_AUTH_FAILED_DETAIL } = await import(
  "../services/rcon.js"
);

// POST /api/config/test-rcon never received the unreachable-vs-auth-failed
// split given to /rcon/test and /rcon/connect in 0714d91 -- it collapsed
// EVERY failure (host genuinely unreachable, or host reachable but the
// saved password is stale) into one generic "Failed to connect to RCON"
// message, which Console.tsx's banner then rendered as "host unreachable"
// even for a wrong password (2026-08-26 bug hunt finding 1). This locks in
// the fix: /test-rcon must report the same two canonical detail strings and
// codes /rcon/test and /rcon/connect already use.

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function getTestRconHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/test-rcon" && entry.route.methods.post,
  );
  // LAST entry, not the first: requirePermission('server.configure') sits
  // ahead of the real handler, same shape as /rcon/connect and /rcon/test.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReq(rconService) {
  return {
    app: { get: (key) => (key === "rconService" ? rconService : undefined) },
  };
}

describe("POST /api/config/test-rcon granularity", () => {
  it('reports "unreachable" when the configured host:port cannot be reached', async () => {
    // Nothing listens on this loopback port in the test environment.
    const fakeRconService = {
      connect: async () => false,
      getConfig: () => ({ host: "127.0.0.1", port: 39823 }),
    };

    const res = createResponse();
    await getTestRconHandler()(makeReq(fakeRconService), res);

    expect(res.body).toEqual({
      success: false,
      error: "unreachable",
      detail: RCON_UNREACHABLE_DETAIL,
      message: RCON_UNREACHABLE_DETAIL,
      connected: false,
      code: "RCON_CONNECT_UNREACHABLE",
    });
  });

  it('reports "auth failed" when the host:port IS reachable but connect() still fails', async () => {
    // A bare TCP server that accepts the connection but never speaks RCON --
    // reachable by the follow-up probe, exactly the case that used to come
    // back as the same generic "Failed to connect to RCON" string as the
    // unreachable case above.
    const server = net.createServer((socket) => socket.on("data", () => {}));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;

    try {
      const fakeRconService = {
        connect: async () => false,
        getConfig: () => ({ host: "127.0.0.1", port }),
      };

      const res = createResponse();
      await getTestRconHandler()(makeReq(fakeRconService), res);

      expect(res.body).toEqual({
        success: false,
        error: "auth_failed",
        detail: RCON_AUTH_FAILED_DETAIL,
        message: RCON_AUTH_FAILED_DETAIL,
        connected: false,
        code: "RCON_CONNECT_AUTH_FAILED",
      });
    } finally {
      server.close();
    }
  });

  it("still reports success on a real connect() with a working command probe", async () => {
    const fakeRconService = {
      connect: async () => true,
      execute: async () => ({ success: true }),
      getConfig: () => ({ host: "127.0.0.1", port: 27015 }),
    };

    const res = createResponse();
    await getTestRconHandler()(makeReq(fakeRconService), res);

    expect(res.body).toEqual({
      success: true,
      message: "RCON connection successful",
      connected: true,
    });
  });
});
