import { describe, expect, it } from "vitest";
import { normalizeRconHost } from "../services/rcon.ts";

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
