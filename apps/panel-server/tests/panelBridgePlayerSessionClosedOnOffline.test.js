import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-04, overnight bug hunt (Angela's fence: panelBridge*):
// trackPlayerActivity()'s connect/disconnect diffing (against
// this.previousPlayers) only ever ran from checkModStatus()'s own
// `if (status.alive && status.players)` branch -- a genuinely fresh, alive
// status read. Neither handleStatusFailure() (the mod-marked-offline-after-
// N-failures branch) nor stop() ever called it; both just wiped tracking
// state directly (modStatus.players = [] / previousPlayers = new Set()).
//
// That matters past the in-memory status: recordPlayerSession() only
// accumulates total_playtime_seconds on a "disconnect" call, setting
// last_session_start on "connect". With no "disconnect" ever recorded for a
// player connected at the moment the mod goes offline (server crash, hang,
// stop) or the bridge is stopped/reconfigured, that player's still-open
// session sits there and gets silently overwritten -- their elapsed
// playtime is dropped, with nothing anywhere indicating it happened. This
// isn't a rare edge case: it fires on every ordinary server crash, stop, or
// bridge reconfigure with anyone online.
//
// Fix: both call sites now call trackPlayerActivity([]) before wiping
// state, so every currently-tracked player gets a real "disconnect" (and
// the playtime it accumulates) instead of a silent drop.

const logPlayerAction = vi.fn(async () => {});
const recordPlayerSession = vi.fn(async () => {});
vi.mock("../database/init.js", () => ({
  logPlayerAction: (...args) => logPlayerAction(...args),
  recordPlayerSession: (...args) => recordPlayerSession(...args),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

beforeEach(() => {
  logPlayerAction.mockClear();
  recordPlayerSession.mockClear();
});

describe("PanelBridge closes out player sessions when the mod goes offline or the bridge stops", () => {
  it("handleStatusFailure() disconnects every tracked player once the failure threshold is reached", () => {
    const bridge = new PanelBridge();
    bridge.previousPlayers = new Set(["Alice", "Bob"]);
    bridge.modStatus = { alive: true, version: "1.0", players: ["Alice", "Bob"] };
    bridge.consecutiveFailures = bridge.maxConsecutiveFailures - 1;

    bridge.handleStatusFailure("Status file does not exist");

    expect(recordPlayerSession).toHaveBeenCalledWith("Alice", "disconnect");
    expect(recordPlayerSession).toHaveBeenCalledWith("Bob", "disconnect");
    expect(recordPlayerSession).not.toHaveBeenCalledWith(expect.anything(), "connect");
    expect(logPlayerAction).toHaveBeenCalledWith(
      "Alice",
      "disconnect",
      expect.any(String),
    );
    // previousPlayers must actually end up empty -- trackPlayerActivity's
    // own tail sets it, this isn't just checking the disconnect calls fired
    // in isolation from the state it's supposed to leave behind.
    expect(bridge.previousPlayers.size).toBe(0);
    expect(bridge.modStatus.alive).toBe(false);
  });

  it("does not fire disconnects below the failure threshold (no false alarm on a single missed read)", () => {
    const bridge = new PanelBridge();
    bridge.previousPlayers = new Set(["Alice"]);
    bridge.modStatus = { alive: true, version: "1.0", players: ["Alice"] };
    bridge.consecutiveFailures = 0;

    bridge.handleStatusFailure("transient read error");

    expect(recordPlayerSession).not.toHaveBeenCalled();
    expect(bridge.previousPlayers.has("Alice")).toBe(true);
  });

  it("stop() disconnects every tracked player instead of silently discarding their session", () => {
    const bridge = new PanelBridge();
    bridge.previousPlayers = new Set(["Carol"]);

    bridge.stop();

    expect(recordPlayerSession).toHaveBeenCalledWith("Carol", "disconnect");
    expect(bridge.previousPlayers.size).toBe(0);
  });

  it("stop() with no tracked players is a clean no-op (control)", () => {
    const bridge = new PanelBridge();
    bridge.previousPlayers = new Set();

    bridge.stop();

    expect(recordPlayerSession).not.toHaveBeenCalled();
    expect(logPlayerAction).not.toHaveBeenCalled();
  });
});
