import { describe, expect, it, vi } from "vitest";

// Covers the "12 unguarded files" sweep: routes that relied on the central
// login gate alone (any authenticated role reached them) now have an
// explicit role decision, one way or the other. The important property per
// god's brief is NOT just "a moderator is refused" -- a sweep that locks
// everything to admin passes every refusal test while quietly making
// technician and moderator useless. So every describe block below checks
// BOTH directions: the excluded role is refused, and the role that's
// supposed to be able to do the thing is NOT refused at the gate.

// routes/discord.js statically imports normalizeChatRelayScope from
// services/discordBot.js, which statically imports the "discord.js" package
// (+ @discordjs/* + undici under it) -- ~4.2MB of source that vitest has to
// transform and evaluate the first time anything in a test run does
// `await import("../routes/discord.js")`. Under whole-suite load that cold
// cost has been landing inside THIS test's own 5000ms budget rather than
// amortized into collection, producing an intermittent timeout that three
// different agents independently re-investigated tonight before finding out
// it was the same known cause each time (root-caused by Dwight). The role
// gate below has no legitimate reason to load a real Discord client at all
// -- it only inspects router.stack -- so stub the dependency out rather than
// just relocating the cost (e.g. to its own file, paid once elsewhere): the
// real fix here is that this test shouldn't be paying for discord.js at
// all, not that it should pay for it somewhere less visible.
// normalizeChatRelayScope itself is never exercised by a role-gate test
// (it's used inside a route handler, not the router.use() gate), so an
// identity stub is enough to satisfy the import without changing behavior
// this test could possibly observe.
vi.mock("../services/discordBot.js", () => ({
  normalizeChatRelayScope: vi.fn((value) => value),
}));

// discord.js/mods.js/scheduler.js/serverFiles.js/serverFinder.js/rcon.js now
// gate with requirePermission (DB-backed capability lookup) instead of
// requireRole (a pure role-name check) -- see mockPermissionsDb.js's header
// for why role resolution needs mocking at all now. players.js is
// deliberately untouched here: it still gates with requireRole pending its
// own moderate/gm_tools/view split, so this mock has no effect on it.
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
vi.mock("../database/init.js", () => ({
  getRoleByName: mockGetRoleByName,
}));

function createResponse() {
  const response = { status: () => response, json: () => response, set: () => response };
  let statusCode = 200;
  response.status = (code) => {
    statusCode = code;
    return response;
  };
  response.json = () => response;
  response.set = () => response;
  response.getStatusCode = () => statusCode;
  return response;
}

// For router.use(requireRole(...)) gates: grabs the first non-route layer
// (that's always where this sweep put its guard, ahead of any route-
// specific handler and, in serverFiles.js's case, ahead of that file's own
// pre-existing unconfigured-server gate too) and runs it directly.
//
// A real Express request always has path/url/method -- req.path is a
// getter derived from req.url, never undefined -- so a bare { user } object
// was never a faithful stand-in for one, just one that happened to work
// for every gate until mods.js's carve-out became the first to read
// anything besides req.user. Default the request-identity fields here
// instead of hand-rolling them at every call site, and let a caller
// override any of them (see the mods.js /thumbnail/ cases below) --
// fixing the double, not the production code it was misrepresenting
// (conv-mods-thumbnails: bb3e778's routeRoleSweep red gate).
function fakeRequest(req) {
  return { path: "/", url: "/", method: "GET", ...req };
}
async function runFirstUseLayer(router, req) {
  const res = createResponse();
  const layer = router.stack.find((entry) => !entry.route);
  let calledNext = false;
  await layer.handle(fakeRequest(req), res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

// For per-route requireRole(...) (rcon.js's mixed file): same
// route-stack-walking approach as roles.test.js.
function getRouteLayer(router, routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}
async function runRoute(router, routePath, method, req) {
  const res = createResponse();
  const layer = getRouteLayer(router, routePath, method);
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

describe("mods.js: admin+technician (mods/config is technician's job, not moderator's)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/mods.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/mods.js");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });

  // conv-mods-thumbnails (bb3e778): the two tests above prove the gate
  // refuses, but prove nothing about whether the /thumbnail/ carve-out is
  // actually narrow -- that it's scoped to one path, not a blanket bypass
  // of the router's role check. Even a role this describe block otherwise
  // refuses (moderator) must sail through on /thumbnail/, and the SAME
  // moderator must still be refused everywhere else -- the carve-out reads
  // req.path, not req.user, so this is the case that actually exercises
  // that branch. The HTTP-level test (modsThumbnailAuthGate.test.js) covers
  // the real end-to-end request (no req.user at all, via the real
  // authService.middleware()); this pins the same property at the unit
  // level, in the file the next person reading this sweep will look at to
  // learn what mods.js's gate does.
  it("does NOT refuse a moderator on /thumbnail/:id -- the deliberate path-based carve-out overrides the role gate entirely for this one route", async () => {
    const { default: router } = await import("../routes/mods.js");
    const { calledNext } = await runFirstUseLayer(router, {
      user: { role: "moderator" },
      path: "/thumbnail/123",
    });
    expect(calledNext).toBe(true);
  });
  it("still refuses that same moderator on every other path -- the carve-out is one route, not the whole router", async () => {
    const { default: router } = await import("../routes/mods.js");
    const { res } = await runFirstUseLayer(router, {
      user: { role: "moderator" },
      path: "/status",
    });
    expect(res.getStatusCode()).toBe(403);
  });
});

