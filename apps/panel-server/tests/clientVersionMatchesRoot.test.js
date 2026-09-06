import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PACKAGE_JSON = path.join(__dirname, "..", "..", "..", "package.json");
const CLIENT_PACKAGE_JSON = path.join(__dirname, "..", "..", "..", "apps", "panel-client", "package.json");
const WORKSPACE_LOCKFILE = path.join(__dirname, "..", "..", "..", "pnpm-lock.yaml");

describe("client version stays in sync with root", () => {
  const rootVersion = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, "utf8")).version;

  it("apps/panel-client/package.json matches root package.json", () => {
    const clientVersion = JSON.parse(fs.readFileSync(CLIENT_PACKAGE_JSON, "utf8")).version;
    expect(clientVersion).toBe(rootVersion);
  });

  it("pnpm workspace lockfile contains both package importers", () => {
    const lock = fs.readFileSync(WORKSPACE_LOCKFILE, "utf8");
    expect(lock).toContain("lockfileVersion:");
    expect(lock).toContain("\n  .:\n");
    expect(lock).toContain("\n  apps/panel-client:\n");
  });
});
