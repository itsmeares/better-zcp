import path from "path";
import fs from "fs";
import { createWriteStream } from "fs";
import archiver from "archiver";
import { createReadStream } from "fs";
import { crc32 } from "zlib";
import { createLogger } from "../utils/logger.ts";
import { isPidAlive } from "../utils/pidLiveness.ts";
const log = createLogger("Backup");
import {
  getActiveServer,
  getSetting,
  setSetting,
  logServerEvent,
  getLatestScheduleExecutionByCommand,
  flushWrites,
  getDatabaseFilePath,
} from "../database/init.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { captureBackupSnapshot } from "../utils/backupSnapshot.ts";
import { addBackupRecord, removeBackupRecord } from "./backupRecords.ts";
import { invalidateMapFolderScan } from "../utils/mapFolderScan.ts";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
} from "../utils/cronValidation.ts";

type ArchiveResult = { skipped: boolean };
type WalkItem = {
  entry: any;
  fullPath: string;
  archivePath: string;
  isSymlink?: boolean;
};
type BackupSummary = {
  name: string;
  path: string;
  size: number;
  created: string;
};
type BackupFile = BackupSummary & {
  sortKey: { key: string; suffix: number };
};
type BackupSettings = {
  enabled: boolean;
  schedule: string;
  maxBackups: number;
  includeDb: boolean;
};
type BackupOptions = {
  io?: { emit: (event: string, payload: unknown) => void } | null;
  activeServer?: Record<string, any> | null;
  isPreRestore?: boolean;
  isPreWipe?: boolean;
  includeDb?: boolean;
  force?: boolean;
  createPreRestoreBackup?: boolean;
};
type ProgressEmitter = (
  phase: string,
  percent: number,
  message: string,
  extra?: Record<string, unknown>,
) => void;
type BackupResult = {
  success: boolean;
  message?: string;
  backup?: BackupSummary | null;
  duration?: number;
  skippedFiles?: string[];
  deleted?: number;
  failed?: number;
  deletedNames?: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordServerEvent(
  eventType: string,
  message?: unknown | null,
): Promise<unknown> {
  return (logServerEvent as unknown as (
    eventType: string,
    message?: unknown | null,
  ) => Promise<unknown>)(eventType, message);
}

let unzipper: any;
async function getUnzipper(): Promise<any> {
  if (!unzipper) {
    unzipper = await import("unzipper");
  }
  return unzipper;
}

async function* walkDirectory(rootDir: string): AsyncGenerator<WalkItem> {
  const pending: Array<{
    dirPath: string;
    archivePath: string;
    isRoot: boolean;
  }> = [{ dirPath: rootDir, archivePath: "", isRoot: true }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let directory;
    try {
      directory = await fs.promises.opendir(current.dirPath);
    } catch (error: unknown) {
      if (current.isRoot) throw error;
      continue;
    }

    try {
      let entry;
      while ((entry = await directory.read()) !== null) {
        const archivePath = current.archivePath
          ? `${current.archivePath}/${entry.name}`
          : entry.name;
        const fullPath = path.join(current.dirPath, entry.name);

        if (entry.isSymbolicLink()) {
          yield { entry, fullPath, archivePath, isSymlink: true };
          continue;
        }

        if (entry.isDirectory()) {
          pending.push({
            dirPath: fullPath,
            archivePath,
            isRoot: false,
          });
        }

        yield { entry, fullPath, archivePath };
      }
    } finally {
      await directory.close().catch(() => {});
    }
  }
}

async function countFiles(rootDir: string): Promise<number> {
  let count = 0;
  for await (const { entry } of walkDirectory(rootDir)) {
    if (!entry.isDirectory()) count++;
  }
  return count;
}

const CENTRAL_TEMP_PATTERN = /^\.central-(\d+)-\d+-[0-9a-z]+\.tmp$/;

export const isBackupTempOwnerAlive = isPidAlive;

export function cleanupOrphanBackupTemps(backupsPath: string): void {
  let entries;
  try {
    entries = fs.readdirSync(backupsPath);
  } catch {
    return;
  }
  for (const name of entries) {
    const centralMatch = CENTRAL_TEMP_PATTERN.exec(name);
    if (centralMatch) {
      if (isBackupTempOwnerAlive(Number(centralMatch[1]))) continue;
    } else if (!name.endsWith(".zip.tmp")) {
      continue;
    }
    try {
      fs.unlinkSync(path.join(backupsPath, name));
      log.info(`Removed orphan backup temporary file: ${name}`);
    } catch (error: unknown) {
      log.debug(`Could not remove orphan backup temporary file ${name}: ${errorMessage(error)}`);
    }
  }
}

export function waitForArchiveEntry(
  archive: any,
  append: () => unknown,
): Promise<ArchiveResult> {
  return new Promise<ArchiveResult>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      archive.off("warning", onWarning);
    };

    const settle = (value?: ArchiveResult, error?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(value!);
    };

    const onEntry = () => settle({ skipped: false });
    const onError = (error: unknown) => settle(undefined, error);
    const onWarning = (error: { code?: string }) => {
      if (error.code === "ENOENT") {
        settle({ skipped: true });
      } else {
        settle(undefined, error);
      }
    };

    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.on("warning", onWarning);

    try {
      append();
    } catch (error: unknown) {
      settle(undefined, error);
    }
  });
}

