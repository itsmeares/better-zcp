import { describe, expect, it } from "vitest";
import {
  deriveMasterDiscoveryStats,
  selectMasterServersToQuery,
} from "../routes/serverFinder.js";


describe("selectMasterServersToQuery: SSRF filter", () => {
  it("drops private/reserved addresses, keeps public ones, and reports the filtered count", () => {
    const masterServers = [
      { ip: "8.8.8.8", port: 27015 },
      { ip: "127.0.0.1", port: 27015 }, // loopback
      { ip: "10.0.0.5", port: 27015 }, // RFC1918
      { ip: "1.1.1.1", port: 27016 },
      { ip: "169.254.169.254", port: 80 }, // cloud metadata endpoint
    ];

    const result = selectMasterServersToQuery(masterServers);

    expect(result.toQuery).toEqual([
      { ip: "8.8.8.8", port: 27015 },
      { ip: "1.1.1.1", port: 27016 },
    ]);
    expect(result.privateFilteredCount).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("filters nothing when every address is already public", () => {
    const masterServers = [
      { ip: "203.0.113.1", port: 27015 },
      { ip: "203.0.113.2", port: 27015 },
    ];
    const result = selectMasterServersToQuery(masterServers);
    expect(result.toQuery).toEqual(masterServers);
    expect(result.privateFilteredCount).toBe(0);
  });
});

describe("selectMasterServersToQuery: query cap (MAX_MASTER_SERVERS_TO_QUERY = 200)", () => {
  it("queries only the first 200 of a longer public list, and reports truncated=true", () => {
    const masterServers = Array.from({ length: 250 }, (_, i) => ({
      ip: `203.0.${Math.floor(i / 256)}.${i % 256}`,
      port: 27015,
    }));

    const result = selectMasterServersToQuery(masterServers);

    expect(result.toQuery.length).toBe(200);
    expect(result.toQuery).toEqual(masterServers.slice(0, 200));
    expect(result.truncated).toBe(true);
  });

  it("does NOT truncate a list at or under the cap -- proves the boundary isn't overreaching", () => {
    const exactlyAtCap = Array.from({ length: 200 }, (_, i) => ({
      ip: `203.0.${Math.floor(i / 256)}.${i % 256}`,
      port: 27015,
    }));
    expect(selectMasterServersToQuery(exactlyAtCap).truncated).toBe(false);
    expect(selectMasterServersToQuery(exactlyAtCap).toQuery.length).toBe(200);

    const oneUnderCap = exactlyAtCap.slice(0, 199);
    expect(selectMasterServersToQuery(oneUnderCap).truncated).toBe(false);
    expect(selectMasterServersToQuery(oneUnderCap).toQuery.length).toBe(199);
  });

  it("the cap applies AFTER the private-IP filter -- a padded-with-private-IPs list of 250 that has only 150 real public entries is not truncated", () => {
    const masterServers = [
      ...Array.from({ length: 150 }, (_, i) => ({
        ip: `203.0.${Math.floor(i / 256)}.${i % 256}`,
        port: 27015,
      })),
      ...Array.from({ length: 100 }, () => ({ ip: "10.0.0.1", port: 27015 })),
    ];

    const result = selectMasterServersToQuery(masterServers);

    expect(result.toQuery.length).toBe(150);
    expect(result.privateFilteredCount).toBe(100);
    expect(result.truncated).toBe(false);
  });
});

describe("deriveMasterDiscoveryStats: transparency fields on the response", () => {
  it("is undefined outside the master_server path", () => {
    expect(
      deriveMasterDiscoveryStats({
        source: "steam_api",
        mastersListedCount: 0,
        mastersPrivateFilteredCount: 0,
        mastersQueriedCount: 0,
        mastersTruncated: false,
      }),
    ).toBeUndefined();
  });

  it("reports listed/privateFiltered/queried/truncated verbatim for the master_server path", () => {
    expect(
      deriveMasterDiscoveryStats({
        source: "master_server",
        mastersListedCount: 250,
        mastersPrivateFilteredCount: 5,
        mastersQueriedCount: 200,
        mastersTruncated: true,
      }),
    ).toEqual({ listed: 250, privateFiltered: 5, queried: 200, truncated: true });
  });
});
