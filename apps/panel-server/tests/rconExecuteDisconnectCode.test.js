import { describe, expect, it, vi } from "vitest";
import { ErrorCode } from "../utils/errorCodes.js";

// 2026-08-30, rcon-disconnect-detection-matches-prose-not-codes: Oscar's
// audit found the client (apps/panel-client/src/pages/Console.tsx's
// RCON_DISCONNECT_PHRASES / isRconDisconnectError) detected an RCON
// disconnect by substring-matching a hand-maintained copy of
// RconService.getUserFriendlyError()'s prose -- and the two had already
// silently drifted once: "Server is not running" was reworded here to
// "Game server is not running." and the client's case-sensitive phrase
// list missed it (5 of 6 outputs still round-tripped; that one didn't).
// Fix: attach ErrorCode.RCON_EXECUTE_DISCONNECTED alongside the prose, from
// the SAME classification table getUserFriendlyError() reads, so client
// detection checks a code that can't drift out of sync with itself the way
// two independently-maintained strings could. This file proves the server
// side of that: every one of the six real disconnect outcomes gets the
// code, the one deliberately-not-a-disconnect outcome (authentication
// failure) does NOT, and neither does an unrecognized error.
vi.mock("../database/init.js", () => ({
  getActiveServer: async () => null,
  getSetting: async () => null,
  setSetting: async () => {},
  logCommand: () => {},
}));

const { RconService } = await import("../services/rcon.js");

describe("RconService: getUserFriendlyError() / getRconDisconnectCode() classify from the same table", () => {
  const service = new RconService();

  // [raw input substring, expected friendly prose] -- the six outcomes
  // Oscar's audit confirmed the client's phrase list was built to match,
  // straight from the real classifier's own branches.
  const DISCONNECT_CASES = [
    [
      "connect ECONNREFUSED 127.0.0.1:27015",
      "Cannot connect to server. Is the game server running with RCON enabled?",
    ],
    [
      "read ETIMEDOUT",
      "Connection timed out. Server may be unresponsive or firewall is blocking.",
    ],
    [
      "socket hang up ECONNRESET",
      "Connection was reset. Server may have restarted or crashed.",
    ],
    [
      "Max reconnection attempts reached",
      "Could not reconnect after multiple attempts. Server may be offline.",
    ],
    [
      "not connected to server",
      "Not connected to server. Please check if server is running.",
    ],
    [
      "Server is not running",
      "Game server is not running.",
    ],
  ];

  it.each(DISCONNECT_CASES)(
    "classifies %j as a disconnect: RCON_EXECUTE_DISCONNECTED code, matching prose",
    (raw, expectedMessage) => {
      expect(service.getUserFriendlyError(raw)).toBe(expectedMessage);
      expect(service.getRconDisconnectCode(raw)).toBe(
        ErrorCode.RCON_EXECUTE_DISCONNECTED,
      );
    },
  );

  it("does NOT classify an authentication failure as a disconnect -- a wrong password is not a dropped connection", () => {
    const raw = "RCON authentication failed: bad password";
    expect(service.getUserFriendlyError(raw)).toBe(
      "Authentication failed. Check RCON password in server settings.",
    );
    expect(service.getRconDisconnectCode(raw)).toBeNull();
  });

  it("does not classify an unrecognized error as a disconnect", () => {
    const raw = "some totally unrelated RCON error";
    expect(service.getUserFriendlyError(raw)).toBe(raw);
    expect(service.getRconDisconnectCode(raw)).toBeNull();
  });

  it("returns null (not a code) for an empty/undefined error message, matching getUserFriendlyError()'s own empty-input guard", () => {
    expect(service.getUserFriendlyError(undefined)).toBe(
      "Unknown error occurred",
    );
    expect(service.getRconDisconnectCode(undefined)).toBeNull();
  });
});

describe("RconService.execute(): the code actually reaches the response object callers forward to the client", () => {
  it("attaches RCON_EXECUTE_DISCONNECTED when connect() resolves false (the 'server is not running' early return, which bypasses getUserFriendlyError entirely)", async () => {
    const service = new RconService();
    service.connected = false;
    service.serverStarting = false;
    service.connect = vi.fn().mockResolvedValue(false);

    const result = await service.execute("players", {
      skipLog: true,
      retryOnConnectionError: true,
    });

    expect(result).toEqual({
      success: false,
      error: "Server is not running",
      code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
    });
  });

  // Regression (2026-08-31 services sweep): this branch used to return
  // {success:false, error:"RCON reconnection failed"} with no `code` at
  // all, unlike every sibling disconnect return in this function. reconnect()
  // resolving without throwing but genuinely failing to reestablish a
  // connection (retries exhausted, server still offline) is an ordinary,
  // common outcome -- not an edge case -- so Console.tsx's dropped-connection
  // banner used to silently never appear for it.
  it("attaches RCON_EXECUTE_DISCONNECTED when reconnect() resolves without throwing but genuinely fails to reconnect", async () => {
    const service = new RconService();
    service.connected = true;
    service.serverStarting = false;
    service.client = {
      execute: vi.fn().mockRejectedValue(new Error("socket hang up ECONNRESET")),
    };
    service.reconnect = vi.fn().mockResolvedValue(false);

    const result = await service.execute("players", {
      skipLog: true,
      retryOnConnectionError: true,
    });

    expect(service.reconnect).toHaveBeenCalledOnce();
    expect(result).toEqual({
      success: false,
      error: "RCON reconnection failed",
      code: ErrorCode.RCON_EXECUTE_DISCONNECTED,
      commandSent: true,
      transportError: true,
    });
  });

  it("attaches null (not RCON_EXECUTE_DISCONNECTED) for a real authentication failure reaching the main catch block", async () => {
    const service = new RconService();
    service.connected = true;
    service.serverStarting = false;
    service.client = {
      execute: vi.fn().mockRejectedValue(new Error("RCON authentication failed: bad password")),
    };

    const result = await service.execute("players", { skipLog: true });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "Authentication failed. Check RCON password in server settings.",
    );
    expect(result.code).toBeNull();
  });
});
