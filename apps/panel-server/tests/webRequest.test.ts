import { describe, expect, it } from "vite-plus/test";
import { toWebRequest } from "../utils/webRequest.ts";

describe("native HTTP request adapter", () => {
  it("keeps the original URL and request headers", () => {
    const request = toWebRequest({
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
    const request = toWebRequest({
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

  it("forwards parsed JSON bodies for API requests", async () => {
    const request = toWebRequest({
      method: "POST",
      originalUrl: "/api/command",
      url: "/api/command",
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

});
