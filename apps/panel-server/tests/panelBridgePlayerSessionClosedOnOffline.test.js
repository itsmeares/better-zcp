import { describe, it, expect, vi, beforeEach } from "vitest";


const logPlayerAction = vi.fn(async () => {});
const recordPlayerSession = vi.fn(async () => {});
vi.mock("../database/init.js", () => ({
  logPlayerAction: (...args) => logPlayerAction(...args),
  recordPlayerSession: (...args) => recordPlayerSession(...args),
}));

const { PanelBridge } = await import("../services/panelBridge.ts");

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
