import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.ts";


function makeTempBridgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-outbox-recover-"));
}

function armStuckGate(bridge, seq) {
  expect(bridge.tryResyncOutboxCursor(seq)).toBe(false);
  bridge.outboxStuckState.nextCheckAt = 0;
}

function writeResultFile(tmpDir, seq, result) {
  const fileName = `res-${String(seq).padStart(10, "0")}.json.txt`;
  fs.writeFileSync(
    path.join(tmpDir, "outbox", fileName),
    JSON.stringify({ protocolVersion: "queue-v1", seq, result }),
  );
}

describe("PanelBridge.tryResyncOutboxCursor -- recovers results skipped by a resync jump", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves a still-pending command whose real result sits in the gap the resync is about to skip", () => {
    tmpDir = makeTempBridgeDir();
    fs.mkdirSync(path.join(tmpDir, "outbox"), { recursive: true });
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 5;

    const resolve = vi.fn();
    const reject = vi.fn();
    bridge.pendingCommands.set("cmd-A", {
      resolve, reject, action: "teleportPlayer", timeout: setTimeout(() => {}, 0), timestamp: Date.now(),
    });
    writeResultFile(tmpDir, 6, { id: "cmd-A", success: true, data: { message: "Player teleported" } });

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 11 }),
    );

    armStuckGate(bridge, 6);
    const resynced = bridge.tryResyncOutboxCursor(6);

    expect(resynced).toBe(true);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(10);
    expect(resolve).toHaveBeenCalledWith({ success: true, data: { message: "Player teleported" } });
    expect(reject).not.toHaveBeenCalled();
    expect(bridge.pendingCommands.has("cmd-A")).toBe(false);

    clearTimeout(bridge.pendingCommands.get("cmd-A")?.timeout);
  });

  it("skips a seq in the gap with no file at all -- nothing to recover, no error", () => {
    tmpDir = makeTempBridgeDir();
    fs.mkdirSync(path.join(tmpDir, "outbox"), { recursive: true });
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 5;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 11 }),
    );

    armStuckGate(bridge, 6);
    expect(() => bridge.tryResyncOutboxCursor(6)).not.toThrow();
    expect(bridge.queueState.lastConsumedResultSeq).toBe(10);
  });

  it("bounds the gap scan to retainRecentFiles so a huge stale gap cannot block on thousands of existsSync calls", () => {
    tmpDir = makeTempBridgeDir();
    fs.mkdirSync(path.join(tmpDir, "outbox"), { recursive: true });
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 0;
    bridge.queue.retainRecentFiles = 5;

    writeResultFile(tmpDir, 2, { id: "cmd-old", success: true, data: {} });
    const resolveOld = vi.fn();
    bridge.pendingCommands.set("cmd-old", {
      resolve: resolveOld, reject: vi.fn(), action: "ping", timeout: setTimeout(() => {}, 0), timestamp: Date.now(),
    });

    writeResultFile(tmpDir, 999, { id: "cmd-recent", success: true, data: {} });
    const resolveRecent = vi.fn();
    bridge.pendingCommands.set("cmd-recent", {
      resolve: resolveRecent, reject: vi.fn(), action: "ping", timeout: setTimeout(() => {}, 0), timestamp: Date.now(),
    });

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 1001 }),
    );

    armStuckGate(bridge, 1);
    bridge.tryResyncOutboxCursor(1);

    expect(resolveOld).not.toHaveBeenCalled();
    expect(resolveRecent).toHaveBeenCalledWith({ success: true, data: {} });

    clearTimeout(bridge.pendingCommands.get("cmd-old")?.timeout);
    clearTimeout(bridge.pendingCommands.get("cmd-recent")?.timeout);
  });
});
