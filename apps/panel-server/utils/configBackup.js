import fs from "fs";
import path from "path";
import { createLogger } from "./logger.js";
import { writeFileAtomic } from "./fileWriteQueue.js";

const log = createLogger("Utils:ConfigBackup");

async function pathExists(candidatePath) {
  try {
    await fs.promises.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function getBackupPath(configPath) {
  return path.join(configPath, "backups");
}

const COLLISION_SUFFIX_RE = /^(.*Z)-(\d+)$/;

function parseBackupName(filename, name) {
  const rest = name.slice(filename.length + 1, name.length - ".bak".length);
  const match = rest.match(COLLISION_SUFFIX_RE);
  return match
    ? { timestampKey: match[1], suffix: parseInt(match[2], 10) }
    : { timestampKey: rest, suffix: 1 };
}

async function listBackupsFor(backupDir, filename) {
  let files;
  try {
    files = await fs.promises.readdir(backupDir);
  } catch {
    return [];
  }
  const candidateNames = files.filter(
    (f) => f.startsWith(filename + ".") && f.endsWith(".bak"),
  );
  return candidateNames
    .map((name) => ({ name, ...parseBackupName(filename, name) }))
    .sort((a, b) => {
      if (a.timestampKey !== b.timestampKey) {
        return a.timestampKey < b.timestampKey ? 1 : -1;
      }
      return b.suffix - a.suffix;
    })
    .map((c) => c.name);
}

export async function createBackup(configPath, filename) {
  const backupDir = await getBackupPath(configPath);
  const filePath = path.join(configPath, filename);

  try {
    await fs.promises.access(filePath);
  } catch (e) {
    log.debug(`Config backup source not found: ${filePath} — ${e.message}`);
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
              .catch((e) =>
                log.warn(`Failed to delete old backup ${old}: ${e.message}`),
              ),
          ),
        );
      }
    } catch (cleanupError) {
      log.warn(
        `Backup cleanup failed (new backup ${backupName} is still safe): ${cleanupError.message}`,
      );
    }

    return { backedUp: true, name: backupName };
  } catch (error) {
    log.error(`Backup creation failed: ${error.message}`);
    return { backedUp: false, reason: "failed", error: error.message };
  }
}

export async function createBackupIfChanged(configPath, filename) {
  const filePath = path.join(configPath, filename);
  let liveContent;
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
    } catch (e) {
      log.debug(
        `Could not compare against most recent backup of ${filename}, backing up anyway: ${e.message}`,
      );
    }
  }

  return createBackup(configPath, filename);
}

export function backupWarningFor(backup) {
  if (!backup || backup.backedUp || backup.reason === "no-source") return null;
  return `Could not back up the previous version before saving: ${backup.error}. Your change was saved, but there is no safety copy of what was there before.`;
}

export async function writeIniWithBackup(iniPath, content) {
  const configPath = path.dirname(iniPath);
  const filename = path.basename(iniPath);
  const backup = await createBackup(configPath, filename);
  writeFileAtomic(iniPath, content, "utf-8");
  return backup;
}
