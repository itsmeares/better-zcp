import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";


const mockTransport = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ type: "sftp", running: true })),
};

vi.mock("../services/panelBridgeSftp.js", () => ({
  PanelBridgeSftpTransport: vi.fn(function PanelBridgeSftpTransport() {
    return mockTransport;
  }),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

beforeEach(() => {
  mockTransport.start.mockClear();
  mockTransport.stop.mockClear();
  mockTransport.getStatus.mockClear();
  mockTransport.start.mockImplementation(async () => {});
  mockTransport.stop.mockImplementation(async () => {});
});

describe("PanelBridge.configureSftp cleans up the new transport when the post-connect swap fails", () => {
  let cacheDir;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-sftp-"));
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("stops the newly-connected transport and clears sftpTransport when this.configure() throws mid-swap", async () => {
    const bridge = new PanelBridge();
    vi.spyOn(bridge, "configure").mockImplementation(() => {
      throw new Error("swap failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, cacheDir),
    ).rejects.toThrow("swap failed");

    expect(mockTransport.stop).toHaveBeenCalled();
    expect(bridge.sftpTransport).toBeNull();
  });

  it("still succeeds normally when nothing in the swap throws (control)", async () => {
    const bridge = new PanelBridge();

    const result = await bridge.configureSftp(
      { host: "h", username: "u", password: "p", bridgePath: "/b" },
      cacheDir,
    );

    expect(result).toBe(bridge.bridgePath);
    expect(bridge.sftpTransport).toBe(mockTransport);
    expect(mockTransport.stop).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("leaves the previously-running bridge untouched when the NEW transport itself fails to connect (existing behavior, unchanged)", async () => {
    const bridge = new PanelBridge();
    mockTransport.start.mockImplementationOnce(async () => {
      throw new Error("connect failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, cacheDir),
    ).rejects.toThrow("connect failed");

    expect(bridge.sftpTransport).toBeNull();
    expect(bridge.isRunning).toBe(false);
  });
});
