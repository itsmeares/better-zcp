import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

let timeoutCallback: (() => void) | undefined;

vi.mock("https", () => ({
  default: {
    get: vi.fn(() => {
      const request = new EventEmitter() as EventEmitter & {
        setTimeout: (ms: number, callback: () => void) => void;
        destroy: (error: Error) => void;
      };
      request.setTimeout = (_ms, callback) => {
        timeoutCallback = callback;
      };
      request.destroy = (error) => queueMicrotask(() => request.emit("error", error));
      return request;
    }),
  },
}));

vi.mock("../database/init.ts", () => ({
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  getDb: vi.fn(),
  getDatabaseFilePath: vi.fn(),
}));

vi.mock("../services/dockerUpdateProxy.ts", () => ({
  DockerUpdateProxy: vi.fn(function DockerUpdateProxy() {
    this.mode = "none";
  }),
}));

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.ts");

describe("PanelUpdateChecker checksum fetch timeout", () => {
  it("marks the timeout as retryable ETIMEDOUT", async () => {
    const checker = new PanelUpdateChecker({ emit: vi.fn() });
    checker.currentVersion = "1.0.0";
    const request = checker.fetchReleaseText("https://github.com/example/checksums.txt");

    expect(timeoutCallback).toBeTypeOf("function");
    timeoutCallback?.();

    await expect(request).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(checker.isRetryableGitHubError({ code: "ETIMEDOUT" })).toBe(true);
  });
});
