import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryServerInfo } from "../routes/serverFinder.js";

// hunt-wave10-2026-08-29, apps/panel-server/routes/serverFinder.js, suspect 5: does a
// truncated/malformed A2S_INFO reply from an untrusted game server produce a
// clean null (via onFailureReason) or an unhandled throw that escapes and
// 500s the caller? parseA2SInfoResponse() has no explicit bounds checks on
// most of its buffer.readUInt8/readUInt16LE calls -- this proves the
// enclosing try/catch in queryServerInfo's message handler (routes/
// serverFinder.js) genuinely contains the RangeError a too-short buffer
// throws, rather than relying on it never being hit in practice.

describe("queryServerInfo: a truncated A2S_INFO reply is contained, not thrown (hunt-wave10 suspect 5)", () => {
  let server;
  afterEach(() => server?.close());

  it("a reply cut off right after the header resolves null with 'unparseable-response', no crash", async () => {
    server = dgram.createSocket("udp4");
    server.on("message", (message, remote) => {
      // Valid A2S_INFO header (0x49) but the buffer ends immediately after
      // it -- every subsequent field read in parseA2SInfoResponse would run
      // past buffer.length.
      server.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49]), remote.port, remote.address);
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));

    const port = server.address().port;
    const reasons = [];
    const result = await queryServerInfo("127.0.0.1", port, (r) => reasons.push(r));

    expect(result).toBeNull();
    expect(reasons).toEqual(["unparseable-response"]);
  });

  it("a completely empty payload after the header byte is also contained", async () => {
    server = dgram.createSocket("udp4");
    server.on("message", (message, remote) => {
      server.send(Buffer.from([0xff, 0xff, 0xff, 0xff]), remote.port, remote.address);
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));

    const port = server.address().port;
    const reasons = [];
    const result = await queryServerInfo("127.0.0.1", port, (r) => reasons.push(r));

    expect(result).toBeNull();
    expect(reasons).toEqual(["unparseable-response"]);
  });
});
