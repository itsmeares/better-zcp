#!/usr/bin/env node
// Extracts the real UTF8 string constants out of every RCON command class
// (plus the command dispatcher, for "Unknown command") in the real B42
// server jar, and writes a committed fixture that
// apps/panel-server/tests/rconRejectionGroundTruth.test.js diffs
// apps/panel-server/services/rcon.js's KNOWN_RCON_REJECTIONS against on every test run.
//
// WHY THIS EXISTS: KNOWN_RCON_REJECTIONS's whole job is telling a real
// command success apart from a silent rejection (see its own comment in
// rcon.js). A pattern that stops matching anything is invisible everywhere
// else -- the code compiles, existing tests pass, the regex is syntactically
// perfect, it just silently never fires again. This fixture is what makes
// that state visible when the game changes a rejection message.
//
// Reuses this directory's own parseClass() (real constant-pool parsing per
// the JVM class file format, not a flat strings grep) rather than inventing
// a second extraction technique for the same jar.
//
// Usage: node scripts/jar-audit/extract-rcon-rejection-strings.mjs <path-to-projectzomboid.jar>
// READ-ONLY on the jar. Never writes anything under the PZ install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";
import { parseClass } from "./classfile-parser.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const jarPath = process.argv[2] || process.env.PZ_JAR_PATH;
if (!jarPath) {
  console.error("projectzomboid.jar path required (pass it as the first argument or set PZ_JAR_PATH)");
  process.exit(2);
}

const appManifestPath = path.resolve(path.dirname(jarPath), "..", "..", "appmanifest_108600.acf");
const FIXTURE_PATH = path.join(REPO_ROOT, "apps/panel-server/__fixtures__/pzRconRejectionStrings.json");

if (!fs.existsSync(jarPath)) {
  console.error(`projectzomboid.jar not found at ${jarPath} -- pass the real path as an argument.`);
  process.exit(1);
}

const d = await unzipper.Open.file(jarPath);

// Scope: every serverCommands class (where a per-command rejection message
// would live) plus GameServer.class (the command dispatcher -- "Unknown
// command" lives here, not in any one command class), plus BanSystem.class
// and ServerWorldDatabase.class (+ its LogonResult inner class).
//
// banuser/unbanuser/adduser/removeuserfromwhitelist carry no rejection-text
// literals of their own. Each
// command class (BanUserCommand, UnbanUserCommand, AddUserCommand,
// RemoveUserFromWhiteList) just returns whatever String BanSystem's or
// ServerWorldDatabase's own methods hand back (BanSystem.BanUser/
// BanUserByIP/BanUserBySteamID/BanIP; ServerWorldDatabase.banUser/
// addUser/removeUser). The rejection text, if the target isn't found, is
// already banned, or cannot be banned, lives in those two classes, not
// in any per-command class this scope already covered. Added here rather
// than in a separate script or fixture, so one extraction technique remains
// responsible for the complete fixture.
const targets = d.files.filter(
  (f) =>
    (f.path.startsWith("zombie/commands/serverCommands/") ||
      f.path === "zombie/network/GameServer.class" ||
      f.path === "zombie/network/BanSystem.class" ||
      f.path === "zombie/network/ServerWorldDatabase.class" ||
      f.path === "zombie/network/ServerWorldDatabase$LogonResult.class") &&
    f.path.endsWith(".class"),
);

const perClassStrings = {};
for (const entry of targets) {
  const buf = await entry.buffer();
  let info;
  try {
    info = parseClass(buf);
  } catch {
    continue; // not a class this parser handles -- skip, don't fail the whole extraction over one entry
  }
  const strings = info.constantPool.filter((c) => c && c.tag === 1).map((c) => c.value);
  perClassStrings[entry.path] = strings;
}

let buildId = null;
try {
  const manifest = fs.readFileSync(appManifestPath, "utf8");
  buildId = manifest.match(/"buildid"\s*"(\d+)"/)?.[1] ?? null;
} catch {
  /* manifest not found at the assumed ../../appmanifest_108600.acf -- leave
     buildId null, don't fail extraction over it (see loud warning below) */
}
// appManifestPath is derived from jarPath by a hardcoded relative offset
// that assumes a standard Steam library layout (steamapps/common/<App>/
// jar, manifest two levels up in steamapps/). A jar living at any other
// path shape (e.g. a dedicated-server backup directory) silently resolves
// to a nonexistent manifest and buildId falls back to null with nothing
// but a terse trailing "build null" -- easy to miss and easy to commit a
// fixture with no provenance. Fail loudly instead: a fixture is only useful
// if a later drift can be attributed to a specific game build.
if (!buildId) {
  console.error(
    `WARNING: could not determine pzBuildId (looked for ${appManifestPath}). ` +
    "The fixture below would carry pzBuildId: null, making a future drift impossible to date. " +
    "Pass the real Steam-library jar path, or verify appmanifest_108600.acf actually lives at that location.",
  );
}

const fixture = {
  _provenance: {
    pzAppId: "108600",
    pzBuildId: buildId,
    extractedAt: new Date().toISOString().slice(0, 10),
    jarSourcePath: "projectzomboid.jar (repo root of the PZ Steam install)",
    classesScanned: Object.keys(perClassStrings).length,
    technique:
      "Structural JVM constant-pool parse via scripts/jar-audit/classfile-parser.mjs (parseClass), " +
      "not a flat strings/grep pass -- every value here is a genuine CONSTANT_Utf8 entry from the class file.",
    note:
      "Every UTF8 constant-pool string from every zombie/commands/serverCommands/*.class plus " +
      "zombie/network/GameServer.class (the command dispatcher, where 'Unknown command' lives, not in " +
      "any per-command class), zombie/network/BanSystem.class and zombie/network/ServerWorldDatabase.class " +
      "(plus its LogonResult inner class) because banuser/unbanuser/adduser/" +
      "removeuserfromwhitelist's own command classes carry no rejection text of their own; they return " +
      "whatever these two classes' methods hand back. apps/panel-server/tests/rconRejectionGroundTruth.test.js asserts " +
      "every pattern in rcon.js's KNOWN_RCON_REJECTIONS matches at least one string somewhere in this " +
      "corpus. A pattern matching nothing here is not a fixture bug -- it means the live jar no longer " +
      "contains that text, which is exactly the drift this fixture exists to catch.",
  },
  classes: perClassStrings,
};

fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`Wrote fixture: ${FIXTURE_PATH}`);
console.log(`Scanned ${fixture._provenance.classesScanned} classes, build ${buildId}.`);
