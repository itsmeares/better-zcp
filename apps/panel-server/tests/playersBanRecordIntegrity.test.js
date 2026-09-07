import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();
const addSteamIdBan = vi.fn();
const removeSteamIdBan = vi.fn();

vi.mock("../database/init.js", () => ({
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote: vi.fn(),
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan,
  removeSteamIdBan,
  getActiveServer: vi.fn(),
}));

vi.mock("../services/panelBridge.js", () => ({
  default: { isRunning: false, sendCommand: vi.fn() },
}));

const { default: router } = await import("../routes/players.ts");

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createRequest(body, rconService) {
  return { body, app: { get: () => rconService } };
}

describe("players routes: persistent records only written on RCON success", () => {
  beforeEach(() => {
    logPlayerAction.mockReset();
    addSteamIdBan.mockReset();
    removeSteamIdBan.mockReset();
  });

  describe("POST /banid", () => {
    const steamId = "12345678901234567";

    it("adds the SteamID ban and logs the action when RCON succeeds", async () => {
      const rconService = {
        banSteamId: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/banid")(
        createRequest({ steamId, reason: "griefing" }, rconService),
        response,
      );

      expect(addSteamIdBan).toHaveBeenCalledWith(steamId, "griefing");
      expect(logPlayerAction).toHaveBeenCalledWith(steamId, "banid", "griefing");
      expect(response.json).toHaveBeenCalledWith({ success: true, response: "ok" });
    });

    it("does NOT add the SteamID ban or log the action when RCON reports failure (server offline)", async () => {
      const rconService = {
        banSteamId: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/banid")(
        createRequest({ steamId, reason: "griefing" }, rconService),
        response,
      );

      expect(addSteamIdBan).not.toHaveBeenCalled();
      expect(logPlayerAction).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: "Server is not running",
      });
    });
  });

  describe("POST /unbanid", () => {
    const steamId = "12345678901234567";

    it("removes the SteamID ban and logs the action when RCON succeeds", async () => {
      const rconService = {
        unbanSteamId: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/unbanid")(
        createRequest({ steamId }, rconService),
        response,
      );

      expect(removeSteamIdBan).toHaveBeenCalledWith(steamId);
      expect(logPlayerAction).toHaveBeenCalledWith(steamId, "unbanid", null);
    });

    it("does NOT remove the SteamID ban when RCON reports failure -- the panel must not claim someone is unbanned when the server still enforces it", async () => {
      const rconService = {
        unbanSteamId: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/unbanid")(
        createRequest({ steamId }, rconService),
        response,
      );

      expect(removeSteamIdBan).not.toHaveBeenCalled();
      expect(logPlayerAction).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: "Server is not running",
      });
    });
  });

  describe("POST /ban", () => {
    it("rejects a string banIp flag instead of treating false as true", async () => {
      const banPlayer = vi.fn();
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest(
          { username: "Bob", banIp: "false", reason: "griefing" },
          { banPlayer },
        ),
        response,
      );

      expect(response.status).toHaveBeenCalledWith(400);
      expect(banPlayer).not.toHaveBeenCalled();
    });

    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        banPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", banIp: false, reason: "griefing" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith(
        "Bob",
        "ban",
        "IP: false, Reason: griefing",
      );
    });

    it("does not log the action when RCON reports failure (server offline)", async () => {
      const rconService = {
        banPlayer: vi.fn(async () => ({
          success: false,
          error: "Server is not running",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", banIp: false, reason: "griefing" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith({
        success: false,
        error: "Server is not running",
      });
    });

    it("logs sentReason (what RCON actually received), not the raw requested reason, when they differ", async () => {
      const rconService = {
        banPlayer: vi.fn(async () => ({
          success: true,
          response: "ok",
          sentReason: "repete",
        })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", banIp: false, reason: "répété" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith(
        "Bob",
        "ban",
        "IP: false, Reason: repete",
      );
    });

    it("falls back to the raw reason if banPlayer() doesn't return sentReason at all", async () => {
      const rconService = {
        banPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/ban")(
        createRequest({ username: "Bob", banIp: false, reason: "griefing" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith(
        "Bob",
        "ban",
        "IP: false, Reason: griefing",
      );
    });
  });

  describe("POST /unban", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        unbanPlayer: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/unban")(
        createRequest({ username: "Bob" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "unban", null);
    });

    it("does not log the action when RCON reports failure", async () => {
      const rconService = {
        unbanPlayer: vi.fn(async () => ({ success: false, error: "Server is not running" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/unban")(
        createRequest({ username: "Bob" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /voiceban", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        voiceBan: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/voiceban")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "voiceban", "enabled");
    });

    it("does not log the action when RCON reports failure", async () => {
      const rconService = {
        voiceBan: vi.fn(async () => ({ success: false, error: "Server is not running" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/voiceban")(
        createRequest({ username: "Bob", enabled: true }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /adduser (already correct — regression guard only)", () => {
    it("logs the action when RCON succeeds", async () => {
      const rconService = {
        addUser: vi.fn(async () => ({ success: true, response: "ok" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/adduser")(
        createRequest({ username: "Bob" }, rconService),
        response,
      );

      expect(logPlayerAction).toHaveBeenCalledWith("Bob", "adduser", null);
    });

    it("does not log the action when RCON reports failure, and responds 400", async () => {
      const rconService = {
        addUser: vi.fn(async () => ({ success: false, error: "Server is not running" })),
      };
      const response = createResponse();

      await getRouteHandler("post", "/adduser")(
        createRequest({ username: "Bob" }, rconService),
        response,
      );

      expect(logPlayerAction).not.toHaveBeenCalled();
      expect(response.status).toHaveBeenCalledWith(400);
    });
  });
});