export async function appendDirectoryToArchive(
  archive: any,
  sourceRoot: string,
  destinationRoot: string,
): Promise<string[]> {
  const skipped: string[] = [];
  for await (const { entry, fullPath, archivePath, isSymlink } of walkDirectory(
    sourceRoot,
  )) {
    const entryName = `${destinationRoot}/${archivePath}${entry.isDirectory() ? "/" : ""}`;
    if (isSymlink) {
      log.warn(`Skipping symbolic link during backup: ${fullPath}`);
      skipped.push(entryName);
      continue;
    }
    const result = await waitForArchiveEntry(archive, () =>
      archive.file(fullPath, { name: entryName }),
    );
    if (result.skipped) skipped.push(entryName);
  }
  return skipped;
}

const BACKUP_TIMESTAMP_RE =
  /(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3})(?:-(\d+))?\.zip$/;
function backupSortKey(
  fileName: string,
  stats: fs.Stats,
): { key: string; suffix: number } {
  const match = fileName.match(BACKUP_TIMESTAMP_RE);
  if (match) {
    return { key: match[1], suffix: match[2] ? parseInt(match[2], 10) : 1 };
  }
  return {
    key: stats.birthtime.toISOString().replace(/[:.]/g, "-").slice(0, 23),
    suffix: 1,
  };
}

export class BackupService {
  backupInProgress: boolean;
  restoreInProgress: boolean;
  lastBackup: BackupSummary | null;
  backupHistory: unknown[];
  discordBot: any;
  serverManager: any;

  constructor() {
    this.backupInProgress = false;
    this.restoreInProgress = false;
    this.lastBackup = null;
    this.backupHistory = [];
    this.discordBot = null;
    this.serverManager = null;
  }


  setDiscordBot(discordBot: any): void {
    this.discordBot = discordBot;
  }

  setServerManager(serverManager: any): void {
    this.serverManager = serverManager;
  }

