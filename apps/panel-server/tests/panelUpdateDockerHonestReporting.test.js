import { describe, expect, it } from "vitest";
import http from "http";

// 2026-09-03, updater-sweep follow-up: two docker-mode "reports success/clean
// but did not actually check/confirm anything" gaps found by sweeping the
// updater for the same defect family as the runAutoUpdate build-verification
// fix. Both are honest-reporting fixes, not the full docker reconcile
// (carded separately, deliberately not built here -- the process that
// requests a docker update is the one whose own container gets torn down
// mid-update, so it cannot poll for its own answer; that needs new state and
// a boot-time check in the NEW container, a scoped feature, not a bug fix).

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");
const { DockerUpdateProxy } = await import("../services/dockerUpdateProxy.js");

describe("preflight() no longer reports a fabricated clean bill of health for docker mode", () => {
  it("stays ok:true (no known blocker), keeps the honest checksPerformed:false, and explains why via an informational field -- not the warnings channel", async () => {
    // 2026-09-04, god's review of 2b043928: checksPerformed:false is the
    // honest, machine-readable core of the fix and must stay. But a sentence
    // that fires on EVERY docker preflight forever, regardless of the
    // operator's actual setup, isn't a warning -- it's a label, and it
    // spends the one channel meant for telling a docker operator something
    // is actually wrong. So the explanation moved out of warnings/
    // warningDetails into info.dockerNotChecked, in the same {key, params,
    // message} shape the client's translatePanelUpdateMessages already
    // knows how to translate, without permanently occupying the warnings
    // array.
    const checker = new PanelUpdateChecker();
    checker.dockerUpdateProxy = { enabled: true, mode: "docker" };

    const result = await checker.preflight();

    expect(result.ok).toBe(true);
    expect(result.info.checksPerformed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.warningDetails).toEqual([]);
    expect(result.info.dockerNotChecked).toEqual(
      expect.objectContaining({
        key: "updates.preflight.dockerNotChecked",
        params: {},
        message: expect.stringMatching(/does not run its own preflight checks/i),
      }),
    );
  });

  it("binary mode is unaffected: still reaches its own real checks, not the docker short-circuit", async () => {
    const checker = new PanelUpdateChecker();
    checker.dockerUpdateProxy = { enabled: false, mode: "binary" };

    const result = await checker.preflight();

    expect(result.info.dockerUpdater).toBeUndefined();
    expect(result.info.checksPerformed).toBeUndefined();
  });
});

// A real local HTTP server, not a mocked http module -- dockerUpdateProxy.js
// talks to the update controller through raw node:http/https, and mocking
// that module would risk pinning a re-implementation of apply() rather than
// exercising the real request/response handling (the same trap the
// runAutoUpdate build-verification tests were written to avoid by using real
// fs instead of mocking fs).
function withFakeUpdateController(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("DockerUpdateProxy.apply() no longer implies a confirmed outcome", () => {
  it("still reports success:true (the request really was accepted) but the message makes clear the outcome is unconfirmed", async () => {
    const { server, url } = await withFakeUpdateController((req, res) => {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Docker update to v1.2.15 started" }));
    });
    try {
      const proxy = new DockerUpdateProxy();
      proxy.url = url;
      proxy.token = "test-token";

      const result = await proxy.apply("1.2.15");

      expect(result.success).toBe(true);
      // Must not just say "started" -- the old wording ("...was accepted and
      // is being applied") was hedged but still read as forward progress
      // with no caveat. The fix must say, explicitly, that the panel does
      // not know the real outcome.
      expect(result.message).toContain("started");
      expect(result.message).toMatch(/cannot confirm this Docker update completed/i);
    } finally {
      server.close();
    }
  });

  it("carries the controller's own message forward rather than discarding it", async () => {
    const { server, url } = await withFakeUpdateController((req, res) => {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "Docker update to v9.9.9 started" }));
    });
    try {
      const proxy = new DockerUpdateProxy();
      proxy.url = url;
      proxy.token = "test-token";

      const result = await proxy.apply("9.9.9");

      expect(result.message).toContain("Docker update to v9.9.9 started");
    } finally {
      server.close();
    }
  });
});
