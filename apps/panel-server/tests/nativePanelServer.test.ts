import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPanelRequestHandler } from "../http/panelWeb.ts";
import type { TrustProxySetting } from "../utils/trustProxy.ts";
import { parseOriginList } from "../utils/corsOrigins.ts";

const logger = { debug() {}, warn() {}, error() {} };
const temporaryRoots: string[] = [];

function makeOptions(clientDistPath: string) {
  return {
    isPackaged: false,
    clientDistPath,
    externalClientDistPath: clientDistPath,
    embeddedClientDistPath: null,
    buildMetadata: {
      panelVersion: "test",
      buildSha: "test-build",
      apiContractVersion: 1,
    },
    logger,
    inlineScriptCspSources: () => "'sha256-test'",
  };
}

function writeStartBundle(clientDistPath: string, source: string): void {
  const clientRoot = path.resolve(clientDistPath, "..");
  fs.mkdirSync(path.join(clientRoot, "dist-start-server"), { recursive: true });
  fs.writeFileSync(path.join(clientRoot, "..", "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(clientRoot, "dist-start-server", "server.js"), source);
}

async function startServer(clientDistPath: string, trustProxy?: TrustProxySetting, configuredOrigins = "http://allowed.test") {
  const allowedOrigins = new Set(parseOriginList(configuredOrigins));
  const handler = createPanelRequestHandler(makeOptions(clientDistPath), {
    isAllowedOrigin: (origin) => typeof origin === "string" && allowedOrigins.has(origin),
    trustProxy,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("native panel HTTP host", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serves Node health and auth routes without the Start bundle", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-http-"));
    temporaryRoots.push(root);
    fs.writeFileSync(
      path.join(root, "index.html"),
      "<!doctype html><script>window.native = true</script>",
    );
    const { server, baseUrl } = await startServer(root);

    try {
      const response = await fetch(`${baseUrl}/api/health?probe=1`, {
        headers: { origin: "http://allowed.test" },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "ok",
        panelVersion: "test",
        buildSha: "test-build",
        apiContractVersion: 1,
      });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://allowed.test",
      );
      const auth = await fetch(`${baseUrl}/api/auth/status`);
      expect(auth.status).toBe(200);
      expect(await auth.json()).toMatchObject({ needsSetup: expect.any(Boolean), authEnabled: expect.any(Boolean) });
      const panelInfo = await fetch(`${baseUrl}/api/panel-info`);
      expect(panelInfo.status).toBe(200);
      expect(await panelInfo.json()).toMatchObject({ port: expect.any(Number) });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps security headers on Node API responses behind a trusted proxy", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-proxy-"));
    temporaryRoots.push(root);
    const { server, baseUrl } = await startServer(root, "127.0.0.1");

    try {
      const response = await fetch(`${baseUrl}/api/health?probe=proxy`, {
        headers: {
          "x-forwarded-for": "203.0.113.9, 127.0.0.1",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves first-run and reload requests from an exact remote DNS origin", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-dns-"));
    temporaryRoots.push(root);
    const clientDistPath = path.join(root, "client", "dist");
    fs.mkdirSync(clientDistPath, { recursive: true });
    fs.writeFileSync(path.join(clientDistPath, "index.html"), "<!doctype html><title>Panel</title>");
    const origin = "https://panel.example.test:8443";
    const { server, baseUrl } = await startServer(clientDistPath, undefined, origin);

    try {
      for (const [method, route] of [
        ["GET", "/api/auth/status"],
        ["GET", "/api/health"],
      ]) {
        const response = await fetch(baseUrl + route, { method, headers: { origin } });
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe(origin);
      }
      const blocked = await fetch(baseUrl + "/api/auth/status", {
        headers: { origin: "https://panel.example.test" },
      });
      expect(blocked.status).toBe(403);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves the static document and routes server functions through Start only", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-start-"));
    temporaryRoots.push(root);
    const clientDistPath = path.join(root, "client", "dist");
    fs.mkdirSync(clientDistPath, { recursive: true });
    writeStartBundle(clientDistPath, `
      export default { fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/_serverFn/test-command") {
          return Response.json({ method: request.method, body: await request.json() });
        }
        return Response.json({ source: "start" });
      }};
    `);
    fs.writeFileSync(path.join(clientDistPath, "index.html"), "<!doctype html><script>window.native = true</script>");
    const { server, baseUrl } = await startServer(clientDistPath);

    try {
      const page = await fetch(`${baseUrl}/players`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("window.native = true");

      const serverFunction = await fetch(`${baseUrl}/_serverFn/test-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ping" }),
      });
      expect(await serverFunction.json()).toEqual({
        method: "POST",
        body: { action: "ping" },
      });

      const unknownApi = await fetch(`${baseUrl}/api/start`);
      expect(unknownApi.status).toBe(401);
      expect((await unknownApi.json()).error).toBeTruthy();

      const health = await fetch(`${baseUrl}/api/health`);
      expect(health.status).toBe(200);
      expect((await health.json()).status).toBe("ok");
      const wrongMethod = await fetch(`${baseUrl}/api/health`, { method: "POST" });
      expect(wrongMethod.status).toBe(405);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves browser assets and pages from the static client build", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-assets-"));
    temporaryRoots.push(root);
    const clientDistPath = path.join(root, "client", "dist");
    fs.mkdirSync(path.join(clientDistPath, "assets"), { recursive: true });
    writeStartBundle(clientDistPath, `
      export default { fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/assets/app.js") {
          return Response.json({ error: "document handler received an asset" }, { status: 500 });
        }
        return new Response("<html>start page</html>", { headers: { "content-type": "text/html" } });
      }};
    `);
    fs.writeFileSync(path.join(clientDistPath, "index.html"), "static shell");
    fs.writeFileSync(path.join(clientDistPath, "assets", "app.js"), "console.log('asset');");
    fs.writeFileSync(path.join(clientDistPath, "assets", "app.css"), "body { color: red; }");
    const { server, baseUrl } = await startServer(clientDistPath);

    try {
      const script = await fetch(`${baseUrl}/assets/app.js`, {
        headers: { accept: "text/javascript" },
      });
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await script.text()).toBe("console.log('asset');");

      const stylesheet = await fetch(`${baseUrl}/assets/app.css`);
      expect(stylesheet.status).toBe(200);
      expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(await stylesheet.text()).toBe("body { color: red; }");

      const head = await fetch(`${baseUrl}/assets/app.js`, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("console.log('asset');")));
      expect(await head.text()).toBe("");

      const page = await fetch(`${baseUrl}/players`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("static shell");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves the static shell with inline-script authorization and handles CORS preflight", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-shell-"));
    temporaryRoots.push(root);
    fs.writeFileSync(
      path.join(root, "index.html"),
      "<!doctype html><script>window.native = true</script>",
    );
    const { server, baseUrl } = await startServer(root);

    try {
      const page = await fetch(`${baseUrl}/players`);
      expect(page.status).toBe(200);
      const html = await page.text();
      const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
      expect(html).toContain("window.native = true");
      expect(nonce).toBeTruthy();
      expect(page.headers.get("content-security-policy")).toContain("sha256-");
      expect(page.headers.get("content-security-policy")).toContain(
        `'nonce-${nonce}'`,
      );
      expect(page.headers.get("content-length")).toBe(
        String(Buffer.byteLength(html)),
      );

      const preflight = await fetch(`${baseUrl}/api/health`, {
        method: "OPTIONS",
        headers: {
          origin: "http://allowed.test",
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "http://allowed.test",
      );

      const blocked = await fetch(`${baseUrl}/api/health`, {
        method: "POST",
        headers: { origin: "http://blocked.test" },
      });
      expect(blocked.status).toBe(403);
      expect((await blocked.json()).error).toContain("CORS_ORIGINS");

      for (const origin of ["http://allowed.test:3001", "http://other.test"]) {
        const response = await fetch(`${baseUrl}/api/health`, { headers: { origin } });
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      }

      const withoutOrigin = await fetch(`${baseUrl}/`);
      expect(withoutOrigin.status).toBe(200);
      expect(withoutOrigin.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
