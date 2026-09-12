import { describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  createEmbeddedClientBundle,
  getClientDistFileHashes,
  resolveApiContractVersion,
  resolveBuildSha,
} from "../../../scripts/release/build.mjs";
import { isValidReleaseVersion } from "../../../scripts/release/version.mjs";

describe("standalone build metadata", () => {
  it("accepts stable and prerelease release versions only", () => {
    expect(isValidReleaseVersion("2.0.0")).toBe(true);
    expect(isValidReleaseVersion("2.0.0-rc1")).toBe(true);
    expect(isValidReleaseVersion("2.0.0-rc.1")).toBe(true);
    expect(isValidReleaseVersion("v2.0.0")).toBe(false);
    expect(isValidReleaseVersion("2.0")).toBe(false);
    expect(isValidReleaseVersion("2.0.0-")).toBe(false);
  });

  it("uses the supplied build SHA so client and executable builds share provenance", () => {
    expect(resolveBuildSha({ PANEL_BUILD_SHA: "  release-sha  " })).toBe(
      "release-sha",
    );
  });

  it("uses the stable API contract default and rejects malformed overrides", () => {
    expect(resolveApiContractVersion({})).toBe(1);
    expect(resolveApiContractVersion({ PANEL_API_CONTRACT_VERSION: "2" })).toBe(2);
    expect(resolveApiContractVersion({ PANEL_API_CONTRACT_VERSION: "0" })).toBe(1);
    expect(resolveApiContractVersion({ PANEL_API_CONTRACT_VERSION: "nope" })).toBe(1);
  });

  it("refuses to embed a client build from a different release", () => {
    const clientDist = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-build-metadata-"));
    try {
      fs.writeFileSync(path.join(clientDist, "index.html"), "old frontend");
      fs.writeFileSync(
        path.join(clientDist, "build-info.json"),
        JSON.stringify({ panelVersion: "1.2.10", buildSha: "old-build", apiContractVersion: 1 }),
      );

      expect(() =>
        createEmbeddedClientBundle(clientDist, {
          panelVersion: "1.2.13",
          buildSha: "new-build",
          apiContractVersion: 1,
        }),
      ).toThrow("does not match the executable build");
    } finally {
      fs.rmSync(clientDist, { recursive: true, force: true });
    }
  });

  it("records stable hashes for every client file", () => {
    const clientDist = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-client-hashes-"));
    try {
      fs.mkdirSync(path.join(clientDist, "assets"));
      fs.writeFileSync(path.join(clientDist, "index.html"), "index");
      fs.writeFileSync(path.join(clientDist, "assets", "app.js"), "app");

      expect(getClientDistFileHashes(clientDist)).toEqual({
        "assets/app.js": expect.any(String),
        "index.html": expect.any(String),
      });
      expect(Object.keys(getClientDistFileHashes(clientDist))).toEqual([
        "assets/app.js",
        "index.html",
      ]);
    } finally {
      fs.rmSync(clientDist, { recursive: true, force: true });
    }
  });
});
