import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import net from "net";

const warnCalls = vi.hoisted(() => [] as string[]);

vi.mock("../utils/logger.ts", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: (message: string) => warnCalls.push(message),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { SourceRconClient } = await import("../utils/sourceRcon.ts");

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuffer = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuffer.length + 1 + 1;
  const packet = Buffer.alloc(4 + size);
  packet.writeInt32LE(size, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  bodyBuffer.copy(packet, 12);
  packet.writeUInt8(0, 12 + bodyBuffer.length);
  packet.writeUInt8(0, 13 + bodyBuffer.length);
  return packet;
}

function startFakeServer(delayMs: number): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const size = buffer.readInt32LE(0);
          if (buffer.length < 4 + size) break;
          const id = buffer.readInt32LE(4);
          const type = buffer.readInt32LE(8);
          buffer = buffer.subarray(4 + size);
          if (type === TYPE_AUTH) {
            socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
          } else if (type === TYPE_EXECCOMMAND) {
            setTimeout(() => {
              socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, "answer"));
            }, delayMs);
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

describe("SourceRconClient late responses", () => {
  let server: net.Server | null = null;
  let client: InstanceType<typeof SourceRconClient> | null = null;

  beforeEach(() => warnCalls.splice(0));

  afterEach(async () => {
    client?.disconnect();
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    client = null;
    server = null;
  });

  it("logs an orphan response after the command timeout", async () => {
    server = await startFakeServer(100);
    const address = server.address() as net.AddressInfo;
    client = new SourceRconClient({
      host: "127.0.0.1",
      port: address.port,
      timeout: 3000,
    });
    await client.authenticate("pw");

    await expect(client.execute("slow", { timeoutMs: 20 })).rejects.toThrow(/timed out/i);
    expect(warnCalls).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toMatch(/Orphaned RCON response/);
  });

  it("does not warn for an on-time response", async () => {
    server = await startFakeServer(0);
    const address = server.address() as net.AddressInfo;
    client = new SourceRconClient({
      host: "127.0.0.1",
      port: address.port,
      timeout: 3000,
    });
    await client.authenticate("pw");
    await expect(client.execute("fast")).resolves.toBe("answer");
    expect(warnCalls).toHaveLength(0);
  });
});
