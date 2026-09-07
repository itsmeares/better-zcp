import crypto from "crypto";
import fs from "fs";
import path from "path";

export const PANEL_API_CONTRACT_VERSION = 1;

const JOURNAL_PHASES = new Set([
  "staged",
  "applying",
  "binary_backed_up",
  "client_backed_up",
  "client_activated",
  "awaiting_startup_ack",
  "rollback_failed",
  "rolled_back",
]);

const REQUIRED_JOURNAL_PATHS = [
  "binary",
  "stagedBinary",
  "backupBinary",
  "liveClient",
  "stagedClient",
  "backupClient",
 ] as const;

type JournalPhase =
  | "staged"
  | "applying"
  | "binary_backed_up"
  | "client_backed_up"
  | "client_activated"
  | "awaiting_startup_ack"
  | "rollback_failed"
  | "rolled_back";

interface BuildMetadata {
  panelVersion: string;
  buildSha: string;
  apiContractVersion: number;
}

interface BundlePaths {
  binary: string;
  stagedBinary: string;
  backupBinary: string;
  liveClient: string;
  stagedClient: string;
  backupClient: string;
}

interface BundleHashes {
  binarySha256: string;
  clientSha256: string;
  clientFiles: string[];
}

interface UpdateBundleJournal {
  schemaVersion: 1;
  transactionId: string;
  version: string;
  phase: JournalPhase;
  stagedAt: string;
  appliedAt?: string;
  installDir: string;
  metadata: BuildMetadata;
  hashes: BundleHashes;
  paths: BundlePaths;
  failureCode?: string;
  rollbackErrors?: string[];
}

interface UpdateBundleError extends Error {
  code: string;
}

interface PendingBundleInspectionOptions {
  journalPath: string;
  applyingMarkerPath?: string | null;
  runningMetadata: unknown;
}

interface AcknowledgeBundleOptions {
  transactionId?: string;
  expectedMetadata?: unknown;
  applyingMarkerPath?: string | null;
}

interface StageUpdateBundleOptions {
  installDir: string;
  version: string;
  binaryPath: string;
  stagedBinaryPath: string;
  liveClientPath: string;
  incomingClientPath: string;
  metadata: unknown;
}

type CompatibilityResult =
  | { compatible: true }
  | { compatible: false; diagnosticCode: "version_mismatch"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function updateError(
  code: string,
  message: string,
  cause?: unknown,
): UpdateBundleError {
  const error = new Error(message, cause ? { cause } : undefined) as UpdateBundleError;
  error.code = code;
  return error;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function sha256Directory(dirPath: string): { hash: string; pairs: string[] } {
  const pairs: string[] = [];
  const walk = (dir: string, rel: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (entry.isFile()) {
        pairs.push(`${relativePath}:${sha256File(absolutePath)}`);
      } else {
        throw updateError(
          "invalid_bundle",
          `Unsupported client bundle entry: ${relativePath}`,
        );
      }
    }
  };
  walk(dirPath, "");
  const parts = pairs.map((pair) => {
    const separatorIndex = pair.indexOf(":");
    const relativePath = pair.slice(0, separatorIndex);
    const fileHash = pair.slice(separatorIndex + 1);
    return `${relativePath}\0${fileHash}\n`;
  });
  const hash = crypto.createHash("sha256").update(parts.join(""), "utf8").digest("hex");
  return { hash, pairs };
}

function readJson(filePath: string, expectedErrorCode = "invalid_bundle"): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (errorCode(error) === expectedErrorCode) throw error;
    throw updateError(expectedErrorCode, `Could not read JSON from ${filePath}`, error);
  }
}

