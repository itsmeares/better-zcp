import { openRegularFile, readRegularFile } from "../utils/regularFile.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PANEL_API_CONTRACT_VERSION = 1;
const metadataSchema = z.object({ panelVersion: z.string().min(1), buildSha: z.string().min(1), apiContractVersion: z.number().int().positive() });
const managedNames = ["ZomboidControlPanel", "ZomboidControlPanel.exe", "client/dist", "Start.bat", "start.sh", "zomboid-panel.service", "install-linux-service.sh", "sql-wasm.wasm"] as const;
const dataNames = ["panel.sqlite", "jwt.secret", "server-secrets", "backups", "steamApiKey.secret", "reset-token.txt"] as const;
const journalSchema = z.object({
  schemaVersion: z.literal(2), transactionId: z.string().uuid(), version: z.string().min(1),
  phase: z.enum(["staged", "applying", "awaiting_startup_ack", "rollback_failed"]),
  metadata: metadataSchema,
  files: z.array(z.object({ name: z.enum(managedNames), sha256: z.string().regex(/^[a-f0-9]{64}$/), existed: z.boolean() })).min(2),
  dataDirectory: z.string().optional(), dataFiles: z.array(z.object({ name: z.enum(dataNames), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
});
export type BuildMetadata = z.infer<typeof metadataSchema>;
export type UpdateBundleJournal = z.infer<typeof journalSchema>;

function error(code: string, message: string): Error & { code: string } { return Object.assign(new Error(message), { code }); }

export function validateBuildCompatibility(frontend: unknown, backend: unknown) {
  const a = metadataSchema.safeParse(frontend), b = metadataSchema.safeParse(backend);
  const compatible = a.success && b.success && a.data.panelVersion === b.data.panelVersion && a.data.buildSha === b.data.buildSha && a.data.apiContractVersion === b.data.apiContractVersion;
  return compatible ? { compatible: true as const } : { compatible: false as const, diagnosticCode: "version_mismatch" as const, reason: "Frontend and backend build metadata do not match." };
}

export function hashUpdatePath(file: string): string {
  const hash = crypto.createHash("sha256");
  const walk = (current: string, relative: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw error("invalid_bundle", `Symlink in update bundle: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      if (relative) hash.update(`${relative}\0`);
      const fd = openRegularFile(current);
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let count: number;
        while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
      } finally { fs.closeSync(fd); }
      if (relative) hash.update("\0");
    } else throw error("invalid_bundle", `Unsupported update entry: ${relative}`);
  };
  walk(file, "");
  return hash.digest("hex");
}

function locations(journalPath: string, journal: UpdateBundleJournal) {
  const install = path.dirname(path.resolve(journalPath));
  return { install, stage: path.join(install, `.panel-update-${journal.transactionId}`), previous: path.join(install, `.panel-previous-${journal.transactionId}`) };
}

function writeJournal(file: string, journal: UpdateBundleJournal) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(journal), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export function readUpdateBundleJournalIfPresent(file: string): UpdateBundleJournal | null {
  let raw: string;
  try {
    raw = readRegularFile(file, 65536);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let journal: UpdateBundleJournal;
  try { journal = journalSchema.parse(JSON.parse(raw)); }
  catch { throw error("invalid_bundle", "Invalid update journal."); }
  if (new Set(journal.files.map(f => f.name)).size !== journal.files.length || !journal.files.some(f => f.name === "client/dist") || !journal.files.some(f => f.name === "ZomboidControlPanel" || f.name === "ZomboidControlPanel.exe")) throw error("invalid_bundle", "Invalid update file list.");
  if (journal.dataFiles && new Set(journal.dataFiles.map(file => file.name)).size !== journal.dataFiles.length) throw error("invalid_bundle", "Duplicate panel data backup entries.");
  if (journal.phase !== "staged" && (!journal.dataDirectory || !journal.dataFiles?.some(item => item.name === "panel.sqlite"))) throw error("invalid_bundle", "Applied update has no verified panel data backup.");
  return journal;
}

function assertManagedPath(install: string, name: string) {
  let current = install;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) throw error("invalid_bundle", `Managed path is a symlink: ${current}`); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
}

export function stageUpdateBundle(options: {
  installDir: string; version: string; binaryPath: string; stagedBinaryPath: string;
  liveClientPath: string; incomingClientPath: string; metadata: unknown;
  managedFiles?: Record<string, string>;
}): string {
  const metadata = metadataSchema.parse(options.metadata);
  if (metadata.panelVersion !== options.version || !validateBuildCompatibility(JSON.parse(fs.readFileSync(path.join(options.incomingClientPath, "build-info.json"), "utf8")), metadata).compatible) throw error("version_mismatch", "Staged frontend and backend builds do not match.");
  if (!fs.statSync(path.join(options.incomingClientPath, "index.html")).isFile()) throw error("invalid_bundle", "Missing frontend index.html.");
  const install = fs.realpathSync(options.installDir);
  const file = path.join(install, "update-bundle.json");
  const previous = readUpdateBundleJournalIfPresent(file);
  if (previous && previous.phase !== "staged") throw error("apply_in_progress", "An update is already being applied.");
  const binaryName = path.basename(options.binaryPath);
  const sources = { [binaryName]: options.stagedBinaryPath, "client/dist": options.incomingClientPath, ...options.managedFiles };
  const journal: UpdateBundleJournal = { schemaVersion: 2, transactionId: crypto.randomUUID(), version: options.version, phase: "staged", metadata, files: [] };
  const dirs = locations(file, journal);
  try {
    fs.mkdirSync(dirs.stage, { mode: 0o700 });
    for (const [name, source] of Object.entries(sources)) {
      if (!(managedNames as readonly string[]).includes(name)) throw error("invalid_bundle", `Unmanaged update path: ${name}`);
      assertManagedPath(install, name);
      hashUpdatePath(source); // Reject links before copying, including directory entries.
      const destination = path.join(dirs.stage, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, dereference: false });
      journal.files.push({ name: name as typeof managedNames[number], sha256: hashUpdatePath(destination), existed: fs.existsSync(path.join(install, name)) });
    }
    writeJournal(file, journal);
  } catch (e) { fs.rmSync(dirs.stage, { recursive: true, force: true }); throw e; }
  if (previous) fs.rmSync(locations(file, previous).stage, { recursive: true, force: true });
  return file;
}

function requireJournal(file: string) {
  const journal = readUpdateBundleJournalIfPresent(file);
  if (!journal) throw error("invalid_bundle", "Update journal is missing.");
  return journal;
}

// Called by the supervisor only after the old panel process has exited and closed SQLite.
export function applyUpdateBundle(file: string, dataDirectory: string): UpdateBundleJournal {
  const journal = requireJournal(file);
  if (journal.phase !== "staged") throw error("apply_in_progress", "Update is not staged.");
  const dirs = locations(file, journal);
  for (const item of journal.files) {
    assertManagedPath(dirs.install, item.name);
    if (fs.existsSync(path.join(dirs.install, item.name)) !== item.existed) throw error("invalid_bundle", "Installed files changed after staging.");
    try {
      if (hashUpdatePath(path.join(dirs.stage, item.name)) !== item.sha256) throw error("av_quarantine", `Staged file changed: ${item.name}`);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") throw error("hash_unverifiable", `Staged file is missing: ${item.name}`); throw e; }
  }
  fs.rmSync(dirs.previous, { recursive: true, force: true });
  fs.mkdirSync(dirs.previous, { mode: 0o700 });
  if (dataDirectory) {
    journal.dataDirectory = fs.realpathSync(dataDirectory);
    journal.dataFiles = [];
    for (const name of dataNames) {
      const source = path.join(journal.dataDirectory, name);
      if (name === "panel.sqlite" && !fs.existsSync(source)) throw error("data_backup_failed", "Panel database is missing; update refused.");
      if (!fs.existsSync(source)) continue;
      hashUpdatePath(source);
      const target = path.join(dirs.previous, "data", name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.cpSync(source, target, { recursive: true });
      if (hashUpdatePath(source) !== hashUpdatePath(target)) throw error("data_backup_failed", `Could not verify backup of ${name}.`);
      journal.dataFiles.push({ name, sha256: hashUpdatePath(target) });
    }
  }
  journal.phase = "applying";
  writeJournal(file, journal);
  try {
    for (const item of journal.files) {
      const live = path.join(dirs.install, item.name), previous = path.join(dirs.previous, item.name);
      fs.mkdirSync(path.dirname(previous), { recursive: true });
      if (item.existed) fs.renameSync(live, previous);
      fs.mkdirSync(path.dirname(live), { recursive: true });
      fs.renameSync(path.join(dirs.stage, item.name), live);
    }
    journal.phase = "awaiting_startup_ack";
    writeJournal(file, journal);
    return journal;
  } catch (e) { recoverInterruptedUpdateBundle(file, dataDirectory); throw e; }
}

export function acknowledgeUpdateBundle(file: string, runningMetadata: unknown): boolean {
  const journal = readUpdateBundleJournalIfPresent(file);
  if (!journal || journal.phase !== "awaiting_startup_ack") return false;
  const dirs = locations(file, journal);
  const frontend = JSON.parse(fs.readFileSync(path.join(dirs.install, "client/dist/build-info.json"), "utf8"));
  if (!validateBuildCompatibility(journal.metadata, runningMetadata).compatible || !validateBuildCompatibility(frontend, runningMetadata).compatible) throw error("version_mismatch", "New panel failed build verification.");
  for (const item of journal.files) if (hashUpdatePath(path.join(dirs.install, item.name)) !== item.sha256) throw error("hash_unverifiable", `Installed file changed: ${item.name}`);
  // Committing and reporting are separate from cleanup: never roll back a healthy panel for a cleanup error.
  fs.rmSync(file);
  try {
    const retained = path.join(dirs.install, `.panel-data-before-${journal.transactionId}`);
    fs.renameSync(path.join(dirs.previous, "data"), retained);
    fs.writeFileSync(path.join(retained, "snapshot.json"), JSON.stringify({ targetVersion: journal.version, createdAt: new Date().toISOString(), sourceDataDirectory: journal.dataDirectory, files: journal.dataFiles }), { mode: 0o600 });
    fs.rmSync(dirs.stage, { recursive: true, force: true });
    fs.rmSync(dirs.previous, { recursive: true, force: true });
    const snapshots = fs.readdirSync(dirs.install).filter(name => /^\.panel-data-before-[0-9a-f-]{36}$/.test(name))
      .map(name => ({ file: path.join(dirs.install, name), stat: fs.lstatSync(path.join(dirs.install, name)) }))
      .filter(item => item.stat.isDirectory() && !item.stat.isSymbolicLink()).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const snapshot of snapshots.slice(5)) fs.rmSync(snapshot.file, { recursive: true });
  } catch (e) { console.error(`Panel update committed; private backup cleanup needs attention: ${(e as Error).message}`); }

  return true;
}

export function recoverInterruptedUpdateBundle(file: string, dataDirectory?: string): boolean {
  const journal = readUpdateBundleJournalIfPresent(file);
  if (!journal || journal.phase === "staged") return false;
  const dirs = locations(file, journal);
  try {
    for (const item of journal.files) {
      assertManagedPath(dirs.install, item.name);
      const live = path.join(dirs.install, item.name), previous = path.join(dirs.previous, item.name);
      if (fs.existsSync(previous)) {
        fs.rmSync(live, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(live), { recursive: true });
        fs.renameSync(previous, live);
      } else if (!item.existed) fs.rmSync(live, { recursive: true, force: true });
    }
    if (journal.dataDirectory) {
      if (!dataDirectory || fs.realpathSync(dataDirectory) !== journal.dataDirectory) throw error("rollback_failed", "Panel data directory does not match the update backup.");
      for (const name of dataNames) {
        const target = path.join(journal.dataDirectory, name);
        assertManagedPath(journal.dataDirectory, name);
        const backup = journal.dataFiles?.find(item => item.name === name);
        if (backup) {
          const source = path.join(dirs.previous, "data", name);
          if (hashUpdatePath(source) !== backup.sha256) throw error("rollback_failed", `Panel data backup changed: ${name}`);
          fs.rmSync(target, { recursive: true, force: true });
          fs.cpSync(source, target, { recursive: true });
        } else fs.rmSync(target, { recursive: true, force: true });
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(path.join(journal.dataDirectory, `panel.sqlite${suffix}`), { force: true });
    }
    fs.rmSync(file);
    fs.rmSync(dirs.stage, { recursive: true, force: true });
    fs.rmSync(dirs.previous, { recursive: true, force: true });
    return true;
  } catch (e) {
    journal.phase = "rollback_failed";
    writeJournal(file, journal);
    throw error("rollback_failed", `Panel update rollback failed: ${(e as Error).message}`);
  }
}
