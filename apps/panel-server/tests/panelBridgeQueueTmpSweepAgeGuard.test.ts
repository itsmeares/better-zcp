import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const { PanelBridge } = await import("../services/panelBridge.ts");

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
