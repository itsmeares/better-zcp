import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.js";


function makeTempBridgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-outbox-resync-"));
}

function armStuckGate(bridge, seq) {
  const first = bridge.tryResyncOutboxCursor(seq);
  expect(first).toBe(false);
  bridge.outboxStuckState.nextCheckAt = 0;
}

describe("PanelBridge.tryResyncOutboxCursor", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resyncs lastConsumedResultSeq forward when Lua is genuinely ahead", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 5;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 51 }),
    );

    armStuckGate(bridge, 6);
    const resynced = bridge.tryResyncOutboxCursor(6);

    expect(resynced).toBe(true);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(50);
  });

  it("never lowers lastConsumedResultSeq -- forward-only, so a stale/racing read of Lua's state file can't manufacture a stall", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 500;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 50 }),
    );

    armStuckGate(bridge, 501);
    const resynced = bridge.tryResyncOutboxCursor(501);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(500);
  });

  it("does nothing when already in sync (genuinely idle)", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 10;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 0, nextResultSeq: 11 }),
    );

    armStuckGate(bridge, 11);
    const resynced = bridge.tryResyncOutboxCursor(11);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(10);
  });

  it("does nothing when Lua's state file does not exist yet", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.lastConsumedResultSeq = 3;

    armStuckGate(bridge, 4);
    const resynced = bridge.tryResyncOutboxCursor(4);

    expect(resynced).toBe(false);
    expect(bridge.queueState.lastConsumedResultSeq).toBe(3);
  });
});
