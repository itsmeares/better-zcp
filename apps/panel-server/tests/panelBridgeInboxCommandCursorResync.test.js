import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.ts";


function makeTempBridgeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-inbox-resync-"));
}

describe("PanelBridge.tryResyncInboxCommandCursor", () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("catches nextCommandSeq up to Lua's lastCommandSeq WITHOUT a restart when Lua is ahead", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.nextCommandSeq = 42;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 106, nextResultSeq: 107 }),
    );

    const resynced = bridge.tryResyncInboxCommandCursor();

    expect(resynced).toBe(true);
    expect(bridge.queueState.nextCommandSeq).toBe(107);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".queue-state-node.json"), "utf-8"),
    );
    expect(persisted.nextCommandSeq).toBe(107);
  });

  it("does nothing when Node is already caught up or ahead (the normal case)", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.nextCommandSeq = 60;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 50, nextResultSeq: 51 }),
    );

    const resynced = bridge.tryResyncInboxCommandCursor();

    expect(resynced).toBe(false);
    expect(bridge.queueState.nextCommandSeq).toBe(60);
  });

  it("never lowers nextCommandSeq -- forward-only, so it can't undo real in-flight work", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.nextCommandSeq = 200;

    fs.writeFileSync(
      path.join(tmpDir, "queue-state-lua.json.txt"),
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 5, nextResultSeq: 6 }),
    );

    bridge.tryResyncInboxCommandCursor();

    expect(bridge.queueState.nextCommandSeq).toBe(200);
  });

  it("rate-limits itself so it doesn't re-read the state file on every call within the check interval", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.nextCommandSeq = 10;

    const luaStateFile = path.join(tmpDir, "queue-state-lua.json.txt");
    fs.writeFileSync(
      luaStateFile,
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 20, nextResultSeq: 21 }),
    );

    expect(bridge.tryResyncInboxCommandCursor()).toBe(true);
    expect(bridge.queueState.nextCommandSeq).toBe(21);

    fs.writeFileSync(
      luaStateFile,
      JSON.stringify({ protocolVersion: "queue-v1", lastCommandSeq: 999, nextResultSeq: 1000 }),
    );

    expect(bridge.tryResyncInboxCommandCursor()).toBe(false);
    expect(bridge.queueState.nextCommandSeq).toBe(21);
  });

  it("does nothing when Lua's state file does not exist yet", () => {
    tmpDir = makeTempBridgeDir();
    const bridge = new PanelBridge();
    bridge.configure(tmpDir, true);
    bridge.queueState.nextCommandSeq = 3;

    const resynced = bridge.tryResyncInboxCommandCursor();

    expect(resynced).toBe(false);
    expect(bridge.queueState.nextCommandSeq).toBe(3);
  });
});
