import { afterEach, describe, expect, it } from "vitest";
import dgram from "dgram";
import { queryMasterServer, isPrivateIp } from "../routes/serverFinder.js";

// regression-2026-08-29, apps/panel-server/routes/serverFinder.js, case 4:
// "WHETHER THE PANEL CAN BE MADE TO PROBE SOMETHING ON ITS OWN NETWORK it
// should not." queryMasterServer() used to send its Steam master-server
// query over a plain, UNCONNECTED dgram udp4 socket and process whatever
// arrived on the OS-assigned local port -- it never checked that a reply
// actually came from the master host it queried. GET /'s master-server
// fallback then fed every {ip, port} pair straight into queryServerInfo()
// (a raw UDP send) with no isPrivateIp() filter, unlike GET /query and
// GET /ping which both call validateQueryIp() first.
//
// Fix: socket.connect(masterPort, masterHost) makes this a CONNECTED UDP
// socket -- the kernel then only ever delivers a datagram whose source
// address:port matches the resolved master, deterministically, per packet,
// not as a timing race. GET / additionally filters any surviving
// master-listed address through isPrivateIp() before probing it (see
// serverFinderPrivateFilterAndCap.test.js for that half).
//
// Per the explicit requirement: a rejection test alone only proves
// something was refused, never that the RIGHT thing was refused. Both
// tests below run against the SAME captured ephemeral port, so the
// "rejected" case and the "still works" case are proven under identical
// conditions, not different ones that could quietly diverge.
//
// No real host is contacted; "master" and "attacker" are both local
// sockets this test owns and closes.

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
      // Deliberately does NOT reply yet. The genuine reply is sent later,
      // explicitly, by the test -- this guarantees the attacker's spoof
      // gets an unambiguous, uncontested chance to be delivered first if
      // it is ever going to be. (An earlier version of this test had the
      // legit server reply immediately here, which resolved and closed
      // the socket before the attacker's packet was even sent -- the test
      // passed regardless of whether the fix was present, proving
      // nothing. Caught by deliberately sabotaging the fix and re-running:
      // this version fails as expected without socket.connect(); the
      // earlier version did not.)
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
    const spoofedEntry = Buffer.from([127, 0, 0, 1, 0x27, 0x0f]); // 127.0.0.1:9999
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

    // Give the loopback round-trip time to actually complete before the
    // genuine reply follows -- if the attacker's packet were going to be
    // accepted, this is ample time for it to have already resolved (and
    // closed) the socket.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // NOW the actual master replies, with a genuinely empty list -- if the
    // fix holds, this (and only this) is what the promise resolves with.
    legitServer.send(
      Buffer.from([0xff, 0xff, 0xff, 0xff, 0x66, 0x0a, 0, 0, 0, 0, 0, 0]),
      capturedClientPort,
      capturedClientAddress,
    );

    const servers = await queryPromise;

    expect(servers).toEqual([]); // the spoofed entry never arrives at all
  });

  it("POSITIVE CONTROL: a genuine reply from the actual connected peer is still accepted and parsed", async () => {
    legitServer = dgram.createSocket("udp4");
    legitServer.on("message", (msg, remote) => {
      const realEntry = Buffer.from([203, 0, 113, 5, 0x69, 0x90]); // 203.0.113.5:27024
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