  async getSavesPath(activeServerOverride?: any): Promise<string | null> {
    try {
      const activeServer =
        activeServerOverride === undefined
          ? await getActiveServer()
          : activeServerOverride;

      const serverDataPath = activeServer?.zomboidDataPath;
      const serverName = activeServer?.serverName;
      if (serverDataPath && serverName) {
        const savesPath = path.join(
          serverDataPath,
          "Saves",
          "Multiplayer",
          serverName,
        );
        if (fs.existsSync(savesPath)) {
          return savesPath;
        }
        const baseSavesPath = path.join(
          serverDataPath,
          "Saves",
          "Multiplayer",
        );
        if (fs.existsSync(baseSavesPath)) {
          const folders = fs
            .readdirSync(baseSavesPath, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
          const exactMatch = folders.find((f) => f === serverName);
          if (exactMatch) {
            return path.join(baseSavesPath, exactMatch);
          }
          const caseInsensitiveMatch = folders.find(
            (f) => f.toLowerCase() === serverName.toLowerCase(),
          );
          if (caseInsensitiveMatch) {
            return path.join(baseSavesPath, caseInsensitiveMatch);
          }
          if (folders.length > 0) {
            log.warn(
              `Could not find save folder matching "${serverName}", using first available: ${folders[0]}`,
            );
            return path.join(baseSavesPath, folders[0]);
          }
        }
      }

      const zomboidDataPath = await getSetting("zomboidDataPath");
      const fallbackServerName = await getSetting("serverName");

      if (zomboidDataPath && fallbackServerName) {
        return path.join(
          zomboidDataPath,
          "Saves",
          "Multiplayer",
          fallbackServerName,
        );
      }

      return null;
    } catch (error: unknown) {
      log.error(`Failed to get saves path: ${errorMessage(error)}`);
      return null;
    }
  }

  async getBackupsPath(activeServerOverride?: any): Promise<string | null> {
    try {
      const activeServer =
        activeServerOverride === undefined
          ? await getActiveServer()
          : activeServerOverride;
      let basePath;

      if (activeServer?.zomboidDataPath) {
        basePath = activeServer.zomboidDataPath;
      } else {
        basePath = await getSetting("zomboidDataPath");
      }

      if (!basePath) {
        const { getDataPaths } = await import("../utils/paths.ts");
        basePath = getDataPaths().dataDir;
      }

      const backupsPath = path.join(basePath, "backups");

      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      return backupsPath;
    } catch (error: unknown) {
      log.error(`Failed to get backups path: ${errorMessage(error)}`);
      return null;
    }
  }

  async getSettings(): Promise<BackupSettings> {
    const enabled = (await getSetting("backupEnabled")) ?? false;
    const schedule = (await getSetting("backupSchedule")) ?? "0 */6 * * *";
    const maxBackups = (await getSetting("backupMaxCount")) ?? 10;
    const includeDb = (await getSetting("backupIncludeDb")) ?? false;

    return { enabled, schedule, maxBackups, includeDb };
  }

  async updateSettings(settings: Partial<BackupSettings>): Promise<BackupSettings> {
    if (
      settings.enabled !== undefined &&
      typeof settings.enabled !== "boolean"
    ) {
      throw new Error("enabled must be a boolean");
    }
    if (
      settings.maxBackups !== undefined &&
      (!Number.isInteger(settings.maxBackups) ||
        settings.maxBackups < 1 ||
        settings.maxBackups > 100)
    ) {
      throw new Error("maxBackups must be an integer between 1 and 100");
    }
    if (
      settings.includeDb !== undefined &&
      typeof settings.includeDb !== "boolean"
    ) {
      throw new Error("includeDb must be a boolean");
    }
    if (
      settings.schedule !== undefined &&
      (!isSupportedFiveFieldCron(settings.schedule) ||
        isCronTooFrequent(settings.schedule))
    ) {
      throw new Error(
        "Invalid backup schedule. Use exactly 5 cron fields and no more than one run every 5 minutes.",
      );
    }
    if (settings.enabled !== undefined) {
      await setSetting("backupEnabled", settings.enabled);
    }
    if (settings.schedule !== undefined) {
      await setSetting("backupSchedule", settings.schedule);
    }
    if (settings.maxBackups !== undefined) {
      await setSetting("backupMaxCount", settings.maxBackups);
    }
    if (settings.includeDb !== undefined) {
      await setSetting("backupIncludeDb", settings.includeDb);
    }

    return this.getSettings();
  }

  async createBackup(options: BackupOptions = {}): Promise<BackupResult> {
    if (this.backupInProgress) {
      return { success: false, message: "Backup already in progress" };
    }
    if (this.restoreInProgress && !options.isPreRestore) {
      return { success: false, message: "Restore in progress, please wait" };
    }

    this.backupInProgress = true;
    const startTime = Date.now();
    const io = options.io;

    const emitProgress: ProgressEmitter = (
      phase,
      percent,
      message,
      extra = {},
    ) => {
      if (io) {
        io.emit("backup:progress", { phase, percent, message, ...extra });
      }
    };

    try {
      return await this._doCreateBackup(options, startTime, emitProgress);
    } catch (error: unknown) {
      log.error(`Backup failed: ${errorMessage(error)}`);
      emitProgress(
        "error",
        0,
        `Backup failed: ${sanitizeError(errorMessage(error))}`,
      );
      return { success: false, message: sanitizeError(errorMessage(error)) };
    } finally {
      this.backupInProgress = false;
    }
  }

  async _doCreateBackup(
    options: BackupOptions,
    startTime: number,
    emitProgress: ProgressEmitter,
  ): Promise<BackupResult> {
    emitProgress("preparing", 5, "Preparing backup...");

    const activeServer =
      options.activeServer === undefined
        ? await getActiveServer()
        : options.activeServer;
    const savesPath = await this.getSavesPath(activeServer);
    const backupsPath = await this.getBackupsPath(activeServer);

    if (!savesPath) {
      throw new Error(
        "Could not determine saves folder path. Please configure the server first.",
      );
    }

    if (!fs.existsSync(savesPath)) {
      throw new Error(`Saves folder not found: ${savesPath}`);
    }

    if (!backupsPath) {
      throw new Error("Could not determine backups folder path");
    }

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 23);
    const serverName = activeServer?.serverName || "server";
    const baseBackupName = `${serverName}_${timestamp}`;
    let backupName = `${baseBackupName}.zip`;
    let backupPath = path.join(backupsPath, backupName);
    let collision = 1;
    while (fs.existsSync(backupPath)) {
      backupName = `${baseBackupName}-${collision}.zip`;
      backupPath = path.join(backupsPath, backupName);
      collision++;
    }
    const tempBackupPath = `${backupPath}.tmp`;
    cleanupOrphanBackupTemps(backupsPath);
    const serverSnapshot = captureBackupSnapshot(activeServer);

    log.info(`Starting backup: ${backupName}`);
    log.info(`Source: ${savesPath}`);
    log.info(`Destination: ${backupPath}`);

    emitProgress("preparing", 10, "Scanning files...");

    let totalFiles = 0;

    try {
      totalFiles = await countFiles(savesPath);
    } catch (err: unknown) {
      log.warn(`Failed to count files: ${errorMessage(err)}`);
      totalFiles = 1000;
    }

    let dbPathToInclude = null;
    if (options.includeDb) {
      await flushWrites();
      const dbPath = getDatabaseFilePath();
      if (fs.existsSync(dbPath)) {
        dbPathToInclude = dbPath;
        totalFiles++;
      }
    }

    emitProgress("archiving", 15, `Found ${totalFiles} files to backup...`, {
      totalFiles,
    });

    const output = createWriteStream(tempBackupPath);
    const archive = archiver("zip", {
      zlib: { level: 6 }, // Moderate compression
    });

    let filesProcessed = 0;
    const skippedFiles: string[] = [];

    return new Promise<BackupResult>((resolve, reject) => {
      archive.on("entry", (entry: { name: string }) => {
        filesProcessed++;
        const percent = Math.min(
          15 + Math.round((filesProcessed / totalFiles) * 75),
          90,
        );
        if (filesProcessed % 50 === 0 || filesProcessed === totalFiles) {
          emitProgress(
            "archiving",
            percent,
            `Archiving files... (${filesProcessed}/${totalFiles})`,
            {
              filesProcessed,
              totalFiles,
              currentFile: entry.name,
            },
          );
        }
      });

      output.on("close", async () => {
        emitProgress("finalizing", 95, "Finalizing backup...");

        try {
          fs.renameSync(tempBackupPath, backupPath);
        } catch (renameError: unknown) {
          emitProgress(
            "error",
            0,
            `Backup failed: ${errorMessage(renameError)}`,
          );
          reject(renameError);
          return;
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        const sizeBytes = archive.pointer();
        const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

        if (skippedFiles.length > 0) {
          log.warn(
            `Backup ${backupName} completed but ${skippedFiles.length} file(s) could not be included: ${skippedFiles.join(", ")}`,
          );
        } else {
          log.info(
            `Backup completed: ${backupName} (${sizeMB} MB) in ${duration}s`,
          );
        }

        this.lastBackup = {
          name: backupName,
          path: backupPath,
          size: sizeBytes,
          created: new Date().toISOString(),
        };

        try {
          await addBackupRecord({
            backup: this.lastBackup,
            server: activeServer,
            snapshot: serverSnapshot,
          });
        } catch (error: unknown) {
          log.warn(`Backup record could not be saved for ${backupName}: ${errorMessage(error)}`);
        }

        try {
          await recordServerEvent("backup_created", `${backupName} (${sizeMB} MB)`);
        } catch (error: unknown) {
          log.warn(
            `Backup event could not be logged for ${backupName}: ${errorMessage(error)}`,
          );
        }

        if (!options.isPreRestore && !options.isPreWipe) {
          try {
            await this.cleanupOldBackups(activeServer);
          } catch (cleanupError: unknown) {
            log.warn(`Backup retention cleanup failed for ${backupName}: ${errorMessage(cleanupError)}`);
          }
        }

        emitProgress(
          "complete",
          100,
          `Backup complete! (${sizeMB} MB in ${duration}s)`,
        );

        if (this.discordBot) {
          this.discordBot
            .sendEventNotification("backupComplete", {})
            .catch((err: unknown) =>
              log.debug(
                `Discord backupComplete notification failed: ${errorMessage(err)}`,
              ),
            );
        }

        resolve({
          success: true,
          backup: this.lastBackup,
          duration: parseFloat(duration),
          skippedFiles,
        });
      });

      const cleanupTemp = () => {
        fs.rm(tempBackupPath, { force: true }, (cleanupErr) => {
          if (cleanupErr) {
            log.warn(
              `Could not remove incomplete backup file ${tempBackupPath}: ${errorMessage(cleanupErr)}`,
            );
          }
        });
      };

      output.on("error", (err: unknown) => {
        emitProgress("error", 0, `Backup failed: ${errorMessage(err)}`);
        cleanupTemp();
        reject(err);
      });

      archive.on("error", (err: unknown) => {
        emitProgress("error", 0, `Archive error: ${errorMessage(err)}`);
        cleanupTemp();
        reject(err);
      });

      archive.on("warning", (err: { code?: string }) => {
        if (err.code === "ENOENT") {
          log.warn(`Backup warning: ${errorMessage(err)}`);
        } else {
          cleanupTemp();
          reject(err);
        }
      });

      archive.pipe(output);

      const appendBackupContents = async () => {
        try {
          const skippedSaves = await appendDirectoryToArchive(
            archive,
            savesPath,
            path.basename(savesPath),
          );
          skippedFiles.push(...skippedSaves);

          const snapshotResult = await waitForArchiveEntry(archive, () =>
            archive.append(JSON.stringify(serverSnapshot, null, 2), {
              name: "panel-server-snapshot.json",
            }),
          );
          if (snapshotResult.skipped) skippedFiles.push("panel-server-snapshot.json");

          if (dbPathToInclude) {
            const databaseName = path.basename(dbPathToInclude);
            const dbResult = await waitForArchiveEntry(archive, () =>
              archive.file(dbPathToInclude, { name: databaseName }),
            );
            if (dbResult.skipped) skippedFiles.push(databaseName);
          }

          await archive.finalize();
        } catch (error: unknown) {
          archive.abort();
          cleanupTemp();
          reject(error);
        }
      };

      void appendBackupContents();
    });
  }

  async listBackups(activeServerOverride?: any): Promise<BackupSummary[]> {
    try {
      const backupsPath = await this.getBackupsPath(activeServerOverride);
      if (!backupsPath || !fs.existsSync(backupsPath)) {
        return [];
      }

      const files = await fs.promises.readdir(backupsPath);

      const backups = await Promise.all(
        files
          .filter((f) => f.endsWith(".zip"))
          .map(async (f) => {
            try {
              const filePath = path.join(backupsPath, f);
              const stats = await fs.promises.stat(filePath);
              return {
                name: f,
                path: filePath,
                size: stats.size,
                created: stats.birthtime.toISOString(),
                sortKey: backupSortKey(f, stats),
              };
            } catch (e: unknown) {
              return null;
            }
          }),
      );

      return backups
        .filter((b): b is BackupFile => b !== null)
        .sort((a, b) => {
          if (a.sortKey.key !== b.sortKey.key) {
            return a.sortKey.key < b.sortKey.key ? 1 : -1;
          }
          return b.sortKey.suffix - a.sortKey.suffix;
        })
        .map(({ sortKey: _sortKey, ...backup }) => backup);
    } catch (error: unknown) {
      log.error(`Failed to list backups: ${errorMessage(error)}`);
      return [];
    }
  }

  async getBackupSnapshot(
    backupName: string,
  ): Promise<{ success: boolean; snapshot?: unknown; message?: string }> {
    const backupsPath = await this.getBackupsPath();
    const safeName = path.basename(backupName);
    if (!backupsPath || !safeName.endsWith(".zip")) {
      return { success: false, message: "Invalid backup file" };
    }

    const backupPath = path.join(backupsPath, safeName);
    if (!fs.existsSync(backupPath)) {
      return { success: false, message: "Backup not found" };
    }

    try {
      const unzip = await getUnzipper();
      const archive = await unzip.Open.file(backupPath);
      const entry = archive.files.find(
        (file: { path: string }) => file.path === "panel-server-snapshot.json",
      );
      if (!entry) {
        return { success: false, message: "This backup has no panel snapshot" };
      }
      const snapshot = JSON.parse((await entry.buffer()).toString("utf-8"));
      return { success: true, snapshot };
    } catch (error: unknown) {
      log.warn(`Could not read backup snapshot from ${safeName}: ${errorMessage(error)}`);
      return { success: false, message: "Could not read backup snapshot" };
    }
  }

  async deleteBackup(backupName: string): Promise<BackupResult> {
    try {
      const backupsPath = await this.getBackupsPath();
      if (!backupsPath) {
        throw new Error("Backups folder not found");
      }

      const safeName = path.basename(backupName);
      if (!safeName.endsWith(".zip")) {
        throw new Error("Invalid backup file");
      }

      const backupPath = path.join(backupsPath, safeName);

      if (!fs.existsSync(backupPath)) {
        throw new Error("Backup not found");
      }

      fs.unlinkSync(backupPath);
      try {
        await removeBackupRecord(safeName);
      } catch (error: unknown) {
        log.warn(`Backup record could not be removed for ${safeName}: ${errorMessage(error)}`);
      }
      log.info(`Deleted backup: ${safeName}`);
      try {
        await recordServerEvent("backup_deleted", safeName);
      } catch (error: unknown) {
        log.warn(`Could not log backup_deleted event for ${safeName}: ${errorMessage(error)}`);
      }

      return { success: true };
    } catch (error: unknown) {
      log.error(`Failed to delete backup: ${errorMessage(error)}`);
      return { success: false, message: errorMessage(error) };
    }
  }

  async cleanupOldBackups(activeServerOverride?: any): Promise<void> {
    try {
      const settings = await this.getSettings();
      const backups = await this.listBackups(activeServerOverride);
      const prunable = backups.filter((b) => !b.name.startsWith("uploaded-"));

      if (prunable.length <= settings.maxBackups) {
        return;
      }

      const toDelete = prunable.slice(settings.maxBackups);
      for (const backup of toDelete) {
        const deleted = await this.deleteBackup(backup.name);
        if (!deleted?.success) {
          log.warn(
            `Could not clean up old backup ${backup.name}: ${deleted?.message || "unknown error"}`,
          );
          continue;
        }
        log.info(`Cleaned up old backup: ${backup.name}`);
      }
    } catch (error: unknown) {
      log.error(`Failed to cleanup old backups: ${errorMessage(error)}`);
    }
  }

  async deleteBackupsOlderThan(days: number): Promise<BackupResult> {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1) {
      return { success: false, message: "Invalid days parameter. Must be a whole number >= 1" };
    }
    try {
      const backups = await this.listBackups();
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - days);

      const toDelete = backups.filter((backup) => {
        const backupDate = new Date(backup.created);
        return backupDate < cutoffDate;
      });

      if (toDelete.length === 0) {
        return {
          success: true,
          deleted: 0,
          message: `No backups older than ${days} days found`,
        };
      }

      let deletedCount = 0;
      let failedCount = 0;
      const deletedNames: string[] = [];

      for (const backup of toDelete) {
        const result = await this.deleteBackup(backup.name);
        if (result.success) {
          deletedCount++;
          deletedNames.push(backup.name);
        } else {
          failedCount++;
        }
      }

      log.info(`Deleted ${deletedCount} backups older than ${days} days`);

      return {
        success: failedCount === 0,
        deleted: deletedCount,
        failed: failedCount,
        deletedNames,
        message: `Deleted ${deletedCount} backup${deletedCount !== 1 ? "s" : ""} older than ${days} days${failedCount > 0 ? ` (${failedCount} failed)` : ""}`,
      };
    } catch (error: unknown) {
      log.error(`Failed to delete old backups: ${errorMessage(error)}`);
      return { success: false, message: errorMessage(error) };
    }
  }

  async getStatus(): Promise<Record<string, unknown>> {
    const settings = await this.getSettings();
    const backups = await this.listBackups();
    const savesPath = await this.getSavesPath();
    const backupsPath = await this.getBackupsPath();

    if (!this.lastBackup && backups.length > 0) {
      this.lastBackup = backups[0];
    }

    const lastScheduledAttempt = settings.enabled
      ? await getLatestScheduleExecutionByCommand("backup")
      : null;

    return {
      ...settings,
      backupInProgress: this.backupInProgress,
      restoreInProgress: this.restoreInProgress || false,
      lastBackup: this.lastBackup,
      backupCount: backups.length,
      savesPath,
      backupsPath,
      savesExists: savesPath ? fs.existsSync(savesPath) : false,
      lastScheduledBackupAttempt: lastScheduledAttempt
        ? {
            success: !!lastScheduledAttempt.success,
            message: lastScheduledAttempt.message,
            executedAt: lastScheduledAttempt.executed_at,
          }
        : null,
    };
  }

  getBackupContentsInfo(): Record<string, unknown> {
    return {
      description: "Server world save data",
      includes: [
        "map_*.bin - World map chunk data",
        "map_meta.bin - Map metadata",
        "map_sand.bin - Sandbox settings snapshot",
        "players/ - Player save files",
        "vehicles.db - Vehicle data",
        "reanimated.bin - Zombie data",
        "worldstats.txt - World statistics",
        "panel-server-snapshot.json - Safe server configuration snapshot",
        "Other world-specific data files",
      ],
      location: "Saves/Multiplayer/{ServerName}/",
      note: "Backups contain the entire world state. Server must be stopped before restoring.",
    };
  }

  async restoreBackup(
    backupName: string,
    options: BackupOptions = {},
  ): Promise<BackupResult> {
    if (this.restoreInProgress) {
      return { success: false, message: "Restore already in progress" };
    }

    if (this.backupInProgress) {
      return { success: false, message: "Backup in progress, please wait" };
    }

    this.restoreInProgress = true;
    const startTime = Date.now();
    let stagingPath: string | null = null;
    const io = options.io;

    const emitProgress: ProgressEmitter = (
      phase,
      percent,
      message,
      extra = {},
    ) => {
      if (io) {
        io.emit("restore:progress", { phase, percent, message, ...extra });
      }
    };

    try {
      if (options.force !== true) {
        if (!this.serverManager) {
          log.warn("Could not confirm server is stopped: no server manager wired");
          return {
            success: false,
            message:
              "Could not confirm the server is stopped because no server manager is available. Stop the server and try again.",
          };
        }
        try {
          let running;
          if (typeof this.serverManager.getServerProcessDetails === "function") {
            const processDetails =
              await this.serverManager.getServerProcessDetails();
            if (!processDetails || processDetails.scanFailed) {
              log.warn("Could not confirm server is stopped: process scan failed");
              return {
                success: false,
                message:
                  "Could not confirm the server is stopped because process detection failed. Stop the server and try again.",
              };
            }
            running = processDetails.running;
          } else {
            return {
              success: false,
              message:
                "Could not confirm the server is stopped because process detection is unavailable. Stop the server and try again.",
            };
          }

          if (running) {
            return {
              success: false,
              message:
                "Server is still running. Stop the server before restoring a backup, otherwise the running world will overwrite the restored save.",
            };
          }
        } catch (error: unknown) {
          log.warn(`Could not confirm server is stopped: ${errorMessage(error)}`);
          return {
            success: false,
            message: `Could not confirm the server is stopped (${errorMessage(error)}). Stop the server and try again.`,
          };
        }
      }

      emitProgress("preparing", 5, "Preparing restore...");

      const backupsPath = await this.getBackupsPath();
      const savesPath = await this.getSavesPath();

      if (!backupsPath) {
        throw new Error("Could not determine backups folder path");
      }

      if (!savesPath) {
        throw new Error(
          "Could not determine saves folder path. Please configure the server first.",
        );
      }

      const safeName = path.basename(backupName);
      if (!safeName.endsWith(".zip")) {
        throw new Error("Invalid backup file");
      }

      const backupPath = path.join(backupsPath, safeName);

      if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup not found: ${safeName}`);
      }

      log.info(`Starting restore from: ${safeName}`);
      log.info(`Destination: ${savesPath}`);

      if (options.createPreRestoreBackup !== false) {
        log.info("Creating pre-restore backup...");
        emitProgress("pre-backup", 10, "Backing up current world before restoring...");
        const preBackupResult = await this.createBackup({ isPreRestore: true, io });
        const skippedPreBackupFiles = preBackupResult.skippedFiles ?? [];
        const preBackupIncomplete =
          preBackupResult.success && skippedPreBackupFiles.length > 0;
        if (!preBackupResult.success || preBackupIncomplete) {
          const reason = preBackupIncomplete
            ? `it could not include ${skippedPreBackupFiles.length} file(s) (${skippedPreBackupFiles.join(", ")}) -- an incomplete pre-restore backup is not a safety net`
            : preBackupResult.message ?? "unknown error";
          log.error(`Pre-restore backup failed: ${reason}`);
          emitProgress(
            "error",
            0,
            `Cannot restore: pre-restore backup failed (${reason}). Aborting to protect save data.`,
          );
          return {
            success: false,
            message: `Cannot restore: pre-restore backup failed (${reason}). Aborting to protect save data.`,
          };
        }
      }

      const savesParentPath = path.dirname(savesPath);
      const expectedFolderName = path.basename(savesPath);

      if (!fs.existsSync(savesParentPath)) {
        fs.mkdirSync(savesParentPath, { recursive: true });
      }

      stagingPath = path.join(
        savesParentPath,
        `.restore-staging-${Date.now()}-${process.pid}`,
      );
      fs.mkdirSync(stagingPath, { recursive: true });

      log.info("Extracting backup to staging area...");
      emitProgress("extracting", 45, "Extracting backup...");
      const unzip = await getUnzipper();
      const resolvedParent = path.resolve(stagingPath) + path.sep;

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: unknown): void => {
          if (settled) return;
          settled = true;
          if (err !== undefined) reject(err);
          else resolve();
        };

        let pendingWrites = 0;
        let parseClosed = false;
        const settleIfComplete = () => {
          if (parseClosed && pendingWrites === 0) settle();
        };

        const readStream = createReadStream(backupPath);
        readStream.on("error", (err: unknown) => settle(err));

        readStream
          .pipe(unzip.Parse())
          .on("entry", (entry: any) => {
            try {
              const entryPath = path.join(stagingPath!, entry.path);
              const resolvedEntry = path.resolve(entryPath);

              if (!resolvedEntry.startsWith(resolvedParent)) {
                log.error(`Zip slip attempt blocked: ${entry.path}`);
                entry.autodrain();
                return;
              }

              if (entry.type !== "Directory" && entry.type !== "File") {
                log.warn(
                  `Skipping unsupported backup entry type ${entry.type}: ${entry.path}`,
                );
                entry.autodrain();
              } else if (entry.type === "Directory") {
                fs.mkdirSync(resolvedEntry, { recursive: true });
                entry.autodrain();
              } else {
                fs.mkdirSync(path.dirname(resolvedEntry), { recursive: true });
                const writeStream = createWriteStream(resolvedEntry);
                pendingWrites++;
                writeStream.on("error", (err: unknown) => {
                  pendingWrites--;
                  try {
                    entry.unpipe(writeStream);
                  } catch {
                    /* ignore */
                  }
                  try {
                    entry.autodrain();
                  } catch {
                    /* ignore */
                  }
                  settle(err);
                });
                writeStream.on("close", () => {
                  pendingWrites--;
                  settleIfComplete();
                });
                entry.on("error", (err: unknown) => settle(err));
                entry.pipe(writeStream);
              }
            } catch (err: unknown) {
              settle(err);
            }
          })
          .on("close", () => {
            parseClosed = true;
            settleIfComplete();
          })
          .on("error", (err: unknown) => settle(err));
      });

      emitProgress("verifying", 80, "Verifying restored file integrity...");
      const integrity = await this._verifyExtractedIntegrity(
        backupPath,
        stagingPath,
      );
      if (!integrity.ok) {
        const preview = integrity.corruptFiles.slice(0, 5).join(", ");
        const more =
          integrity.corruptFiles.length > 5
            ? ` (+${integrity.corruptFiles.length - 5} more)`
            : "";
        throw new Error(
          `Backup archive failed integrity verification: ${integrity.corruptFiles.length} file(s) did not match their recorded checksum -- ${preview}${more}. Live save left untouched.`,
        );
      }

      const stagedWorldPath = this._findExtractedWorld(
        stagingPath,
        expectedFolderName,
      );

      if (!stagedWorldPath) {
        throw new Error(
          "Backup did not contain a world save folder - live save left untouched",
        );
      }

      emitProgress("finalizing", 85, "Swapping in the restored world...");

      const retiredPath = `${savesPath}.replaced-${Date.now()}`;
      let retired = false;

      if (fs.existsSync(savesPath)) {
        fs.renameSync(savesPath, retiredPath);
        retired = true;
      }

      try {
        fs.renameSync(stagedWorldPath, savesPath);
      } catch (swapError: unknown) {
        if (retired) {
          try {
            fs.renameSync(retiredPath, savesPath);
          } catch (rollbackError: unknown) {
            log.error(
              `Restore rollback failed - previous save is at ${retiredPath}: ${errorMessage(rollbackError)}`,
            );
            throw new Error(
              `Restore failed and the previous save could not be put back automatically. It is preserved at ${retiredPath}.`,
            );
          }
        }
        throw swapError;
      }

      if (retired) {
        try {
          fs.rmSync(retiredPath, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          log.warn(
            `Restored successfully but could not remove ${retiredPath}: ${errorMessage(cleanupError)}`,
          );
        }
      }

      if (!fs.existsSync(savesPath)) {
        throw new Error(
          "Restore may have failed - saves folder not found after extraction",
        );
      }

      invalidateMapFolderScan(path.join(savesPath, "map"));

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      log.info(`Restore completed in ${duration}s`);

      try {
        await recordServerEvent("backup_restored", `Restored from ${safeName}`);
      } catch (eventError: unknown) {
        log.warn(
          `Restore event could not be logged for ${safeName}: ${errorMessage(eventError)}`,
        );
      }
      emitProgress("complete", 100, `Restored from ${safeName}`);

      return {
        success: true,
        message: `Restored from ${safeName}`,
        duration: parseFloat(duration),
      };
    } catch (error: unknown) {
      log.error(`Restore failed: ${errorMessage(error)}`);
      emitProgress("error", 0, `Restore failed: ${sanitizeError(errorMessage(error))}`);
      try {
        await recordServerEvent("restore_failed", errorMessage(error));
      } catch (eventError: unknown) {
        log.warn(
          `Restore failure event could not be logged: ${errorMessage(eventError)}`,
        );
      }
      return { success: false, message: errorMessage(error) };
    } finally {
      if (stagingPath) {
        try {
          fs.rmSync(stagingPath, { recursive: true, force: true });
        } catch (cleanupError: unknown) {
          log.warn(
            `Could not remove restore staging folder ${stagingPath}: ${errorMessage(cleanupError)}`,
          );
        }
      }
      this.restoreInProgress = false;
    }
  }

  async _verifyExtractedIntegrity(
    backupPath: string,
    stagingPath: string,
  ): Promise<{ ok: boolean; corruptFiles: string[] }> {
    const corruptFiles: string[] = [];
    let archive;
    try {
      const unzip = await getUnzipper();
      archive = await unzip.Open.file(backupPath);
    } catch (error: unknown) {
      return { ok: false, corruptFiles: [`(could not read archive directory: ${errorMessage(error)})`] };
    }

    for (const entry of archive.files as any[]) {
      if (entry.type !== "File") continue;
      const entryPath = path.join(stagingPath, entry.path);

      let actualCrc32;
      try {
        actualCrc32 = await new Promise<number>((resolve, reject) => {
          let checksum = 0;
          const stream = createReadStream(entryPath);
          stream.on("data", (chunk) => {
            checksum = crc32(chunk, checksum);
          });
          stream.on("end", () => resolve(checksum));
          stream.on("error", reject);
        });
      } catch (error: unknown) {
        corruptFiles.push(`${entry.path} (missing after extraction: ${errorMessage(error)})`);
        continue;
      }

      if (actualCrc32 !== entry.crc32) {
        corruptFiles.push(entry.path);
      }
    }

    return { ok: corruptFiles.length === 0, corruptFiles };
  }

  _findExtractedWorld(
    stagingPath: string,
    expectedFolderName: string,
  ): string | null {
    const looksLikeWorld = (dir: string): boolean =>
      fs.existsSync(path.join(dir, "map_meta.bin")) ||
      fs.existsSync(path.join(dir, "map_t.bin"));

    const expected = path.join(stagingPath, expectedFolderName);
    if (fs.existsSync(expected) && fs.statSync(expected).isDirectory()) {
      return expected;
    }

    if (looksLikeWorld(stagingPath)) {
      return stagingPath;
    }

    const candidates: string[] = [];
    const pending: string[] = [stagingPath];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      if (current !== stagingPath && looksLikeWorld(current)) {
        candidates.push(current);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }

    return candidates.length === 1 ? candidates[0] : null;
  }
}
