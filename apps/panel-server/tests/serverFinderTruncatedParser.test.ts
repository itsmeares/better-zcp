import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryServerInfo } from "../routes/serverFinder.ts";


describe("queryServerInfo: a truncated A2S_INFO reply is contained, not thrown (regression case 5)", () => {
  let server;
  afterEach(() => server?.close());

  it("a reply cut off right after the header resolves null with 'unparseable-response', no crash", async () => {
    server = dgram.createSocket("udp4");
    server.on("message", (message, remote) => {
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
