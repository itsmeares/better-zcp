#!/usr/bin/env node

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
    continue;
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
      "whatever these two classes' methods hand back. apps/panel-server/tests/rconRejectionGroundTruth.test.ts asserts " +
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
