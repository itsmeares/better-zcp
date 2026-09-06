import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 2026-09-02, destructive-guards-sweep: cleanupInboxFiles/cleanupOutboxFiles
// used to unlink every *.tmp file they found in the bridge's inbox/outbox
// directories with NO guard at all -- no age check, no liveness check.
// Both sides of the queue go through a temp-then-rename atomic-write
// pattern (the panel's own inbox writes via writeFileSync+renameSync; the
// mod's outbox writes are documented in panelBridge.js as producing
// "orphaned .tmp files from interrupted atomic writes", implying a *.tmp
// file mid-write is routine, not just a rare crash artifact), so an
// unconditional unlink can delete a file a writer is still mid-write on --
// silently dropping a queued command or its result. Same defect shape as
// database/init.js's db.json.*.tmp sweep (single-signal-sweep-2026-09-02):
// a deletion gated on nothing (or a wrong-direction probe) is a data-loss
// bug even if it has never fired. Fixed with an age gate matching
// database/init.js's MIN_ORPHAN_AGE_MS convention -- see panelBridge.js's
// isOldEnoughToSweep()/MIN_ORPHAN_TMP_AGE_MS.

const { PanelBridge } = await import("../services/panelBridge.js");

function makeBridge() {
  const bridgePath = fs.mkdtempSync(
    path.join(os.tmpdir(), "panelbridge-tmp-sweep-"),
  );
  const bridge = new PanelBridge();
  bridge.configure(bridgePath, true);
  bridge.ensureQueueProtocol();
  return { bridge, bridgePath };
}

function writeAgedTmpFile(dir, name, ageMs) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, "partial-write-in-progress");
  if (ageMs > 0) {
    const old = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, old, old);
  }
  return filePath;
}

// One full cleanupIntervalMs (60s) with margin -- mirrors
// apps/panel-server/tests/db-tmp-cleanup.test.js's OLD_ENOUGH_MS pattern.
const OLD_ENOUGH_MS = 90_000;

describe("PanelBridge.cleanupInboxFiles: .tmp sweep age guard", () => {
  let bridgePath;

  afterEach(() => {
    if (bridgePath) fs.rmSync(bridgePath, { recursive: true, force: true });
    bridgePath = undefined;
  });

  it("does NOT remove a fresh .tmp file -- it may still be mid-write", () => {
    const { bridge, bridgePath: dir } = makeBridge();
    bridgePath = dir;
    const filePath = writeAgedTmpFile(bridge.getInboxDir(), "cmd-0000000001.json.tmp", 0);

    bridge.cleanupInboxFiles();

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("removes a .tmp file once it is old enough to be sure it's orphaned", () => {
    const { bridge, bridgePath: dir } = makeBridge();
    bridgePath = dir;
    const filePath = writeAgedTmpFile(
      bridge.getInboxDir(),
      "cmd-0000000001.json.tmp",
      OLD_ENOUGH_MS,
    );

    bridge.cleanupInboxFiles();

    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe("PanelBridge.cleanupOutboxFiles: .tmp sweep age guard", () => {
  let bridgePath;

  afterEach(() => {
    if (bridgePath) fs.rmSync(bridgePath, { recursive: true, force: true });
    bridgePath = undefined;
  });

  it("does NOT remove a fresh .tmp file -- it may still be mid-write", () => {
    const { bridge, bridgePath: dir } = makeBridge();
    bridgePath = dir;
    const filePath = writeAgedTmpFile(bridge.getOutboxDir(), "res-0000000001.json.tmp", 0);

    bridge.cleanupOutboxFiles();

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("removes a .tmp file once it is old enough to be sure it's orphaned", () => {
    const { bridge, bridgePath: dir } = makeBridge();
    bridgePath = dir;
    const filePath = writeAgedTmpFile(
      bridge.getOutboxDir(),
      "res-0000000001.json.tmp",
      OLD_ENOUGH_MS,
    );

    bridge.cleanupOutboxFiles();

    expect(fs.existsSync(filePath)).toBe(false);
  });
});
