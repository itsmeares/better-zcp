import { describe, expect, it } from "vitest";
import { bridgeSupportsPlayerStatus } from "../worldMapBridgeVersion";

// getServerInfo started sending isAlive/isInfected/accessLevel at bridge
// v1.7.39. These tests exercise the version gate in isolation, with a
// particular focus on the fail-closed requirement: an unparseable, missing,
// or empty version must read as "too old", never "assume new" -- a
// fail-open gate here would recreate the exact confidently-wrong-data bug
// it exists to close.

describe("bridgeSupportsPlayerStatus", () => {
  it("supports the exact minimum version", () => {
    expect(bridgeSupportsPlayerStatus("1.7.39")).toBe(true);
  });

  it("supports a newer patch, minor, and major version", () => {
    expect(bridgeSupportsPlayerStatus("1.7.40")).toBe(true);
    expect(bridgeSupportsPlayerStatus("1.8.0")).toBe(true);
    expect(bridgeSupportsPlayerStatus("2.0.0")).toBe(true);
  });

  it("rejects an older patch, minor, and major version", () => {
    expect(bridgeSupportsPlayerStatus("1.7.38")).toBe(false);
    expect(bridgeSupportsPlayerStatus("1.6.99")).toBe(false);
    expect(bridgeSupportsPlayerStatus("0.9.9")).toBe(false);
  });

  it("fails closed on an empty version string", () => {
    expect(bridgeSupportsPlayerStatus("")).toBe(false);
    expect(bridgeSupportsPlayerStatus("   ")).toBe(false);
  });

  it("fails closed on a missing version", () => {
    expect(bridgeSupportsPlayerStatus(null)).toBe(false);
    expect(bridgeSupportsPlayerStatus(undefined)).toBe(false);
  });

  it("fails closed on a garbage version string, never assuming new", () => {
    expect(bridgeSupportsPlayerStatus("not-a-version")).toBe(false);
    expect(bridgeSupportsPlayerStatus("v1.7.39")).toBe(false); // prefixed -- not an exact match
    expect(bridgeSupportsPlayerStatus("1.7")).toBe(false); // missing patch segment
    expect(bridgeSupportsPlayerStatus("1.7.39.1")).toBe(false); // extra segment
    expect(bridgeSupportsPlayerStatus("latest")).toBe(false);
    expect(bridgeSupportsPlayerStatus("9999")).toBe(false);
  });

  it("tolerates surrounding whitespace on an otherwise valid version", () => {
    expect(bridgeSupportsPlayerStatus(" 1.7.39 ")).toBe(true);
  });
});
