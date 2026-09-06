import { describe, expect, it, afterEach } from "vitest";
import net from "net";
import { SourceRconClient } from "../utils/sourceRcon.js";

// LINUX BUG HUNT (2026-08-29, card 560930): "the Source RCON protocol is
// byte-oriented -- check packet framing across a split TCP read (a large
// response arrives in several chunks) ... these behave differently under
// Linux's TCP stack than under Windows' and a test with a mocked socket
// cannot see it."
//
// Every prior RCON test (rcon.test.js) exercises PacketReader by calling
// .push() ONCE with a single, already-complete, hand-built Buffer -- there
// is nothing split about it, so the reassembly loop's "wait for more data"
// branches (this._buf.length < 4, this._buf.length < totalLen) are never
// actually exercised by a real multi-event delivery. This file spins up a
// REAL net.Server + net.Socket loopback pair (no mocking of net, child_process,
// or the socket itself) and deliberately drip-feeds bytes across many
// separate socket.write() calls with a delay between each, which reliably
// produces multiple distinct 'data' events on the client side -- the actual
// mechanism a real OS TCP stack uses to deliver a large response, and the
// exact case a synthetic single-push test cannot see.

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

// Writes `buf` to `socket` split into small pieces with a real delay between
// each write -- delaying past the current event-loop tick is what forces
// Node to deliver them as separate 'data' events on the receiving end rather
// than coalescing them, unlike calling .push() twice back-to-back in a unit
// test.
async function drip(socket, buf, chunkSize) {
  for (let i = 0; i < buf.length; i += chunkSize) {
    socket.write(buf.subarray(i, Math.min(i + chunkSize, buf.length)));
    await sleep(1);
  }
}

// Minimal fake Source RCON server. `onExecute(body)` returns the response
// body to send back for an EXECCOMMAND packet; `dripChunkSize` controls how
// the response packet is fragmented across the wire (null = one write).
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
                // Real-world quirk documented in sourceRcon.js: some servers
                // send an empty SERVERDATA_RESPONSE_VALUE immediately before
                // the actual auth response.
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
    // Two independent execute() calls whose responses the server happens to
    // flush together -- proves the reassembly loop keeps consuming complete
    // packets out of one buffer rather than stopping after the first.
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
