import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryMasterServer, isPrivateIp } from "../routes/serverFinder.js";


describe("queryMasterServer: response sender is now authenticated (regression case 4, fixed)", () => {
  let legitServer;
  let attackerSocket;

  afterEach(() => {
    legitServer?.close();
    attackerSocket?.close();
    legitServer = null;
    attackerSocket = null;
  });

  it("REJECTS a server list from an endpoint that is not the queried master, even targeting the exact port the query used", async () => {
    legitServer = dgram.createSocket("udp4");
    let capturedClientPort = null;
    let capturedClientAddress = null;
    legitServer.on("message", (msg, remote) => {
      capturedClientPort = remote.port;
      capturedClientAddress = remote.address;
    });
    await new Promise((resolve) => legitServer.bind(0, "127.0.0.1", resolve));
    const legitPort = legitServer.address().port;

    const queryPromise = queryMasterServer("127.0.0.1", legitPort, 0xff, "\\appid\\108600");

    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (capturedClientPort !== null) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    attackerSocket = dgram.createSocket("udp4");
    const spoofedEntry = Buffer.from([127, 0, 0, 1, 0x27, 0x0f]);
    const sentinel = Buffer.from([0, 0, 0, 0, 0, 0]);
    const spoofedResponse = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x0a]),
      spoofedEntry,
      sentinel,
    ]);
    await new Promise((resolve, reject) => {
      attackerSocket.send(spoofedResponse, capturedClientPort, "127.0.0.1", (err) =>
        err ? reject(err) : resolve(),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    legitServer.send(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x0a, 0, 0, 0, 0, 0, 0]),
      capturedClientPort,
      capturedClientAddress,
    );

    const servers = await queryPromise;

    expect(servers).toEqual([]);
  });

  it("POSITIVE CONTROL: a genuine reply from the actual connected peer is still accepted and parsed", async () => {
    legitServer = dgram.createSocket("udp4");
    legitServer.on("message", (msg, remote) => {
      const realEntry = Buffer.from([203, 0, 113, 5, 0x69, 0x90]);
      const sentinel = Buffer.from([0, 0, 0, 0, 0, 0]);
      legitServer.send(
        Buffer.concat([
          Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x0a]),
          realEntry,
          sentinel,
        ]),
        remote.port,
        remote.address,
      );
    });
    await new Promise((resolve) => legitServer.bind(0, "127.0.0.1", resolve));
    const legitPort = legitServer.address().port;

    const servers = await queryMasterServer("127.0.0.1", legitPort, 0xff, "\\appid\\108600");

    expect(servers).toEqual([{ ip: "203.0.113.5", port: 27024 }]);
    expect(isPrivateIp(servers[0].ip)).toBe(false);
  });
});