function renameIfPresent(source: string, destination: string): boolean {
  try {
    fs.renameSync(source, destination);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function writeJournal(journalPath: string, journal: UpdateBundleJournal): void {
  const temporaryPath = `${journalPath}.tmp-${process.pid}`;
  const previousPath = `${journalPath}.previous`;
  fs.writeFileSync(temporaryPath, JSON.stringify(journal, null, 2), "utf8");
  fs.rmSync(previousPath, { force: true });
  renameIfPresent(journalPath, previousPath);
  try {
    fs.renameSync(temporaryPath, journalPath);
    fs.rmSync(previousPath, { force: true });
  } catch (error) {
    renameIfPresent(previousPath, journalPath);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function normalizedMetadata(value: unknown): BuildMetadata {
  const record = isRecord(value) ? value : {};
  return {
    panelVersion: String(record.panelVersion || ""),
    buildSha: String(record.buildSha || ""),
    apiContractVersion: Number(record.apiContractVersion),
  };
}

function hasValidMetadata(value: unknown): boolean {
  const metadata = normalizedMetadata(value);
  return (
    metadata.panelVersion !== "" &&
    metadata.buildSha !== "" &&
    Number.isInteger(metadata.apiContractVersion) &&
    metadata.apiContractVersion > 0
  );
}

export function validateBuildCompatibility(
  frontend: unknown,
  backend: unknown,
): CompatibilityResult {
  const client = normalizedMetadata(frontend);
  const server = normalizedMetadata(backend);
  const compatible =
    client.panelVersion !== "" &&
    client.panelVersion === server.panelVersion &&
    client.buildSha !== "" &&
    client.buildSha === server.buildSha &&
    client.apiContractVersion === server.apiContractVersion;
  return compatible
    ? { compatible: true }
    : {
        compatible: false,
        diagnosticCode: "version_mismatch",
        reason: "Frontend and backend build metadata do not match.",
      };
}

function assertInsideInstall(
  installDir: string,
  candidate: unknown,
  label: string,
): string {
  if (typeof candidate !== "string") {
    throw updateError("invalid_bundle", `${label} is not a valid path`);
  }
  const resolvedInstallDir = path.resolve(installDir);
  const root = `${resolvedInstallDir}${path.sep}`;
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedInstallDir && !resolved.startsWith(root)) {
    throw updateError("invalid_bundle", `${label} is outside the install directory`);
  }
  return resolved;
}

function validateJournal(
  journal: unknown,
  journalPath: string,
): UpdateBundleJournal {
  if (!isRecord(journal)) {
    throw updateError("invalid_bundle", "Update bundle journal is invalid");
  }
  const hashes = isRecord(journal.hashes) ? journal.hashes : null;
  const paths = isRecord(journal.paths) ? journal.paths : null;
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.transactionId !== "string" ||
    journal.transactionId === "" ||
    typeof journal.version !== "string" ||
    typeof journal.phase !== "string" ||
    !JOURNAL_PHASES.has(journal.phase) ||
    typeof journal.installDir !== "string" ||
    !hasValidMetadata(journal.metadata) ||
    typeof hashes?.binarySha256 !== "string" ||
    hashes.binarySha256 === "" ||
    typeof hashes.clientSha256 !== "string" ||
    hashes.clientSha256 === "" ||
    !paths
  ) {
    throw updateError("invalid_bundle", "Update bundle journal is invalid");
  }

  const installDir = path.resolve(journal.installDir);
  if (path.dirname(path.resolve(journalPath)) !== installDir) {
    throw updateError(
      "invalid_bundle",
      "Update bundle journal does not match its installation directory",
    );
  }
  assertInsideInstall(installDir, journalPath, "journal");
  for (const label of REQUIRED_JOURNAL_PATHS) {
    assertInsideInstall(installDir, paths[label], label);
  }
  return journal as unknown as UpdateBundleJournal;
}

export function readUpdateBundleJournalIfPresent(
  journalPath: string,
): UpdateBundleJournal | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(journalPath, "r");
    let journal: unknown;
    try {
      journal = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    } catch (error) {
      throw updateError("invalid_bundle", "Update bundle journal is not valid JSON", error);
    }
    return validateJournal(journal, journalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (errorCode(error) === "invalid_bundle") throw error;
    throw updateError("invalid_bundle", "Could not read update bundle journal", error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function markerIsPresent(
  markerPath: string | null | undefined,
  installDir: string,
): boolean {
  if (!markerPath) return false;
  assertInsideInstall(installDir, markerPath, "applying marker");
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(markerPath, "r");
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw updateError("invalid_bundle", "Could not inspect update applying marker", error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureCompatibleBundle(
  journal: UpdateBundleJournal,
  runningMetadata: unknown,
): void {
  const backendCompatibility = validateBuildCompatibility(
    journal.metadata,
    runningMetadata,
  );
  const frontendCompatibility = validateBuildCompatibility(
    readJson(path.join(journal.paths.liveClient, "build-info.json")),
    runningMetadata,
  );
  if (!backendCompatibility.compatible || !frontendCompatibility.compatible) {
    throw updateError(
      "version_mismatch",
      "Applied frontend and backend metadata do not match",
    );
  }
}

function sameAcknowledgementState(
  previous: UpdateBundleJournal,
  current: UpdateBundleJournal,
): boolean {
  return (
    previous.transactionId === current.transactionId &&
    previous.phase === current.phase &&
    previous.hashes.binarySha256 === current.hashes.binarySha256 &&
    previous.hashes.clientSha256 === current.hashes.clientSha256 &&
    validateBuildCompatibility(previous.metadata, current.metadata).compatible &&
    REQUIRED_JOURNAL_PATHS.every(
      (label) => previous.paths[label] === current.paths[label],
    )
  );
}

export function inspectPendingUpdateBundle({
  journalPath,
  applyingMarkerPath,
  runningMetadata,
}: PendingBundleInspectionOptions) {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) {
    return { pending: false, awaitingStartupAck: false };
  }

  const windowsApplication =
    journal.phase === "staged" &&
    markerIsPresent(applyingMarkerPath, journal.installDir);
  const awaitingStartupAck =
    journal.phase === "awaiting_startup_ack" || windowsApplication;

  if (awaitingStartupAck) ensureCompatibleBundle(journal, runningMetadata);

  return {
    pending: true,
    awaitingStartupAck,
    phase: journal.phase,
    transactionId: journal.transactionId,
    metadata: normalizedMetadata(journal.metadata),
    applyingMarkerPath,
  };
}

export function stageUpdateBundle({
  installDir,
  version,
  binaryPath,
  stagedBinaryPath,
  liveClientPath,
  incomingClientPath,
  metadata,
}: StageUpdateBundleOptions): string {
  const expectedMetadata = normalizedMetadata(metadata);
  const compatibility = validateBuildCompatibility(
    readJson(path.join(incomingClientPath, "build-info.json")),
    expectedMetadata,
  );
  if (!compatibility.compatible) {
    throw updateError(compatibility.diagnosticCode, compatibility.reason);
  }

  let binarySha256;
  try {
    binarySha256 = sha256File(stagedBinaryPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw updateError("av_quarantine", "Staged update binary is missing", error);
    }
    throw error;
  }
  let indexDescriptor;
  try {
    indexDescriptor = fs.openSync(path.join(incomingClientPath, "index.html"), "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw updateError(
        "frontend_swap_failed",
        "Staged frontend does not contain index.html",
        error,
      );
    }
    throw error;
  } finally {
    if (indexDescriptor !== undefined) fs.closeSync(indexDescriptor);
  }

  const resolvedInstallDir = path.resolve(installDir);
  const safeVersion = String(version).replace(/[^0-9A-Za-z._-]/g, "-");
  const stagedClientPath = path.join(
    resolvedInstallDir,
    "client",
    `dist.new-${safeVersion}`,
  );
  const backupBinaryPath = `${binaryPath}.bundle-previous`;
  const backupClientPath = path.join(
    path.dirname(liveClientPath),
    "dist.previous",
  );
  const journalPath = path.join(resolvedInstallDir, "update-bundle.json");

  for (const [label, candidate] of Object.entries({
    binaryPath,
    stagedBinaryPath,
    liveClientPath,
    incomingClientPath,
    stagedClientPath,
    backupBinaryPath,
    backupClientPath,
  })) {
    assertInsideInstall(resolvedInstallDir, candidate, label);
  }

  fs.rmSync(stagedClientPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(stagedClientPath), { recursive: true });
  fs.cpSync(incomingClientPath, stagedClientPath, { recursive: true });
  const { hash: clientSha256, pairs: clientFiles } = sha256Directory(stagedClientPath);

  const journal: UpdateBundleJournal = {
    schemaVersion: 1,
    transactionId: crypto.randomUUID(),
    version: String(version),
    phase: "staged",
    stagedAt: new Date().toISOString(),
    installDir: resolvedInstallDir,
    metadata: expectedMetadata,
    hashes: { binarySha256, clientSha256, clientFiles },
    paths: {
      binary: path.resolve(binaryPath),
      stagedBinary: path.resolve(stagedBinaryPath),
      backupBinary: path.resolve(backupBinaryPath),
      liveClient: path.resolve(liveClientPath),
      stagedClient: path.resolve(stagedClientPath),
      backupClient: path.resolve(backupClientPath),
    },
  };
  writeJournal(journalPath, journal);
  return journalPath;
}

function rollback(
  journalPath: string,
  journal: UpdateBundleJournal,
  reason: string,
): string[] {
  const { paths } = journal;
  const rollbackErrors: string[] = [];
  const restore = (
    live: string,
    backup: string,
    isDirectory: boolean,
  ): void => {
    const capturedBackup = `${backup}.restoring-${process.pid}`;
    try {
      fs.rmSync(capturedBackup, { recursive: isDirectory, force: true });
      if (!renameIfPresent(backup, capturedBackup)) return;
      try {
        fs.rmSync(live, { recursive: isDirectory, force: true });
        fs.renameSync(capturedBackup, live);
      } catch (error) {
        renameIfPresent(capturedBackup, backup);
        throw error;
      }
    } catch (error) {
      rollbackErrors.push(errorMessage(error));
    }
  };
  restore(paths.binary, paths.backupBinary, false);
  restore(paths.liveClient, paths.backupClient, true);
  journal.phase = rollbackErrors.length ? "rollback_failed" : "rolled_back";
  journal.failureCode = reason;
  journal.rollbackErrors = rollbackErrors;
  writeJournal(journalPath, journal);
  if (!rollbackErrors.length) fs.rmSync(journalPath, { force: true });
  return rollbackErrors;
}

export function applyUpdateBundle(journalPath: string): UpdateBundleJournal {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) throw updateError("invalid_bundle", "Update bundle journal is missing");
  const { paths } = journal;
  let stagedBinaryHash;
  try {
    stagedBinaryHash = sha256File(paths.stagedBinary);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw updateError("av_quarantine", "Staged update binary is missing", error);
    }
    throw error;
  }
  if (stagedBinaryHash !== journal.hashes.binarySha256) {
    throw updateError("av_quarantine", "Staged update binary hash changed");
  }
  let stagedClientHash;
  try {
    ({ hash: stagedClientHash } = sha256Directory(paths.stagedClient));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw updateError("av_quarantine", "Staged client bundle is missing", error);
    }
    throw error;
  }
  if (stagedClientHash !== journal.hashes.clientSha256) {
    throw updateError("av_quarantine", "Staged client bundle hash changed");
  }
  const clientCompatibility = validateBuildCompatibility(
    readJson(path.join(paths.stagedClient, "build-info.json")),
    journal.metadata,
  );
  if (!clientCompatibility.compatible) {
    throw updateError(
      clientCompatibility.diagnosticCode,
      clientCompatibility.reason,
    );
  }

  fs.rmSync(paths.backupBinary, { force: true });
  fs.rmSync(paths.backupClient, { recursive: true, force: true });
  journal.phase = "applying";
  writeJournal(journalPath, journal);

  try {
    renameIfPresent(paths.binary, paths.backupBinary);
    journal.phase = "binary_backed_up";
    writeJournal(journalPath, journal);

    renameIfPresent(paths.liveClient, paths.backupClient);
    journal.phase = "client_backed_up";
    writeJournal(journalPath, journal);

    try {
      fs.renameSync(paths.stagedClient, paths.liveClient);
    } catch (error) {
      throw updateError("frontend_swap_failed", "Could not activate staged frontend", error);
    }
    journal.phase = "client_activated";
    writeJournal(journalPath, journal);

    try {
      fs.renameSync(paths.stagedBinary, paths.binary);
    } catch (error) {
      throw updateError("binary_swap_failed", "Could not activate staged binary", error);
    }
    journal.phase = "awaiting_startup_ack";
    journal.appliedAt = new Date().toISOString();
    writeJournal(journalPath, journal);
    return journal;
  } catch (error) {
    const code = errorCode(error) || "bundle_apply_failed";
    rollback(journalPath, journal, code);
    throw error;
  }
}

export function acknowledgeUpdateBundle(
  journalPath: string,
  runningMetadata: unknown,
  {
    transactionId,
    expectedMetadata,
    applyingMarkerPath,
  }: AcknowledgeBundleOptions = {},
): boolean {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) return false;

  if (transactionId && journal.transactionId !== transactionId) {
    throw updateError(
      "invalid_bundle",
      "Update bundle transaction changed before startup acknowledgement",
    );
  }
  if (
    expectedMetadata &&
    !validateBuildCompatibility(journal.metadata, expectedMetadata).compatible
  ) {
    throw updateError(
      "invalid_bundle",
      "Update bundle metadata changed before startup acknowledgement",
    );
  }

  const windowsApplication =
    journal.phase === "staged" &&
    markerIsPresent(applyingMarkerPath, journal.installDir);
  if (journal.phase !== "awaiting_startup_ack" && !windowsApplication) return false;

  const confirmedJournal = readUpdateBundleJournalIfPresent(journalPath);
  if (!confirmedJournal) return false;
  if (!sameAcknowledgementState(journal, confirmedJournal)) {
    throw updateError(
      "invalid_bundle",
      "Update bundle state changed before startup acknowledgement",
    );
  }
  if (
    windowsApplication &&
    !markerIsPresent(applyingMarkerPath, confirmedJournal.installDir)
  ) {
    return false;
  }

  try {
    ensureCompatibleBundle(confirmedJournal, runningMetadata);
  } catch (error) {
    if (errorCode(error) !== "version_mismatch") throw error;
    const rollbackErrors = rollback(
      journalPath,
      confirmedJournal,
      "version_mismatch",
    );
    if (!rollbackErrors.length && applyingMarkerPath) {
      fs.rmSync(applyingMarkerPath, { force: true });
    }
    throw error;
  }

  fs.rmSync(confirmedJournal.paths.backupBinary, { force: true });
  fs.rmSync(confirmedJournal.paths.backupClient, { recursive: true, force: true });
  fs.rmSync(journalPath, { force: true });
  if (applyingMarkerPath) fs.rmSync(applyingMarkerPath, { force: true });
  return true;
}

export function recoverInterruptedUpdateBundle(
  journalPath: string,
  reason = "startup_handshake_failed",
): boolean {
  const journal = readUpdateBundleJournalIfPresent(journalPath);
  if (!journal) return false;
  if (journal.phase === "staged") return false;
  const errors = rollback(journalPath, journal, reason);
  if (errors.length) {
    throw updateError(
      "rollback_failed",
      `Update rollback was incomplete: ${errors.join(", ")}`,
    );
  }
  return true;
}
