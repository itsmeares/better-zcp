import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { writeFileAtomic } from "./fileWriteQueue.ts";

const log = createLogger("Utils:ConfigBackup");

export interface BackupResult {
  backedUp: boolean;
  reason?: "no-source" | "failed" | "unchanged";
  name?: string;
  error?: string;
}

interface ParsedBackupName {
  timestampKey: string;
  suffix: number;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function getBackupPath(configPath: string): Promise<string> {
  return path.join(configPath, "backups");
}

const COLLISION_SUFFIX_RE = /^(.*Z)-(\d+)$/;

function parseBackupName(filename: string, name: string): ParsedBackupName {
  const rest = name.slice(filename.length + 1, name.length - ".bak".length);
  const match = rest.match(COLLISION_SUFFIX_RE);
  return match
    ? { timestampKey: match[1], suffix: parseInt(match[2], 10) }
    : { timestampKey: rest, suffix: 1 };
}

async function listBackupsFor(
  backupDir: string,
  filename: string,
): Promise<string[]> {
  let files: string[];
  try {
    files = await fs.promises.readdir(backupDir);
  } catch {
    return [];
  }
  const candidateNames = files.filter(
    (file) => file.startsWith(filename + ".") && file.endsWith(".bak"),
  );
  return candidateNames
    .map((name) => ({ name, ...parseBackupName(filename, name) }))
    .sort((a, b) => {
      if (a.timestampKey !== b.timestampKey) {
        return a.timestampKey < b.timestampKey ? 1 : -1;
      }
      return b.suffix - a.suffix;
    })
    .map((candidate) => candidate.name);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createBackup(
  configPath: string,
  filename: string,
): Promise<BackupResult> {
  const backupDir = await getBackupPath(configPath);
  const filePath = path.join(configPath, filename);

  try {
    await fs.promises.access(filePath);
  } catch (error: unknown) {
    log.debug(`Config backup source not found: ${filePath} — ${errorMessage(error)}`);
    return { backedUp: false, reason: "no-source" };
  }

  try {
    await fs.promises.mkdir(backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    let backupName = `${filename}.${timestamp}.bak`;
    let backupPath = path.join(backupDir, backupName);
    for (let suffix = 2; await pathExists(backupPath); suffix++) {
      backupName = `${filename}.${timestamp}-${suffix}.bak`;
      backupPath = path.join(backupDir, backupName);
    }

    await fs.promises.copyFile(filePath, backupPath);
    log.info(`Created backup: ${backupName}`);

    try {
      const backups = await listBackupsFor(backupDir, filename);

      if (backups.length > 10) {
        const filesToDelete = backups.slice(10);
        await Promise.all(
          filesToDelete.map((old) =>
            fs.promises
              .unlink(path.join(backupDir, old))
              .catch((error: unknown) =>
                log.warn(
                  `Failed to delete old backup ${old}: ${errorMessage(error)}`,
                ),
              ),
          ),
        );
      }
    } catch (cleanupError: unknown) {
      log.warn(
        `Backup cleanup failed (new backup ${backupName} is still safe): ${errorMessage(cleanupError)}`,
      );
    }

    return { backedUp: true, name: backupName };
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Backup creation failed: ${message}`);
    return { backedUp: false, reason: "failed", error: message };
  }
}

export async function createBackupIfChanged(
  configPath: string,
  filename: string,
): Promise<BackupResult> {
  const filePath = path.join(configPath, filename);
  let liveContent: Buffer;
  try {
    liveContent = await fs.promises.readFile(filePath);
  } catch {
    return createBackup(configPath, filename);
  }

  const backupDir = await getBackupPath(configPath);
  const existing = await listBackupsFor(backupDir, filename);
  if (existing.length > 0) {
    try {
      const mostRecent = await fs.promises.readFile(
        path.join(backupDir, existing[0]),
      );
      if (Buffer.compare(liveContent, mostRecent) === 0) {
        return { backedUp: false, reason: "unchanged" };
      }
    } catch (error: unknown) {
      log.debug(
        `Could not compare against most recent backup of ${filename}, backing up anyway: ${errorMessage(error)}`,
      );
    }
  }

  return createBackup(configPath, filename);
}

export function backupWarningFor(
  backup: BackupResult | null | undefined,
): string | null {
  if (!backup || backup.backedUp || backup.reason === "no-source") return null;
  return `Could not back up the previous version before saving: ${backup.error}. Your change was saved, but there is no safety copy of what was there before.`;
}

export async function writeIniWithBackup(
  iniPath: string,
  content: string | NodeJS.ArrayBufferView,
): Promise<BackupResult> {
  const configPath = path.dirname(iniPath);
  const filename = path.basename(iniPath);
  const backup = await createBackup(configPath, filename);
  writeFileAtomic(iniPath, content, "utf-8");
  return backup;
}
