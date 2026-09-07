import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoDir = process.cwd();
const expectedVersion = String(process.argv[2] || process.env.GITHUB_REF_NAME || "")
  .replace(/^v/, "");
const expectedBuildSha = process.env.GITHUB_SHA || null;

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoDir, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(repoDir, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function collectFiles(absoluteDirectory, relativeDirectory = "") {
  const result = {};
  for (const entry of fs
    .readdirSync(absoluteDirectory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      Object.assign(result, collectFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      result[relativePath] = sha256(absolutePath);
    } else {
      throw new Error(`Unsupported release client entry: ${relativePath}`);
    }
  }
  return result;
}

function verify() {
  assert(/^\d+\.\d+\.\d+$/.test(expectedVersion), `Invalid release version: ${expectedVersion}`);

  const rootPackage = readJson("package.json");
  const clientPackage = readJson("apps/panel-client/package.json");
  const workspaceLock = readText("pnpm-lock.yaml");
  assert(workspaceLock.includes("lockfileVersion:"), "pnpm-lock.yaml is not a valid pnpm lockfile");
  assert(workspaceLock.includes("\n  .:\n") && workspaceLock.includes("\n  apps/panel-client:\n"),
    "pnpm-lock.yaml is missing the root or panel-client workspace importer");
  const versions = [
    ["package.json", rootPackage.version],
    ["apps/panel-client/package.json", clientPackage.version],
  ];
  for (const [label, version] of versions) {
    assert(version === expectedVersion, `${label} is ${version}, expected ${expectedVersion}`);
  }

  const lua = readText("integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua");
  const modInfo = readText("integrations/panelbridge/PanelBridge/mod.info");
  const runtime = [...lua.matchAll(/^\s*VERSION\s*=\s*"([^"]+)"/gm)];
  const manifest = [...modInfo.matchAll(/^modversion=([^\r\n]+)$/gm)];
  assert(runtime.length === 1 && manifest.length === 1,
    "PanelBridge must contain exactly one runtime and mod.info version");
  assert(runtime[0][1] === manifest[0][1],
    "PanelBridge runtime and mod.info versions differ");

  const releaseManifest = readJson("release/release-manifest.json");
  assert(releaseManifest.version === expectedVersion,
    `release-manifest.json is ${releaseManifest.version}, expected ${expectedVersion}`);
  if (expectedBuildSha) {
    assert(releaseManifest.buildSha === expectedBuildSha,
      `release-manifest.json build SHA is ${releaseManifest.buildSha}, expected ${expectedBuildSha}`);
  }

  const sourceClient = readJson("apps/panel-client/dist/build-info.json");
  const releaseClient = readJson("release/client/dist/build-info.json");
  for (const [label, metadata] of [["source client", sourceClient], ["release client", releaseClient]]) {
    assert(metadata.panelVersion === expectedVersion,
      `${label} panel version is ${metadata.panelVersion}, expected ${expectedVersion}`);
    assert(metadata.buildSha === releaseManifest.buildSha,
      `${label} build SHA does not match release manifest`);
    assert(Number(metadata.apiContractVersion) === Number(releaseManifest.apiContractVersion),
      `${label} API contract does not match release manifest`);
  }

  const sourceFiles = collectFiles(path.join(repoDir, "apps/panel-client/dist"));
  const manifestFiles = releaseManifest.clientFiles || {};
  const sourcePaths = Object.keys(sourceFiles).sort();
  const manifestPaths = Object.keys(manifestFiles).sort();
  assert(JSON.stringify(sourcePaths) === JSON.stringify(manifestPaths),
    "release-manifest.json client file inventory differs from apps/panel-client/dist");
  for (const relativePath of sourcePaths) {
    assert(sourceFiles[relativePath] === manifestFiles[relativePath],
      `client file hash mismatch: ${relativePath}`);
  }

  console.log(`Release ${expectedVersion} verified: ${sourcePaths.length} client files, PanelBridge ${runtime[0][1]}`);
}

try {
  verify();
} catch (error) {
  console.error(`Release verification failed: ${error.message}`);
  process.exitCode = 1;
}
