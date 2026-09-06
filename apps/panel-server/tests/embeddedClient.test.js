import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  materializeEmbeddedClientBundle,
  resolveClientDistPath,
} from "../utils/embeddedClient.js";

let rootDir;

function encode(value) {
  return Buffer.from(value, "utf8").toString("base64");
}

function bundle(metadata) {
  return {
    schemaVersion: 1,
    files: {
      "index.html": encode("<html>new frontend</html>"),
      "build-info.json": encode(JSON.stringify(metadata)),
      assets: encode("asset bytes"),
    },
  };
}

describe("embedded packaged frontend", () => {
  afterEach(() => {
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    rootDir = null;
  });

  it("materializes the executable's matching client bundle", () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-embedded-client-"));
    const metadata = {
      panelVersion: "1.2.13",
      buildSha: "new-build",
      apiContractVersion: 1,
    };
    const embeddedPath = materializeEmbeddedClientBundle(
      bundle(metadata),
      metadata,
      rootDir,
    );

    expect(JSON.parse(fs.readFileSync(path.join(embeddedPath, "build-info.json")))).toEqual(
      metadata,
    );
    expect(fs.readFileSync(path.join(embeddedPath, "index.html"), "utf8")).toContain(
      "new frontend",
    );
  });

  it("chooses the embedded bundle when external client/dist is from an older release", () => {
    const oldExternalPath = path.join("C:", "Panel", "client", "dist");
    const embeddedPath = path.join("C:", "Users", "runner", "AppData", "Local", "Temp", "embedded");

    expect(
      resolveClientDistPath({
        packaged: true,
        embeddedPath,
        externalPath: oldExternalPath,
      }),
    ).toBe(embeddedPath);
  });

  it("does not trust a pre-seeded deterministic cache directory", () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-embedded-client-"));
    const metadata = {
      panelVersion: "1.2.13",
      buildSha: "new-build",
      apiContractVersion: 1,
    };
    const preseededPath = path.join(
      rootDir,
      `zomboid-panel-client-${metadata.panelVersion}-${metadata.buildSha}`,
    );
    fs.mkdirSync(preseededPath, { recursive: true });
    fs.writeFileSync(path.join(preseededPath, ".ready"), "ready");
    fs.writeFileSync(path.join(preseededPath, "index.html"), "malicious frontend");
    fs.writeFileSync(
      path.join(preseededPath, "build-info.json"),
      JSON.stringify(metadata),
    );

    const embeddedPath = materializeEmbeddedClientBundle(
      bundle(metadata),
      metadata,
      rootDir,
    );

    expect(embeddedPath).not.toBe(preseededPath);
    expect(fs.readFileSync(path.join(embeddedPath, "index.html"), "utf8")).toBe(
      "<html>new frontend</html>",
    );
  });

  it("rejects an embedded bundle whose metadata differs from the executable", () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-embedded-client-"));
    expect(() =>
      materializeEmbeddedClientBundle(
        bundle({ panelVersion: "1.2.10", buildSha: "old-build", apiContractVersion: 1 }),
        { panelVersion: "1.2.13", buildSha: "new-build", apiContractVersion: 1 },
        rootDir,
      ),
    ).toThrow("does not match the executable");
  });
});