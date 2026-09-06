import { describe, expect, it } from "vitest";
import { mapSteamServer } from "../routes/serverFinder.js";

// Regression coverage: mapSteamServer() used to fall back to the hardcoded
// 16261 (PZ's default game port) whenever BOTH the addr-derived port and
// server.gameport were unparseable -- a fabricated, real-looking value
// indistinguishable downstream from a port that was actually read. Fixed to
// stay null (this file's own established "we don't have this value"
// convention, see ping: null) rather than invent one.

describe("mapSteamServer: port derivation is honest, never fabricated", () => {
  it("prefers the port parsed out of addr when present", () => {
    const result = mapSteamServer({ addr: "203.0.113.10:16262", gameport: 16261 });
    expect(result.port).toBe(16262);
  });

  it("falls back to gameport when addr has no parseable port", () => {
    const result = mapSteamServer({ addr: "203.0.113.10", gameport: 16261 });
    expect(result.port).toBe(16261);
  });

  it("stays null when neither addr nor gameport is parseable -- never 16261", () => {
    const result = mapSteamServer({ addr: "203.0.113.10", gameport: "not-a-port" });
    expect(result.port).toBeNull();
  });

  it("stays null when addr and gameport are both entirely absent", () => {
    const result = mapSteamServer({});
    expect(result.port).toBeNull();
  });

  it("gamePort is stored raw and unvalidated regardless of port's outcome", () => {
    const result = mapSteamServer({ addr: "203.0.113.10", gameport: "garbage" });
    expect(result.gamePort).toBe("garbage");
    expect(result.port).toBeNull();
  });
});
