import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryServerInfo } from "../routes/serverFinder.js";


function buildA2SInfoResponse(name) {
  return Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff, 0x49, 17]), // header 'I' + protocol
    Buffer.from(`${name}\0`),
    Buffer.from("Muldraugh\0"), // map
    Buffer.from("projectzomboid\0"), // folder
    Buffer.from("Project Zomboid\0"), // game
    Buffer.from([0x78, 0x2a]), // appId (LE, arbitrary placeholder)
    Buffer.from([2, 32, 0]), // players, maxPlayers, bots
    Buffer.from([0x64, 0x6c, 0, 1]), // serverType 'd', environment 'l', visibility 0, vac 1
    Buffer.from("42.13\0"), // version
    Buffer.from([0]), // EDF = 0, no extra data
  ]);
}

describe("queryServerInfo: response sender is now authenticated (regression follow-up, fixed)", () => {
  let legitServer;
  let attackerSocket;

  afterEach(() => {
    legitServer?.close();
    attackerSocket?.close();
    legitServer = null;
    attackerSocket = null;
  });

  it("REJECTS an A2S_INFO reply from an endpoint that is not the queried server, even targeting the exact port the query used", async () => {
    legitServer = dgram.createSocket("udp4");
    let capturedClientPort = null;
    let capturedClientAddress = null;
    legitServer.on("message", (msg, remote) => {
      capturedClientPort = remote.port;
      capturedClientAddress = remote.address;
    });
    await new Promise((resolve) => legitServer.bind(0, "127.0.0.1", resolve));
    const legitPort = legitServer.address().port;

    const queryPromise = queryServerInfo("127.0.0.1", legitPort);

    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (capturedClientPort !== null) {
          clearInterval(check);
          resolve();
        }
      }, 5);
    });

    attackerSocket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => {
      attackerSocket.send(
        buildA2SInfoResponse("Spoofed Server"),
        capturedClientPort,
        "127.0.0.1",
        (err) => (err ? reject(err) : resolve()),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    legitServer.send(
      buildA2SInfoResponse("Real Server"),
      capturedClientPort,
      capturedClientAddress,
    );

    const result = await queryPromise;

    expect(result).not.toBeNull();
    expect(result.name).toBe("Real Server");
  });

  it("POSITIVE CONTROL: a genuine reply from the actual connected peer is still accepted and parsed", async () => {
    legitServer = dgram.createSocket("udp4");
    legitServer.on("message", (msg, remote) => {
      legitServer.send(buildA2SInfoResponse("Direct Server"), remote.port, remote.address);
    });
    await new Promise((resolve) => legitServer.bind(0, "127.0.0.1", resolve));
    const legitPort = legitServer.address().port;

    const result = await queryServerInfo("127.0.0.1", legitPort);

    expect(result).toMatchObject({
      name: "Direct Server",
      players: 2,
      maxPlayers: 32,
    });
  });
});
