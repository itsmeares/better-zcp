import { beforeEach, describe, expect, it, vi } from "vitest";

// GET /debug/activity merges RCON/bridge/server history with full player
// moderation history (getPlayerLogs) into one feed, gated ONLY by
// diagnostics.manage. Found in the 2026-08-26 capability-description sweep:
// diagnostics.manage's label ("View logs, performance history, database
// maintenance tools and CORS diagnostics") never mentions player history --
// that's players.view's own territory ("Read player details, status and
// history"). Among the three SEEDED roles this was moot (diagnostics.manage
// is admin-only), but a custom role built from the label alone (any admin
// can make one via roles.manage) could hold diagnostics.manage without
// players.view and still read every player's ban/kick/teleport/item-spawn
// history through this door.
//
// Fix: an inline players.view check, resolved only when a player source
// could actually appear. source=player without it is a refusal (the caller
// asked for something they don't hold); source=all without it silently
// omits the player entries rather than refusing the whole feed.

const getCommandHistory = vi.fn(async () => []);
const getBridgeLogs = vi.fn(async () => []);
const getPlayerLogs = vi.fn(async () => [
  { id: 1, action: "kick", player_name: "Bob", details: "griefing", logged_at: "2026-08-27T00:00:00.000Z" },
]);
const getDb = vi.fn(async () => ({ data: { server_events: [] } }));

const ROLES = {
  admin: { capabilities: ["diagnostics.manage", "players.view"] },
  // Holds diagnostics.manage (passes the route's own gate) and NOTHING
  // else -- the exact custom-role shape this fix exists to stop.
  diagnostics_only: { capabilities: ["diagnostics.manage"] },
};
const getRoleByName = vi.fn(async (name) => ROLES[name] || null);

vi.mock("../database/init.js", async () => {
  const actual = await vi.importActual("../database/init.js");
  return {
    ...actual,
    getCommandHistory,
    getBridgeLogs,
    getPlayerLogs,
    getDb,
    getRoleByName,
  };
});

const { default: router } = await import("../routes/debug.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getLayer(routePath, method) {
  return router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runActivity(query, role) {
  const layer = getLayer("/activity", "get");
  const handlers = layer.route.stack.map((s) => s.handle);
  const response = createResponse();
  const request = { query, user: { role } };
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](request, response, next);
  };
  await next();
  return response;
}

describe("GET /debug/activity -- player history requires players.view in addition to diagnostics.manage", () => {
  beforeEach(() => {
    getCommandHistory.mockClear();
    getBridgeLogs.mockClear();
    getPlayerLogs.mockClear();
    getDb.mockClear();
    getRoleByName.mockClear();
  });

  it("refuses source=player for a caller who holds diagnostics.manage but not players.view", async () => {
    const response = await runActivity({ source: "player" }, "diagnostics_only");

    expect(response.status).toHaveBeenCalledWith(403);
    expect(getPlayerLogs).not.toHaveBeenCalled();
  });

  it("allows source=player for a caller who also holds players.view", async () => {
    const response = await runActivity({ source: "player" }, "admin");

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(getPlayerLogs).toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.entries.some((e) => e.source === "player")).toBe(true);
  });

  it("source=all for a diagnostics.manage-only caller returns the rest of the feed with player entries silently omitted, not a 403", async () => {
    const response = await runActivity({ source: "all" }, "diagnostics_only");

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(getPlayerLogs).not.toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.entries.some((e) => e.source === "player")).toBe(false);
  });

  it("source=all for a caller holding both capabilities includes player entries", async () => {
    const response = await runActivity({ source: "all" }, "admin");

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(getPlayerLogs).toHaveBeenCalled();
    const payload = response.json.mock.calls[0][0];
    expect(payload.entries.some((e) => e.source === "player")).toBe(true);
  });

  it("source=rcon doesn't touch player logs, and only resolves the role once (the router's own diagnostics.manage gate, not a second lookup for players.view)", async () => {
    await runActivity({ source: "rcon" }, "diagnostics_only");

    expect(getRoleByName).toHaveBeenCalledTimes(1);
    expect(getPlayerLogs).not.toHaveBeenCalled();
  });
});
