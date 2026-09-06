import fs from "fs";
import os from "os";
import path from "path";
import { gunzipSync } from "zlib";
import { getDataPaths } from "./paths.js";

let decodedBundle;
let materializedPath;

function readCompileTimeMetadata() {
  const panelVersion =
    typeof PANEL_VERSION !== "undefined" ? String(PANEL_VERSION) : "";
  const buildSha =
    typeof PANEL_BUILD_SHA !== "undefined" ? String(PANEL_BUILD_SHA) : "";
  const apiContractVersion =
    typeof PANEL_API_CONTRACT_VERSION !== "undefined"
      ? Number(PANEL_API_CONTRACT_VERSION)
      : null;
  if (!panelVersion || !buildSha || !Number.isInteger(apiContractVersion)) {
    return null;
  }
  return { panelVersion, buildSha, apiContractVersion };
}

function decodeBundle(encoded) {
  if (!encoded) return null;
  const bundle = JSON.parse(
    gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"),
  );
  if (
    !bundle ||
    bundle.schemaVersion !== 1 ||
    !bundle.files ||
    typeof bundle.files !== "object" ||
    Array.isArray(bundle.files) ||
    typeof bundle.files["index.html"] !== "string" ||
    typeof bundle.files["build-info.json"] !== "string"
  ) {
    throw new Error("Embedded client bundle is invalid");
  }
  return bundle;
}

function getEmbeddedBundle() {
  if (decodedBundle !== undefined) return decodedBundle;
  try {
    const encoded =
      typeof PANEL_CLIENT_DIST_B64 !== "undefined"
        ? PANEL_CLIENT_DIST_B64
        : "";
    decodedBundle = decodeBundle(encoded);
  } catch (error) {
    throw new Error(`Could not decode embedded client bundle: ${error.message}`, {
      cause: error,
    });
  }
  return decodedBundle;
}

function readBundleMetadata(bundle) {
  try {
    const metadata = JSON.parse(
      Buffer.from(bundle.files["build-info.json"], "base64").toString("utf8"),
    );
    if (
      typeof metadata?.panelVersion !== "string" ||
      typeof metadata?.buildSha !== "string" ||
      !Number.isInteger(Number(metadata?.apiContractVersion))
    ) {
      throw new Error("build-info.json is invalid");
    }
    return {
      panelVersion: metadata.panelVersion,
      buildSha: metadata.buildSha,
      apiContractVersion: Number(metadata.apiContractVersion),
    };
  } catch (error) {
    throw new Error(`Embedded client metadata is invalid: ${error.message}`, {
      cause: error,
    });
  }
}

function metadataMatches(actual, expected) {
  if (!actual) return false;
  return (
    !expected ||
    (actual.panelVersion === expected.panelVersion &&
      actual.buildSha === expected.buildSha &&
      actual.apiContractVersion === expected.apiContractVersion)
  );
}

export function readClientDistMetadata(clientDistPath) {
  try {
    const metadata = JSON.parse(
      fs.readFileSync(path.join(clientDistPath, "build-info.json"), "utf8"),
    );
    if (
      typeof metadata?.panelVersion !== "string" ||
      typeof metadata?.buildSha !== "string" ||
      !Number.isInteger(Number(metadata?.apiContractVersion))
    ) {
      return null;
    }
    return {
      panelVersion: metadata.panelVersion,
      buildSha: metadata.buildSha,
      apiContractVersion: Number(metadata.apiContractVersion),
    };
  } catch {
    return null;
  }
}

export function clientDistMatchesMetadata(clientDistPath, expectedMetadata) {
  const actualMetadata = readClientDistMetadata(clientDistPath);
  return Boolean(actualMetadata && metadataMatches(actualMetadata, expectedMetadata));
}

function safeBundleName(metadata) {
  const bundleName = `${metadata.panelVersion}-${metadata.buildSha}`
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 100);
  return `zomboid-panel-client-${bundleName}`;
}

function defaultMaterializationRoot() {
  if (typeof process.pkg !== "undefined") {
    return path.join(getDataPaths().dataDir, ".embedded-client");
  }
  return os.tmpdir();
}

