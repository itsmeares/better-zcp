import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  registerPanelWebRoutes,
  registerTanStackStartApiRoute,
} from "../http/panelWeb.ts";
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

  it("serves the Start API route before its Express fallback", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-api-"));
    const clientDistPath = path.join(temporaryRoot, "client", "dist");
    const startDistPath = path.join(
      temporaryRoot,
      "client",
      "dist-start-server",
    );
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.mkdirSync(startDistPath, { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(startDistPath, "server.js"),
      "export default { fetch: async (request) => { const path = new URL(request.url).pathname; if (path === '/api/health') return Response.json({ source: 'start' }); if (path === '/api/known-error') return Response.json({ source: 'start', error: true }, { status: 404, headers: { 'x-tanstack-start-handled': '1' } }); return new Response('<html>not found</html>', { headers: { 'content-type': 'text/html' } }); } }",
    );

    const app = express();
    registerTanStackStartApiRoute(
      app,
      {
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
      },
      "/api",
      "ALL",
    );
    app.get("/api/health", (_req, res) => {
      res.json({ source: "express" });
    });
    app.get("/api/known-error", (_req, res) => {
      res.status(500).json({ source: "express" });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const startResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/health`,
    );
    expect(startResponse.status).toBe(200);
    expect(await startResponse.json()).toEqual({ source: "start" });

    const handledErrorResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/known-error`,
    );
    expect(handledErrorResponse.status).toBe(404);
    expect(await handledErrorResponse.json()).toEqual({
      source: "start",
      error: true,
    });
    expect(
      handledErrorResponse.headers.get("x-tanstack-start-handled"),
    ).toBeNull();
  });

  it("can bridge non-GET API methods to Start and still fall through on misses", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-api-all-"));
    const clientDistPath = path.join(temporaryRoot, "client", "dist");
    const startDistPath = path.join(
      temporaryRoot,
      "client",
      "dist-start-server",
    );
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.mkdirSync(startDistPath, { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(startDistPath, "server.js"),
      "export default { fetch: async (request) => new URL(request.url).pathname === '/api/compat' ? Response.json({ source: 'start', method: request.method, body: await request.json() }) : new Response(null, { status: 404 }) }",
    );

    const app = express();
    app.use(express.json());
    registerTanStackStartApiRoute(
      app,
      {
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
      },
      "/api",
      "ALL",
    );
    app.post("/api/fallback", (_req, res) => {
      res.json({ source: "express" });
    });

    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const startResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/compat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "post" }),
      },
    );
    expect(startResponse.status).toBe(200);
    expect(await startResponse.json()).toEqual({
      source: "start",
      method: "POST",
      body: { method: "post" },
    });

    const fallbackResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/fallback`,
      { method: "POST" },
    );
    expect(fallbackResponse.status).toBe(200);
    expect(await fallbackResponse.json()).toEqual({ source: "express" });
  });

  it("falls back when an old Start bundle renders an API path as HTML", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-start-api-"));
    const clientDistPath = path.join(temporaryRoot, "client", "dist");
    const startDistPath = path.join(
      temporaryRoot,
      "client",
      "dist-start-server",
    );
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.mkdirSync(startDistPath, { recursive: true });
    fs.writeFileSync(path.join(temporaryRoot, "package.json"), '{"type":"module"}');
    fs.writeFileSync(
      path.join(startDistPath, "server.js"),
      "export default { fetch: async () => new Response('<html>legacy</html>', { headers: { 'content-type': 'text/html' } }) }",
    );

    const app = express();
    registerTanStackStartApiRoute(
      app,
      {
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
      },
      "/api/health",
    );
    app.get("/api/health", (_req, res) => {
      res.json({ source: "express" });
    });
    server = await new Promise((resolve) => {
      const listener = app.listen(0, () => resolve(listener));
    });

    const address = server.address();
    const fallbackResponse = await fetch(
      `http://127.0.0.1:${address.port}/api/health`,
    );
    expect(fallbackResponse.status).toBe(200);
    expect(await fallbackResponse.json()).toEqual({ source: "express" });
  });
});
