import { describe, expect, it } from "vitest";
import {
  buildA2SInfoQuery,
  deriveEmptyReason,
  isPrivateIp,
  parseQueryPort,
  queryServerInfo,
} from "../routes/serverFinder.js";
import dgram from "dgram";


describe("isPrivateIp: 100.64.0.0/10 (Carrier-Grade NAT) is now blocked", () => {
  it.each([
    "100.64.0.0",
    "100.64.0.1",
    "100.100.100.100",
    "100.127.255.255",
  ])("refuses %s -- inside the CGNAT range", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["100.63.255.255", "100.128.0.0"])(
    "does NOT block %s -- adjacent but outside the CGNAT range, must not overreach",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("isPrivateIp: existing ranges still correctly blocked (no regression)", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata endpoint
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
  ])("refuses %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
});

describe("isPrivateIp: a legitimate public address still probes -- the other direction", () => {
  it.each(["8.8.8.8", "1.1.1.1", "203.0.113.50"])(
    "does not block %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("parseQueryPort: public finder ports are parsed strictly", () => {
  it.each(["27015junk", "27015.5", "1e3", "", 0, 65536])(
    "rejects %s",
    (value) => {
      expect(parseQueryPort(value)).toBeNull();
    },
  );

  it("accepts a valid numeric string and number", () => {
    expect(parseQueryPort(" 27015 ")).toBe(27015);
    expect(parseQueryPort(16261)).toBe(16261);
  });
});

describe("queryServerInfo: A2S challenge handling", () => {
  it("retries once with the server challenge instead of dropping the server", async () => {
    const server = dgram.createSocket("udp4");
    const challenge = Buffer.from([0x12, 0x34, 0x56, 0x78]);
    let requests = 0;
    let echoedChallenge = false;
    server.on("message", (message, remote) => {
      requests++;
      if (requests === 1) {
        server.send(
          Buffer.concat([
            Buffer.from([0xff, 0xff, 0xff, 0xff, 0x41]),
            challenge,
          ]),
          remote.port,
          remote.address,
        );
        return;
      }

      echoedChallenge = message.subarray(-4).equals(challenge);
      const response = Buffer.from(
        [
          0xff, 0xff, 0xff, 0xff, 0x49, 17,
          ...Buffer.from("Challenge Server\0"),
          ...Buffer.from("Muldraugh\0"),
          ...Buffer.from("projectzomboid\0"),
          ...Buffer.from("Project Zomboid\0"),
          0x78, 0x2a,
          2, 32, 0,
          0x64, 0x6c, 0, 1,
          ...Buffer.from("42.13\0"),
          0,
        ],
      );
      server.send(response, remote.port, remote.address);
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));

    try {
      const port = server.address().port;
      const result = await queryServerInfo("127.0.0.1", port);

      expect(requests).toBe(2);
      expect(echoedChallenge).toBe(true);
      expect(result).toMatchObject({
        name: "Challenge Server",
        players: 2,
        maxPlayers: 32,
      });
    } finally {
      server.close();
    }
  });

  it("keeps the challenge-free query shape unchanged", () => {
    expect(buildA2SInfoQuery()).toEqual(
      Buffer.concat([
        Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
        Buffer.from("Source Engine Query\0"),
      ]),
    );
  });
});

describe("queryServerInfo: onFailureReason distinguishes the collapsed causes", () => {
  it("does not fire onFailureReason on a successful response", async () => {
    const server = dgram.createSocket("udp4");
    server.on("message", (message, remote) => {
      const response = Buffer.from([
        0xff, 0xff, 0xff, 0xff, 0x49, 17,
        ...Buffer.from("OK Server\0"),
        ...Buffer.from("Muldraugh\0"),
        ...Buffer.from("projectzomboid\0"),
        ...Buffer.from("Project Zomboid\0"),
        0x78, 0x2a,
        0, 32, 0,
        0x64, 0x6c, 0, 1,
        ...Buffer.from("42.13\0"),
        0,
      ]);
      server.send(response, remote.port, remote.address);
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));

    try {
      const port = server.address().port;
      const reasons = [];
      const result = await queryServerInfo("127.0.0.1", port, (r) => reasons.push(r));

      expect(result).toMatchObject({ name: "OK Server" });
      expect(reasons).toEqual([]);
    } finally {
      server.close();
    }
  });

  it("reports 'unparseable-response' -- server answered, but the panel could not read it", async () => {
    const server = dgram.createSocket("udp4");
    server.on("message", (message, remote) => {
      server.send(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x99]), remote.port, remote.address);
    });
    await new Promise((resolve) => server.bind(0, "127.0.0.1", resolve));

    try {
      const port = server.address().port;
      const reasons = [];
      const result = await queryServerInfo("127.0.0.1", port, (r) => reasons.push(r));

      expect(result).toBeNull();
      expect(reasons).toEqual(["unparseable-response"]);
    } finally {
      server.close();
    }
  });
});

describe("deriveEmptyReason: the master-list zero-collapse, disambiguated", () => {
  it("is undefined outside the master_server path -- steam_api source is untouched", () => {
    expect(
      deriveEmptyReason({ source: "steam_api", serversFound: 0, mastersReachable: false, mastersListedCount: 0 }),
    ).toBeUndefined();
  });

  it("is undefined once any servers were actually found", () => {
    expect(
      deriveEmptyReason({ source: "master_server", serversFound: 3, mastersReachable: true, mastersListedCount: 10 }),
    ).toBeUndefined();
  });

  it("'master-unreachable' -- every master in the list threw, none ever responded", () => {
    expect(
      deriveEmptyReason({ source: "master_server", serversFound: 0, mastersReachable: false, mastersListedCount: 0 }),
    ).toBe("master-unreachable");
  });

  it("'no-servers-listed' -- the master answered with a genuinely empty list", () => {
    expect(
      deriveEmptyReason({ source: "master_server", serversFound: 0, mastersReachable: true, mastersListedCount: 0 }),
    ).toBe("no-servers-listed");
  });

  it("'no-servers-responded' -- the master listed servers, but every A2S follow-up failed", () => {
    expect(
      deriveEmptyReason({ source: "master_server", serversFound: 0, mastersReachable: true, mastersListedCount: 40 }),
    ).toBe("no-servers-responded");
  });
});
