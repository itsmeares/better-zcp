import { describe, expect, it, afterEach } from "vitest";
import net from "net";
import { SourceRconClient } from "../utils/sourceRcon.js";


function encodePacket(id, type, body) {
  const bodyBuf = Buffer.from(body ?? "", "utf8");
  const size = 4 + 4 + bodyBuf.length + 1 + 1;
  const buf = Buffer.alloc(4 + size);
  let offset = 0;
  buf.writeInt32LE(size, offset); offset += 4;
  buf.writeInt32LE(id, offset); offset += 4;
  buf.writeInt32LE(type, offset); offset += 4;
  bodyBuf.copy(buf, offset); offset += bodyBuf.length;
  buf.writeUInt8(0, offset); offset += 1;
  buf.writeUInt8(0, offset); offset += 1;
  return buf;
}

const TYPE_AUTH = 3;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXECCOMMAND = 2;
const TYPE_RESPONSE_VALUE = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function drip(socket, buf, chunkSize) {
  for (let i = 0; i < buf.length; i += chunkSize) {
    socket.write(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
    await sleep(1);
  }
}

function startFakeServer({ onExecute, dripChunkSize = null, sendEmptyAuthAck = false }) {
  return new Promise((resolveServer) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) break;
          const size = buf.readInt32LE(0);
          const totalLen = 4 + size;
          if (buf.length < totalLen) break;
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.toString("utf8", 12, totalLen - 2);
          buf = buf.subarray(totalLen);

          (async () => {
            if (type === TYPE_AUTH) {
              if (sendEmptyAuthAck) {
                socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, ""));
              }
              socket.write(encodePacket(id, TYPE_AUTH_RESPONSE, ""));
            } else if (type === TYPE_EXECCOMMAND) {
              const responseBody = onExecute ? onExecute(body) : "";
              const packet = encodePacket(id, TYPE_RESPONSE_VALUE, responseBody);
              if (dripChunkSize) {
                await drip(socket, packet, dripChunkSize);
              } else {
                socket.write(packet);
              }
            }
          })();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function serverPort(server) {
  return server.address().port;
}

describe("SourceRconClient: real-socket packet reassembly (not a mocked/synthetic push)", () => {
  let server;
  let client;

  afterEach(async () => {
    if (client) client.disconnect();
    if (server) await new Promise((r) => server.close(r));
    server = null;
    client = null;
  });

  it("baseline: a small, single-write response round-trips correctly", async () => {
    server = await startFakeServer({ onExecute: () => "pong" });
    client = new SourceRconClient({ host: "127.0.0.1", port: serverPort(server), timeout: 3000 });
    await client.authenticate("pw");
    const response = await client.execute("ping");
    expect(response).toBe("pong");
  });

  it("THE CARD'S CASE: a large response drip-fed across many small writes (many real 'data' events) reassembles byte-for-byte", async () => {
    const bigBody = "X".repeat(64 * 1024) + "-END";
    server = await startFakeServer({ onExecute: () => bigBody, dripChunkSize: 4096 });
    client = new SourceRconClient({ host: "127.0.0.1", port: serverPort(server), timeout: 15000 });
    await client.authenticate("pw");
    const response = await client.execute("showoptions", { timeoutMs: 15000 });
    expect(response.length).toBe(bigBody.length);
    expect(response).toBe(bigBody);
  }, 20000);

  it("the 4-byte length header itself arrives split across separate writes (chunk size 3 < header size 4, guarantees the split)", async () => {
    server = await startFakeServer({ onExecute: () => "split-header-ok", dripChunkSize: 3 });
    client = new SourceRconClient({ host: "127.0.0.1", port: serverPort(server), timeout: 5000 });
    await client.authenticate("pw");
    const response = await client.execute("cmd", { timeoutMs: 5000 });
    expect(response).toBe("split-header-ok");
  });

  it("two complete response packets arriving in a SINGLE 'data' event are both drained (not just the first)", async () => {
    server = await startFakeServer({
      onExecute: (body) => `echo:${body}`,
    });
    client = new SourceRconClient({ host: "127.0.0.1", port: serverPort(server), timeout: 3000 });
    await client.authenticate("pw");
    const [a, b] = await Promise.all([
      client.execute("one"),
      client.execute("two"),
    ]);
    expect([a, b].sort()).toEqual(["echo:one", "echo:two"]);
  });

  it("positive control: the documented empty-SERVERDATA_RESPONSE_VALUE-before-AUTH_RESPONSE quirk does not break authentication over a real socket", async () => {
    server = await startFakeServer({ onExecute: () => "ok", sendEmptyAuthAck: true });
    client = new SourceRconClient({ host: "127.0.0.1", port: serverPort(server), timeout: 3000 });
    await expect(client.authenticate("pw")).resolves.toBeUndefined();
    const response = await client.execute("ping");
    expect(response).toBe("ok");
  });
});
