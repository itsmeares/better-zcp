import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_PACKAGE_JSON = path.join(__dirname, "..", "..", "package.json");
const CLIENT_PACKAGE_JSON = path.join(__dirname, "..", "..", "client", "package.json");
const WORKSPACE_LOCKFILE = path.join(__dirname, "..", "..", "pnpm-lock.yaml");

// client/package.json sat at 1.2.2 for four releases while root advanced to
// 1.2.6, because nothing ever compared them -- the release process only bumped
// root. Kept deliberately dumb: parse, compare, done. A test that needs to
// be clever to pass is a test that can fail to catch the thing it's for.
//
// The release checklist names four things that should agree: root version,
// client version, the CHANGELOG heading, and the git tag. Only the first two
// are asserted here. The git tag needs git state to check, which this test
// deliberately doesn't touch. The CHANGELOG heading isn't actually the same
// kind of invariant as the other three -- this repo's CHANGELOG.md carries
// an [Unreleased] section that accumulates entries between releases, so the
// latest *numbered* heading legitimately trails root's version during any
// normal in-progress period (root is 1.2.6 with this comment written; the
// latest CHANGELOG heading is [1.2.5]). Asserting heading == root version
// would fail right now, correctly, for a reason that has nothing to do with
// the bug this test exists to catch.
describe("client version stays in sync with root", () => {
  const rootVersion = JSON.parse(fs.readFileSync(ROOT_PACKAGE_JSON, "utf8")).version;

  it("client/package.json matches root package.json", () => {
    const clientVersion = JSON.parse(fs.readFileSync(CLIENT_PACKAGE_JSON, "utf8")).version;
    expect(clientVersion).toBe(rootVersion);
  });

  it("pnpm workspace lockfile contains both package importers", () => {
    const lock = fs.readFileSync(WORKSPACE_LOCKFILE, "utf8");
    expect(lock).toContain("lockfileVersion:");
    expect(lock).toContain("\n  .:\n");
    expect(lock).toContain("\n  client:\n");
  });
});
