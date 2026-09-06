import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryServerInfo } from "../routes/serverFinder.js";

// hunt-wave11-2026-08-29, apps/panel-server/routes/serverFinder.js follow-up card.
// queryServerInfo() had the SAME unconnected-socket shape queryMasterServer()
// had (hunt-wave10): it processed an A2S_INFO reply from ANY sender on its
// local port, not just the ip:port it was told to query. Lower severity
// than the master-server gap (by the time this runs, `ip` has already
// passed validateQueryIp or the isPrivateIp filter -- see the comment above
// socket.connect() in routes/serverFinder.js for the full argument), but
// still a real gap: without this fix, any host that can land a datagram on
// this socket's local port could fabricate the ENTIRE reply for a server
// the operator is actually checking on.
//
// Fix: socket.connect(port, ip) -- same treatment as queryMasterServer.
//
// Applying the hard-won lesson from hunt-wave10's own test bug: a rejection
// test only means something if the attacker's packet gets an UNCONTESTED
// window before the genuine reply is sent. The first draft of the
// queryMasterServer spoof test had the legit reply sent from the same
// handler that captured the port, closing the socket before the attacker's
// packet was ever sent -- it passed whether or not the fix was present.
// Both tests below withhold the genuine reply until the test explicitly
// sends it, after the spoof has had its window.
//
// No real host is contacted; "legit" and "attacker" are both local sockets
// this test owns and closes.

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

describe("queryServerInfo: response sender is now authenticated (hunt-wave11 follow-up, fixed)", () => {
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
      // Deliberately withheld: the genuine reply is sent later, explicitly,
      // by the test -- replying here immediately would resolve+close the
      // socket before the attacker's packet is even sent, making the
      // negative case unreachable regardless of the fix.
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

    // Give the loopback round-trip time to actually complete before the
    // genuine reply follows -- if the attacker's packet were going to be
    // accepted, this is ample time for it to have already resolved (and
    // closed) the socket.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // NOW the actual queried server replies -- if the fix holds, this (and
    // only this) is what the promise resolves with.
    legitServer.send(
      buildA2SInfoResponse("Real Server"),
      capturedClientPort,
      capturedClientAddress,
    );

    const result = await queryPromise;

    expect(result).not.toBeNull();
    expect(result.name).toBe("Real Server"); // never the spoofed one
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
