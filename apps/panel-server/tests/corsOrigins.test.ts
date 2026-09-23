import { describe, expect, it } from "vitest";
import { normalizeOrigin, parseOriginList } from "../utils/corsOrigins.ts";

describe("configured CORS origins", () => {
  it("keeps the exact scheme, hostname and port", () => {
    const origins = new Set(parseOriginList("https://panel.example.test:8443"));
    expect(origins.has(normalizeOrigin("https://panel.example.test:8443"))).toBe(true);
    expect(origins.has(normalizeOrigin("https://panel.example.test"))).toBe(false);
    expect(origins.has(normalizeOrigin("https://other.example.test:8443"))).toBe(false);
    expect(origins.has(normalizeOrigin("http://panel.example.test:8443"))).toBe(false);
  });
});
