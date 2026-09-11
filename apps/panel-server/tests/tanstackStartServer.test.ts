import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import {
  sendTanStackStartResponse,
  toTanStackStartRequest,
} from "../utils/tanstackStartServer.ts";

describe("TanStack Start native HTTP adapter", () => {
  it("keeps the original URL and request headers", () => {
    const request = toTanStackStartRequest({
      method: "GET",
      originalUrl: "/settings?tab=roles",
      url: "/settings?tab=roles",
      protocol: "https",
      headers: { cookie: "session=abc", "x-panel": "test" },
      socket: { encrypted: true },
      get(name: string) {
        return name.toLowerCase() === "host" ? "panel.example" : undefined;
      },
    } as any);

    expect(request.url).toBe("https://panel.example/settings?tab=roles");
    expect(request.headers.get("cookie")).toBe("session=abc");
    expect(request.headers.get("x-panel")).toBe("test");
  });

  it("replaces spoofable connection metadata with Express values", () => {
    const request = toTanStackStartRequest({
      method: "GET",
      originalUrl: "/api/auth/reset-status",
      url: "/api/auth/reset-status",
      protocol: "http",
      headers: {
        "x-panel-remote-address": "attacker",
        "x-panel-client-ip": "attacker",
        "x-panel-trust-proxy": "0",
      },
      socket: { remoteAddress: "127.0.0.1" },
      ip: "10.0.0.4",
      app: { get: () => true },
      get(name: string) {
        return name.toLowerCase() === "host" ? "panel.example" : undefined;
      },
    } as any);

    expect(request.headers.get("x-panel-remote-address")).toBe("127.0.0.1");
    expect(request.headers.get("x-panel-client-ip")).toBe("10.0.0.4");
    expect(request.headers.get("x-panel-trust-proxy")).toBe("1");
  });

  it("forwards parsed JSON bodies for server-function requests", async () => {
    const request = toTanStackStartRequest({
      method: "POST",
      originalUrl: "/_serverFn/command",
      url: "/_serverFn/command",
      protocol: "https",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
      },
      body: { action: "ping" },
      socket: { encrypted: true },
      get(name: string) {
        return name.toLowerCase() === "host" ? "panel.example" : undefined;
      },
    } as any);

    expect(await request.json()).toEqual({ action: "ping" });
    expect(request.headers.get("content-length")).toBeNull();
  });

  it("copies the Start response status, headers, and body to Node HTTP", async () => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const sent = Object.assign(output, {
      headers: {} as Record<string, string | string[]>,
      statusCode: 0,
      setHeader(name: string, value: string | string[]) {
        this.headers[name.toLowerCase()] = value;
      },
    });
    const ended = new Promise<void>((resolve) => output.once("end", resolve));

    await sendTanStackStartResponse(
      new Response("<html>ok</html>", {
        status: 201,
        headers: { "content-type": "text/html" },
      }),
      sent as any,
    );

    expect(sent.statusCode).toBe(201);
    expect(sent.headers["content-type"]).toBe("text/html");
    await ended;
    expect(Buffer.concat(chunks).toString()).toBe("<html>ok</html>");
  });

  it("preserves multiple Set-Cookie headers", async () => {
    const sent = Object.assign(new PassThrough(), {
      headers: {} as Record<string, string | string[]>,
      statusCode: 0,
      setHeader(name: string, value: string | string[]) {
        this.headers[name.toLowerCase()] = value;
      },
    });
    const response = new Response(null);
    response.headers.append("set-cookie", "access=one; Path=/");
    response.headers.append("set-cookie", "refresh=two; Path=/");

    await sendTanStackStartResponse(
      response,
      sent as any,
    );

    expect(sent.headers["set-cookie"]).toEqual([
      "access=one; Path=/",
      "refresh=two; Path=/",
    ]);
    expect(sent.writableEnded).toBe(true);
  });
});
