import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { registerPanelWebRoutes } from "../http/panelWeb.ts";
import { sendClientIndex } from "../index.ts";

let temporaryRoot;
let server;

describe("SPA fallback", () => {
  afterEach(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (temporaryRoot) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      temporaryRoot = null;
    }
  });

  it("serves the embedded index from hidden parent directories", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-spa-fallback-"));
    const clientDistPath = path.join(
      temporaryRoot,
      ".embedded-client",
      ".zomboid-panel-client-test",
    );
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.writeFileSync(
      path.join(clientDistPath, "index.html"),
      "<!doctype html><title>panel</title>",
    );

    const app = express();
    app.get("/players", (req, res) => {
      sendClientIndex(res, clientDistPath, (error) => {
        if (error) res.status(500).send("Page not available");
      });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/players`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>panel</title>");
  });

  it("prefers the TanStack Start handler and keeps API misses as JSON", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-web-"));
    const clientDistPath = path.join(temporaryRoot, "client", "dist");
    const startDistPath = path.join(temporaryRoot, "client", "dist-start-server");
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.mkdirSync(startDistPath, { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(clientDistPath, "index.html"), "static shell");
    fs.writeFileSync(
      path.join(startDistPath, "server.js"),
      "export default { fetch: async (request) => request.method === 'POST' ? Response.json({ method: request.method, body: await request.json() }) : new Response('<html>start page</html>', { headers: { 'content-type': 'text/html' } }) }",
    );

    const app = express();
    app.use(express.json());
    registerPanelWebRoutes(app, {
      isPackaged: false,
      clientDistPath,
      externalClientDistPath: clientDistPath,
      embeddedClientDistPath: null,
      buildMetadata: {
        panelVersion: "2.0.0",
        buildSha: "test-build",
        apiContractVersion: 1,
      },
      logger: { debug() {}, warn() {}, error() {} },
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const startResponse = await fetch(`http://127.0.0.1:${address.port}/players`);
    expect(startResponse.status).toBe(200);
    expect(await startResponse.text()).toContain("start page");

    const serverFunctionResponse = await fetch(
      `http://127.0.0.1:${address.port}/_serverFn/test-command`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ping" }),
      },
    );
    expect(serverFunctionResponse.status).toBe(200);
    expect(await serverFunctionResponse.json()).toEqual({
      method: "POST",
      body: { action: "ping" },
    });

    const missingApiResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/not-found`,
    );
    expect(missingApiResponse.status).toBe(404);
    expect(await missingApiResponse.json()).toEqual({
      error: "API endpoint not found",
    });
  });
});
