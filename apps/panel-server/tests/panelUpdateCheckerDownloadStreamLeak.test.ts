import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

let mockReq;
let mockRes;
let capturedFile = null;

vi.mock("https", () => ({
  default: {
    get: vi.fn((_url, _options, callback) => {
      mockReq = new EventEmitter();
      mockReq.destroy = vi.fn((err) => {
        mockReq.emit("error", err);
      });
      mockReq.setTimeout = vi.fn();
      mockRes = new EventEmitter();
      mockRes.statusCode = 200;
      mockRes.headers = {};
      mockRes.resume = vi.fn();
      mockRes.pipe = (dest) => {
        capturedFile = dest;
        return dest;
      };
      setTimeout(() => callback(mockRes), 0);
      return mockReq;
    }),
  },
}));

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../services/dockerUpdateProxy.ts", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.ts");

let tempDir;

afterEach(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("PanelUpdateChecker.downloadFile closes its write stream instead of leaking it on abort", () => {
  it("destroys the real write stream (and only then unlinks) when the download is aborted mid-transfer", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-download-"));
    const destPath = path.join(tempDir, "staged.exe");
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const downloadPromise = checker.downloadFile(
      "https://github-releases.githubusercontent.com/asset",
      destPath,
      0,
      "binary",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockRes.emit("data", Buffer.from("partial"));
    expect(capturedFile).toBeTruthy();
    expect(capturedFile.destroyed).toBe(false);

    const timeoutError = new Error("Download timed out");
    timeoutError.code = "ETIMEDOUT";
    mockReq.destroy(timeoutError);

    await expect(downloadPromise).rejects.toThrow("Download timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(capturedFile.destroyed).toBe(true);
    expect(fs.existsSync(destPath)).toBe(false);
  });
});
