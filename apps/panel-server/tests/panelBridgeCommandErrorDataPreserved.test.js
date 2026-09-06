import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Bug hunt 2026-08-31: services/panelBridge.js's processResult() attaches a
// rich soft-failure diagnostic table to the rejected Error's `.data`
// specifically so "a caller that wants the diagnostics can get them" (its
// own comment, added alongside runEventSequence's honest per-step results).
// Three route catch blocks in THIS file built their error response from
// error.message alone and threw the table away at the route boundary:
// POST /command (the generic passthrough, reached by ~30 actions with no
// dedicated route), POST /players/:username/teleport (a live client path --
// apps/panel-client/src/lib/api.ts's teleportPlayerBridge), and POST /players/:username
// /kill (also live -- killPlayer). apps/panel-client/src/lib/api.ts's ApiError.data is
// the ENTIRE parsed response body (buildResponseError), so the fields below
// are asserted flat at the top level of the JSON response, NOT nested under
// a `data:` key -- nesting would have put the table at error.data.data,
// one level deeper than every consumer (getRecoveryUrl's fixUrl read,
// Events.tsx's isEventSequenceResultData) expects.

const getActiveServer = vi.fn(async () => null);
const logBridgeCommand = vi.fn(async () => {});
const getRoleByName = vi.fn(async () => ({ capabilities: ["bridge.command", "players.gm_tools"] }));

vi.mock("../database/init.js", () => ({
  getActiveServer,
  getServer: vi.fn(),
  getAllSettings: vi.fn(async () => ({})),
  setSetting: vi.fn(),
  getDb: vi.fn(),
  commitNow: vi.fn(),
  logBridgeCommand,
  getRoleByName,
}));

const { default: bridge } = await import("../services/panelBridge.js");
const { default: router } = await import("../routes/panelBridge.js");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(routePath, method) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function diagnosticError(message, data) {
  const err = new Error(message);
  err.data = data;
  return err;
}

describe("PanelBridge route catches preserve error.data (the soft-failure diagnostic table)", () => {
  beforeEach(() => {
    bridge.isRunning = true;
    bridge.bridgePath = "/fake/bridge/path";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.isRunning = false;
    bridge.bridgePath = null;
  });

  describe("POST /command", () => {
    it("spreads error.data flat into the 500/unknown response, not nested under a data key", async () => {
      const table = { message: "3 of 10 steps failed", executed: 10, maxSteps: 10, failedCount: 3, results: [] };
      vi.spyOn(bridge, "sendCommand").mockRejectedValue(
        diagnosticError("3 of 10 steps failed", table),
      );

      const res = createResponse();
      await getHandler("/command", "post")(
        { user: { role: "admin" }, body: { action: "runEventSequence", args: {} } },
        res,
        () => {},
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.category).toBe("unknown");
      expect(body.error).toBe("3 of 10 steps failed");
      // Flat, not nested -- body.data would be undefined if this regressed
      // to the nested shape.
      expect(body.executed).toBe(10);
      expect(body.failedCount).toBe(3);
      expect(body.results).toEqual([]);
      expect(body.data).toBeUndefined();
    });

    it("does NOT add any extra fields for a genuine transport failure with no .data (control -- proves this is additive, not a shape change for the common case)", async () => {
      vi.spyOn(bridge, "sendCommand").mockRejectedValue(new Error("Bridge not running"));

      const res = createResponse();
      await getHandler("/command", "post")(
        { user: { role: "admin" }, body: { action: "teleportPlayer", args: {} } },
        res,
        () => {},
      );

      expect(res.status).toHaveBeenCalledWith(503);
      const body = res.json.mock.calls[0][0];
      expect(Object.keys(body).sort()).toEqual(["category", "error"]);
    });

    it("does not let a diagnostic table's own `error`/`category`-named field clobber the route's own values", async () => {
      vi.spyOn(bridge, "sendCommand").mockRejectedValue(
        diagnosticError("Command failed", { error: "should not win", category: "should not win either", message: "real detail" }),
      );

      const res = createResponse();
      await getHandler("/command", "post")(
        { user: { role: "admin" }, body: { action: "runEventSequence", args: {} } },
        res,
        () => {},
      );

      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe("Command failed");
      expect(body.category).toBe("unknown");
      expect(body.message).toBe("real detail");
    });
  });

  describe("POST /players/:username/teleport", () => {
    it("preserves teleportPlayer's verify-false diagnostic table (verifyPosition etc.) instead of the bare 'Teleport failed' string alone", async () => {
      vi.spyOn(bridge, "teleportPlayer").mockRejectedValue(
        diagnosticError("Teleport did not take effect", {
          verifyPosition: { x: 100, y: 100, z: 0 },
          newPosition: { x: 5000, y: 6000, z: 0 },
        }),
      );

      const res = createResponse();
      await getHandler("/players/:username/teleport", "post")(
        { user: { role: "admin" }, params: { username: "Survivor" }, body: { x: 5000, y: 6000, z: 0 } },
        res,
        () => {},
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe("Teleport failed"); // unchanged wording, own message intentionally not error.message here
      expect(body.verifyPosition).toEqual({ x: 100, y: 100, z: 0 });
      expect(body.newPosition).toEqual({ x: 5000, y: 6000, z: 0 });
    });
  });

  describe("POST /players/:username/kill", () => {
    it("preserves killPlayer's not-dead diagnostic table instead of discarding it", async () => {
      vi.spyOn(bridge, "sendCommand").mockRejectedValue(
        diagnosticError("Player still alive after kill", { stillAlive: true, health: 12 }),
      );

      const res = createResponse();
      await getHandler("/players/:username/kill", "post")(
        { user: { role: "admin" }, params: { username: "Survivor" }, body: {} },
        res,
        () => {},
      );

      expect(res.status).toHaveBeenCalledWith(500);
      const body = res.json.mock.calls[0][0];
      expect(body.error).toBe("Player still alive after kill");
      expect(body.stillAlive).toBe(true);
      expect(body.health).toBe(12);
    });
  });
});
