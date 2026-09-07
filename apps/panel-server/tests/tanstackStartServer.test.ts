import { describe, expect, it } from "vitest";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import {
  sendTanStackStartResponse,
  toTanStackStartRequest,
} from "../utils/tanstackStartServer.ts";

describe("TanStack Start Express adapter", () => {
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
    } as unknown as ExpressRequest);

    expect(request.url).toBe("https://panel.example/settings?tab=roles");
    expect(request.headers.get("cookie")).toBe("session=abc");
    expect(request.headers.get("x-panel")).toBe("test");
  });

  it("copies the Start response status, headers, and body to Express", async () => {
    const sent = {
      body: undefined as Buffer | undefined,
      headers: {} as Record<string, string | string[]>,
      statusCode: 0,
      setHeader(name: string, value: string | string[]) {
        this.headers[name.toLowerCase()] = value;
      },
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      send(body: Buffer) {
        this.body = body;
        return this;
      },
    };

    await sendTanStackStartResponse(
      new Response("<html>ok</html>", {
        status: 201,
        headers: { "content-type": "text/html" },
      }),
      sent as unknown as ExpressResponse,
    );

    expect(sent.statusCode).toBe(201);
    expect(sent.headers["content-type"]).toBe("text/html");
    expect(sent.body?.toString()).toBe("<html>ok</html>");
  });
});
