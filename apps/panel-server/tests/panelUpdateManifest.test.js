import { describe, expect, it } from "vitest";
import { validateReleaseManifest } from "../services/panelUpdateChecker.js";

describe("standalone release manifest validation", () => {
  const manifest = {
    version: "1.2.4",
    artifacts: [
      {
        file: "ZomboidControlPanel.exe",
        sha256: "ABC123",
      },
    ],
  };

  it("rejects an archive built from an older package version", () => {
    expect(
      validateReleaseManifest(
        { ...manifest, version: "1.2.3" },
        "1.2.4",
        "ZomboidControlPanel.exe",
        "abc123",
      ),
    ).toMatch(/version 1\.2\.3.*release v1\.2\.4/i);
  });

  it("accepts a matching release and binary checksum", () => {
    expect(
      validateReleaseManifest(
        manifest,
        "1.2.4",
        "ZomboidControlPanel.exe",
        "abc123",
      ),
    ).toBeNull();
  });

  it("rejects a binary that does not belong to the archive", () => {
    expect(
      validateReleaseManifest(
        manifest,
        "1.2.4",
        "ZomboidControlPanel.exe",
        "different-hash",
      ),
    ).toMatch(/checksum does not match/i);
  });
});