function resolveBundleFile(tempPath, relativePath) {
  const normalized = String(relativePath).replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "..") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Embedded client contains an unsafe path: ${relativePath}`);
  }
  const destination = path.join(tempPath, ...normalized.split("/"));
  const relative = path.relative(tempPath, destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Embedded client path escapes its bundle: ${relativePath}`);
  }
  return destination;
}

function usableMaterializedBundle(targetPath, bundle, metadata) {
  if (
    !fs.existsSync(path.join(targetPath, ".ready")) ||
    !fs.existsSync(path.join(targetPath, "index.html"))
  ) {
    return false;
  }
  try {
    if (!metadataMatches(readClientDistMetadata(targetPath), metadata)) return false;
    for (const [relativePath, encodedContents] of Object.entries(bundle.files)) {
      const destination = resolveBundleFile(targetPath, relativePath);
      const actual = fs.readFileSync(destination);
      const expected = Buffer.from(encodedContents, "base64");
      if (!actual.equals(expected)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function removeStaleMaterializedBundles(rootDir, keepPath) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  const candidates = entries
    .filter((entry) => entry.name.startsWith(".zomboid-panel-client-"))
    .map((entry) => {
      const candidate = path.join(rootDir, entry.name);
      let modifiedAt = 0;
      try {
        modifiedAt = fs.statSync(candidate).mtimeMs;
      } catch {
        /* remove below if it is no longer accessible */
      }
      return { candidate, modifiedAt };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  const retained = new Set([
    keepPath,
    ...candidates.slice(0, 2).map(({ candidate }) => candidate),
  ]);
  for (const { candidate } of candidates) {
    if (retained.has(candidate)) continue;
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
    } catch {
      // Another process may still be finishing its startup extraction.
    }
  }
}

export function materializeEmbeddedClientBundle(
  bundle,
  expectedMetadata = null,
  rootDir = defaultMaterializationRoot(),
) {
  const actualMetadata = readBundleMetadata(bundle);
  if (!metadataMatches(actualMetadata, expectedMetadata)) {
    throw new Error("Embedded client metadata does not match the executable");
  }

  fs.mkdirSync(rootDir, { recursive: true });
  try {
    fs.chmodSync(rootDir, 0o700);
  } catch {
    /* best-effort on Windows */
  }
  const temporaryPath = fs.mkdtempSync(
    path.join(rootDir, `.${safeBundleName(actualMetadata)}-`),
  );
  try {
    try {
      fs.chmodSync(temporaryPath, 0o700);
    } catch {
      /* best-effort on Windows */
    }
    for (const [relativePath, encodedContents] of Object.entries(bundle.files)) {
      if (typeof encodedContents !== "string") {
        throw new Error(`Embedded client file is not encoded: ${relativePath}`);
      }
      const destination = resolveBundleFile(temporaryPath, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, Buffer.from(encodedContents, "base64"));
    }
    fs.writeFileSync(
      path.join(temporaryPath, ".ready"),
      JSON.stringify(actualMetadata),
      "utf8",
    );
    removeStaleMaterializedBundles(rootDir, temporaryPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }
  return temporaryPath;
}

export function getEmbeddedClientDistPath() {
  const bundle = getEmbeddedBundle();
  if (!bundle) return null;

  const expectedMetadata = readCompileTimeMetadata();
  const actualMetadata = readBundleMetadata(bundle);
  if (!metadataMatches(actualMetadata, expectedMetadata)) {
    throw new Error("Embedded client metadata does not match the executable");
  }
  if (materializedPath && usableMaterializedBundle(materializedPath, bundle, actualMetadata)) {
    return materializedPath;
  }
  materializedPath = materializeEmbeddedClientBundle(
    bundle,
    expectedMetadata,
    defaultMaterializationRoot(),
  );
  return materializedPath;
}

export function resolveClientDistPath({
  packaged,
  embeddedPath,
  externalPath,
}) {
  return packaged && embeddedPath ? embeddedPath : externalPath;
}