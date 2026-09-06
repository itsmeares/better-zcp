import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.js";

// 2026-08-30 bridge-queue-timing investigation: ensureQueueProtocol()'s
// Math.max reconciliation against Lua's queue-state-lua.json only ever runs
// ONCE per process lifetime (gated by queueState.initialized, checked at
// bridge start) -- after that, nextCommandSeq lives purely in memory,
// incremented one command at a time, with nothing to notice if Lua's cursor
// moves past it because a DIFFERENT process (another panel instance pointed
// at the same bridge folder) wrote some of those commands. Confirmed live on
// pz-verify: four processes sharing one bridge folder left Node's counter at
// 42 while Lua had genuinely processed through 106, and every command Node
// wrote from then on reused an already-consumed sequence number Lua's cursor
// had long since passed -- silently discarded until Node's own 15s
// commandTimeoutMs gave up. tryResyncInboxCommandCursor() generalizes the
// same Math.max logic to run periodically (mirroring tryResyncOutboxCursor's
// shape for the opposite direction) so this can be caught and corrected
// without a restart.

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

    // Persisted, not just corrected in memory -- a subsequent process restart
    // must also see the caught-up value.
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

    // Lua races further ahead immediately after -- a real desync that a
    // second check right away WOULD catch, but shouldn't be probed for
    // this soon (avoids hammering the filesystem on every 150ms poll).
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
