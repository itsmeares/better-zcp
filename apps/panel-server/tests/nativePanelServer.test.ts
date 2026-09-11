import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPanelRequestHandler } from "../http/panelWeb.ts";
import type { TrustProxySetting } from "../utils/trustProxy.ts";

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

async function startServer(clientDistPath: string, trustProxy?: TrustProxySetting) {
  const handler = createPanelRequestHandler(makeOptions(clientDistPath), {
    isAllowedOrigin: (origin) => origin === "http://allowed.test",
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

  it("does not serve API traffic when the Start bundle is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-http-"));
    temporaryRoots.push(root);
    fs.writeFileSync(
      path.join(root, "index.html"),
      "<!doctype html><script>window.native = true</script>",
    );
    const { server, baseUrl } = await startServer(root);

    try {
      const response = await fetch(`${baseUrl}/api/health?probe=1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://allowed.test",
        },
        body: JSON.stringify({ ready: true }),
      });

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "TanStack Start server bundle unavailable",
      });
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "http://allowed.test",
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps security headers when the Start bundle is unavailable", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-proxy-"));
    temporaryRoots.push(root);
    const { server, baseUrl } = await startServer(root, "127.0.0.1");

    try {
      const response = await fetch(`${baseUrl}/api/health?probe=proxy`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "203.0.113.9, 127.0.0.1",
        },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps Start pages/functions first without an API fallback", async () => {
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
        if (pathname === "/api/start") return Response.json({ source: "start" });
        if (pathname === "/api/health" && request.method === "POST") {
          await request.text();
          throw new Error("simulated Start failure");
        }
        if (pathname === "/api/known-error") {
          return Response.json({ source: "start", error: true }, {
            status: 404,
            headers: { "x-tanstack-start-handled": "1" },
          });
        }
        if (pathname === "/api/health") return new Response(null, { status: 404 });
        return new Response("<html>start page</html>", { headers: { "content-type": "text/html" } });
      }};
    `);
    fs.writeFileSync(path.join(clientDistPath, "index.html"), "static shell");
    const { server, baseUrl } = await startServer(clientDistPath);

    try {
      const page = await fetch(`${baseUrl}/players`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("start page");

      const serverFunction = await fetch(`${baseUrl}/_serverFn/test-command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "ping" }),
      });
      expect(await serverFunction.json()).toEqual({
        method: "POST",
        body: { action: "ping" },
      });

      const startApi = await fetch(`${baseUrl}/api/start`);
      expect(await startApi.json()).toEqual({ source: "start" });

      const handledError = await fetch(`${baseUrl}/api/known-error`);
      expect(handledError.status).toBe(404);
      expect(await handledError.json()).toEqual({ source: "start", error: true });
      expect(handledError.headers.get("x-tanstack-start-handled")).toBeNull();

      const missingApi = await fetch(`${baseUrl}/api/health`);
      expect(missingApi.status).toBe(404);
      expect(await missingApi.text()).toBe("");

      const fallback = await fetch(`${baseUrl}/api/health`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fallback: true }),
      });
      expect(fallback.status).toBe(503);
      expect(await fallback.json()).toEqual({ error: "TanStack Start request unavailable" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("serves the static shell with an inline-script hash and handles CORS preflight", async () => {
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
      expect(await page.text()).toContain("window.native = true");
      expect(page.headers.get("content-security-policy")).toContain(
        "sha256-",
      );
      expect(page.headers.get("content-length")).toBe(
        String(Buffer.byteLength("<!doctype html><script>window.native = true</script>")),
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
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
