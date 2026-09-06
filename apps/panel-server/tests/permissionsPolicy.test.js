import { describe, it, expect, vi } from "vitest";
import { permissionsPolicy } from "../middleware/permissionsPolicy.js";

function makeRes() {
  const headers = {};
  return {
    setHeader: vi.fn((name, value) => {
      headers[name] = value;
    }),
    headers,
  };
}

describe("permissionsPolicy middleware", () => {
  it("sets a Permissions-Policy header and calls next()", () => {
    const res = makeRes();
    const next = vi.fn();

    permissionsPolicy()({}, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Permissions-Policy",
      expect.any(String),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("denies every listed feature to every origin, self included", () => {
    const res = makeRes();
    permissionsPolicy()({}, res, vi.fn());

    const value = res.headers["Permissions-Policy"];
    const features = value.split(", ");
    expect(features.length).toBeGreaterThan(0);
    for (const entry of features) {
      // "feature=()" -- empty allowlist, not "(self)", which would still
      // permit this origin. An empty allowlist denies everyone, always.
      expect(entry).toMatch(/^[a-z-]+=\(\)$/);
    }
  });

  it("includes the camera, microphone and geolocation directives specifically", () => {
    const res = makeRes();
    permissionsPolicy()({}, res, vi.fn());

    const value = res.headers["Permissions-Policy"];
    expect(value).toContain("camera=()");
    expect(value).toContain("microphone=()");
    expect(value).toContain("geolocation=()");
  });

  it("returns a fresh middleware function each call (no shared mutable state)", () => {
    const mw1 = permissionsPolicy();
    const mw2 = permissionsPolicy();
    expect(mw1).not.toBe(mw2);

    const res1 = makeRes();
    const res2 = makeRes();
    mw1({}, res1, vi.fn());
    mw2({}, res2, vi.fn());
    expect(res1.headers["Permissions-Policy"]).toBe(
      res2.headers["Permissions-Policy"],
    );
  });
});
