import http from "node:http";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Server } from "socket.io";

function requestWebSocketUpgrade(port: number, path: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 101);
    });
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}

describe("Engine.IO transport protocol validation", () => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);

  afterEach(async () => {
    if (httpServer.listening) {
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  });

  it("rejects an EIO=3 WebSocket upgrade for an EIO=4 polling session", async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("No TCP address");

    const handshake = await fetch(
      `http://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=polling`,
    );
    const payload = await handshake.text();
    expect(handshake.status).toBe(200);
    expect(payload.startsWith("0")).toBe(true);
    const { sid } = JSON.parse(payload.slice(1));

    const status = await requestWebSocketUpgrade(
      address.port,
      `/socket.io/?EIO=3&transport=websocket&sid=${encodeURIComponent(sid)}`,
    );

    expect(status).toBe(400);
  });
});
