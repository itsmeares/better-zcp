import { describe, expect, it } from "vitest";
import http from "http";


const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.ts");
const { DockerUpdateProxy } = await import("../services/dockerUpdateProxy.ts");

describe("preflight() no longer reports a fabricated clean bill of health for docker mode", () => {
  it("stays ok:true (no known blocker), keeps the honest checksPerformed:false, and explains why via an informational field -- not the warnings channel", async () => {
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
