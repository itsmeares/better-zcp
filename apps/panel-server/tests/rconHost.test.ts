import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRconHost, resolveEnvRconHost } from "../services/rcon.ts";

afterEach(() => vi.unstubAllEnvs());

describe("normalizeRconHost", () => {
  it("strips whitespace pasted around a host", () => {
    expect(normalizeRconHost(" 66.51.96.52")).toBe("66.51.96.52");
    expect(normalizeRconHost("66.51.96.52 ")).toBe("66.51.96.52");
    expect(normalizeRconHost("  pz.example.com\t")).toBe("pz.example.com");
  });

  it("keeps a clean host unchanged", () => {
    expect(normalizeRconHost("127.0.0.1")).toBe("127.0.0.1");
  });

  it("falls back to loopback for empty or non-string input", () => {
    expect(normalizeRconHost("")).toBe("127.0.0.1");
    expect(normalizeRconHost("   ")).toBe("127.0.0.1");
    expect(normalizeRconHost(undefined)).toBe("127.0.0.1");
    expect(normalizeRconHost(null)).toBe("127.0.0.1");
  });
});

describe("resolveEnvRconHost", () => {
  it("uses RCON_HOST for split-container deployments", () => {
    vi.stubEnv("RCON_HOST", "projectzomboid");
    expect(resolveEnvRconHost()).toBe("projectzomboid");
  });

  it("keeps the co-located fallback and ignores the template placeholder", () => {
    vi.stubEnv("RCON_HOST", "CHANGE_ME");
    expect(resolveEnvRconHost()).toBe("127.0.0.1");

    vi.stubEnv("RCON_HOST", "");
    expect(resolveEnvRconHost()).toBe("127.0.0.1");
  });
});