describe("discord.js: admin+technician (integration config, not player authority)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/discord.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/discord.js");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
  // Proof the stubbed discordBot.js dependency above didn't quietly disable
  // the gate: "moderator" and "technician" only diverge correctly if
  // requireRole() is doing a real allowlist check against req.user.role,
  // but a gate that was accidentally bypassed (e.g. by a mock that made
  // every request fall through to next()) could still coincidentally pass
  // both of those if this router's handlers happened to no-op for both
  // roles. A role that's neither admin nor technician, refused with 403,
  // is the case a bypassed gate could NOT produce by accident.
  it("refuses a role that isn't in the allow list at all, not just 'moderator' specifically", async () => {
    const { default: router } = await import("../routes/discord.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "definitely-not-a-real-role" } });
    expect(res.getStatusCode()).toBe(403);
  });
});

describe("scheduler.js: admin+technician (task automation operates the server)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/scheduler.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/scheduler.js");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

describe("serverFiles.js: admin+technician (config/backups), ahead of the file's own unconfigured-server gate", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/serverFiles.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/serverFiles.js");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

describe("serverFinder.js: admin+technician (setup/verification diagnostic)", () => {
  it("refuses a moderator", async () => {
    const { default: router } = await import("../routes/serverFinder.js");
    const { res } = await runFirstUseLayer(router, { user: { role: "moderator" } });
    expect(res.getStatusCode()).toBe(403);
  });
  it("does not refuse a technician", async () => {
    const { default: router } = await import("../routes/serverFinder.js");
    const { calledNext } = await runFirstUseLayer(router, { user: { role: "technician" } });
    expect(calledNext).toBe(true);
  });
});

// players.js used to be one blanket router.use(requireRole(admin,tech,mod)).
// Now split three ways per-route (players.moderate/gm_tools/view) -- see
// the comment at the top of routes/players.js for the full reasoning. All
// three default to admin+technician+moderator, so today's behavior is
// unchanged; this proves each of the three capabilities independently
// still lets every role through at the gate, one representative route per
// capability rather than all 37 (the full route-to-capability mapping is
// exhaustively covered by nothing else needing a test -- it's a straight
// value each route was assigned, not logic that can silently drift).
async function runFirstHandlerOnly(router, routePath, method, req) {
  const res = createResponse();
  const layer = getRouteLayer(router, routePath, method);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${routePath} route registered`);
  let calledNext = false;
  await layer.route.stack[0].handle(req, res, () => {
    calledNext = true;
  });
  return { res, calledNext };
}

describe("players.js: split into players.moderate/gm_tools/view, all still open to admin+technician+moderator", () => {
  const REPRESENTATIVE_ROUTES = [
    ["players.moderate", "/kick", "post"],
    ["players.gm_tools", "/teleport", "post"],
    ["players.view", "/", "get"],
  ];

  for (const [capability, routePath, method] of REPRESENTATIVE_ROUTES) {
    describe(`${capability} (${method.toUpperCase()} ${routePath})`, () => {
      for (const role of ["admin", "technician", "moderator"]) {
        it(`does not refuse a ${role}`, async () => {
          const { default: router } = await import("../routes/players.js");
          const { calledNext } = await runFirstHandlerOnly(router, routePath, method, {
            user: { role },
          });
          expect(calledNext).toBe(true);
        });
      }
    });
  }
});

describe("rcon.js: mixed -- /execute, connection lifecycle and /history are admin+technician, status/reference stays open to everyone", () => {
  const RESTRICTED = [
    ["/execute", "post"],
    ["/connect", "post"],
    ["/test", "post"],
    ["/disconnect", "post"],
    // /history looks like one more read-only reference route but isn't:
    // it returns the verbatim command_history log, which stores the exact
    // command string sent -- including e.g. a whitelist password from
    // `adduser "player" "password"`, or anything typed into /execute
    // itself. Was in OPEN below; fixed alongside the route (kevin,
    // bug-hunt pass) once that stopped being true.
    ["/history", "get"],
  ];
  const OPEN = [
    ["/status", "get"],
    ["/health", "get"],
    ["/commands", "get"],
    ["/commands/:category", "get"],
  ];

  it.each(RESTRICTED)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.js");
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      body: {},
      params: {},
      query: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(RESTRICTED)("does not refuse a technician at the gate on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.js");
    // Minimal stub so a technician reaching past the role gate exercises
    // real (if trivial) downstream logic instead of crashing on
    // `undefined.connect()` -- a crash isn't a 403 either, but a real
    // response proves the gate itself, not just an accident of the fake.
    const stubRconService = {
      connect: async () => false,
      disconnect: async () => {},
      execute: async () => ({ success: true, response: "" }),
      getUserFriendlyError: () => "stub error",
    };
    const res = await runRoute(router, routePath, method, {
      user: { role: "technician" },
      body: {},
      params: {},
      query: {},
      app: { get: () => stubRconService },
    });
    // 403 would mean the gate refused a technician; anything else means
    // the gate let them through, which is the only thing this checks.
    expect(res.getStatusCode()).not.toBe(403);
  });

  it.each(OPEN)("stays open to a moderator on %s %s (read-only, nothing sensitive)", async (routePath, method) => {
    const { default: router } = await import("../routes/rcon.js");
    const stubRconService = {
      getConfig: () => ({ host: "127.0.0.1", port: 27015 }),
      healthCheck: async () => ({ healthy: true }),
    };
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      body: {},
      params: {},
      query: {},
      app: { get: () => stubRconService },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });
});

describe("auth.js: recovery codes are admin-only, not delegable to users.manage or any other role", () => {
  // generateRecoveryCodes()/getRecoveryCodeStatus()/resetPassword()
  // (services/auth.js) don't operate on the CALLER's own account -- they
  // always target "the" admin account. Before this gate, POST here only
  // checked "is this a valid token for ANY account" -- so a moderator or
  // technician using nothing but their own ordinary login could pull fresh
  // PLAINTEXT admin recovery codes and use one (via the unauthenticated
  // POST /recover-with-code) to set the admin account's own password.
  // Fixed alongside the route (kevin, bug-hunt pass).
  const ROUTES = [
    ["/recovery-codes", "get"],
    ["/recovery-codes", "post"],
  ];

  it.each(ROUTES)("refuses a moderator on %s %s", async (routePath, method) => {
    const { default: router } = await import("../routes/auth.js");
    const res = await runRoute(router, routePath, method, {
      user: { role: "moderator" },
      headers: {},
      body: {},
      params: {},
      query: {},
    });
    expect(res.getStatusCode()).toBe(403);
  });

  it.each(ROUTES)(
    "refuses a technician too on %s %s -- users.manage-adjacent is not enough, this is admin-only",
    async (routePath, method) => {
      const { default: router } = await import("../routes/auth.js");
      const res = await runRoute(router, routePath, method, {
        user: { role: "technician" },
        headers: {},
        body: {},
        params: {},
        query: {},
      });
      expect(res.getStatusCode()).toBe(403);
    },
  );

  it.each(ROUTES)(
    "does not refuse an admin at the role gate on %s %s (a missing Authorization header still 401s downstream -- this only proves the gate itself let an admin through)",
    async (routePath, method) => {
      const { default: router } = await import("../routes/auth.js");
      const res = await runRoute(router, routePath, method, {
        user: { role: "admin" },
        headers: {},
        body: {},
        params: {},
        query: {},
      });
      expect(res.getStatusCode()).not.toBe(403);
    },
  );
});

describe("mapProxy.js / serverStatus.js / system.js: deliberately open to every role", () => {
  it("mapProxy /resolve and /vehicles do not refuse a moderator", async () => {
    const { default: router } = await import("../routes/mapProxy.js");
    for (const [routePath, method] of [
      ["/resolve", "get"],
      ["/vehicles", "get"],
    ]) {
      const res = await runRoute(router, routePath, method, {
        user: { role: "moderator" },
        params: {},
        query: {},
        app: { get: () => undefined },
      });
      expect(res.getStatusCode()).not.toBe(403);
    }
  });

  it("serverStatus GET /active/status does not refuse a moderator", async () => {
    const { default: router } = await import("../routes/serverStatus.js");
    const res = await runRoute(router, "/active/status", "get", {
      user: { role: "moderator" },
      app: { get: () => undefined },
    });
    expect(res.getStatusCode()).not.toBe(403);
  });

  it("system GET /disk-space and /storage-health do not refuse a moderator", async () => {
    const { default: router } = await import("../routes/system.js");
    for (const [routePath, method] of [
      ["/disk-space", "get"],
      ["/storage-health", "get"],
    ]) {
      const res = await runRoute(router, routePath, method, {
        user: { role: "moderator" },
        app: { get: () => undefined },
      });
      expect(res.getStatusCode()).not.toBe(403);
    }
  });
});
