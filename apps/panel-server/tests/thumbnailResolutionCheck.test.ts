import { describe, expect, it } from "vitest";


const { buildThumbnailResolutionCheck } = await import("../routes/debug.ts");

describe("GET /diagnostics: mods.thumbnailResolution", () => {
  it("ok, with mods tracked: reports the total and that all are resolving", () => {
    const check = buildThumbnailResolutionCheck({ failing: 0, total: 12, lastError: null });
    expect(check.status).toBe("ok");
    expect(check.id).toBe("mods.thumbnailResolution");
    expect(check.message).toContain("12");
    expect(check.message).toMatch(/all thumbnails resolving/i);
  });

  it("ok, with zero tracked mods: a quieter message, not a complaint about having nothing to check", () => {
    const check = buildThumbnailResolutionCheck({ failing: 0, total: 0, lastError: null });
    expect(check.status).toBe("ok");
    expect(check.message).toBe("No thumbnail resolution failures.");
  });

  it("warn when some but not all tracked mods are failing, naming the last failure's reason, Workshop ID and age", () => {
    const lastError = { workshopId: "123456789", reason: "HTTP 404 from Steam", at: Date.now() - 5 * 60 * 1000 };
    const check = buildThumbnailResolutionCheck({ failing: 3, total: 10, lastError });
    expect(check.status).toBe("warn");
    expect(check.message).toContain("3 of 10");
    expect(check.message).toContain("HTTP 404 from Steam");
    expect(check.message).toContain("123456789");
    expect(check.message).toMatch(/5m ago/);
    expect(check.params).toMatchObject({
      failing: 3,
      total: 10,
      reason: "HTTP 404 from Steam",
      workshopId: "123456789",
    });
    expect(check.hint).toMatch(/steamcommunity\.com/);
  });

  it("fail when every tracked mod is failing -- points at host-wide Steam connectivity, not one mod", () => {
    const lastError = { workshopId: "999", reason: "connect ETIMEDOUT", at: Date.now() };
    const check = buildThumbnailResolutionCheck({ failing: 5, total: 5, lastError });
    expect(check.status).toBe("fail");
    expect(check.message).toContain("All 5 tracked mods");
    expect(check.message).toContain("connect ETIMEDOUT");
    expect(check.hint).toMatch(/steamuserimages-a\.akamaihd\.net/);
  });

  it("fails CLOSED to warn (not ok) on an unrecognised shape, same rule as worldmap.tiles.buildDetect", () => {
    expect(buildThumbnailResolutionCheck(null).status).toBe("warn");
    expect(buildThumbnailResolutionCheck(undefined).status).toBe("warn");
    expect(buildThumbnailResolutionCheck({}).status).toBe("warn");
    expect(buildThumbnailResolutionCheck({ failing: "3", total: 10 }).status).toBe("warn");
  });
});
