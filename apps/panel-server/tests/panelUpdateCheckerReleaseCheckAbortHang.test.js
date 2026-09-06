import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";

let mockReq;
let mockRes;

vi.mock("https", () => ({
  default: {
    get: vi.fn((_options, callback) => {
      mockReq = new EventEmitter();
      mockReq.setTimeout = vi.fn();
      mockReq.destroy = vi.fn();
      mockRes = new EventEmitter();
      mockRes.statusCode = 500;
      mockRes.resume = vi.fn();
      setTimeout(() => callback(mockRes), 0);
      return mockReq;
    }),
  },
}));

vi.mock("../database/init.js", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
}));

vi.mock("../services/dockerUpdateProxy.ts", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("PanelUpdateChecker.checkForUpdate settles even when the GitHub response aborts mid-body", () => {
  it("resets isChecking instead of hanging forever when res never fires 'end' and req never fires 'error'", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";

    const checkPromise = checker.checkForUpdate();
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockRes.emit("data", Buffer.from("partial error body"));
    mockRes.emit("aborted");
    mockRes.emit("close");

    const result = await Promise.race([
      checkPromise.then(() => "SETTLED"),
      new Promise((resolve) => setTimeout(() => resolve("HUNG"), 1000)),
    ]);

    expect(result).toBe("SETTLED");
    expect(checker.isChecking).toBe(false);
  });
});
