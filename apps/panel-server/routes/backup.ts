import express from "express";
import { randomUUID } from "node:crypto";
import path from "path";
import fs from "fs";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import { getActiveServer } from "../database/init.ts";
import { requireAnyPermission, requirePermission } from "../services/permissions.ts";
import { listBackupRecords } from "../services/backupRecords.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";
import { hasActiveSteamOperation } from "../services/activeSteamOperations.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  streamUploadToFile,
  UPLOAD_BAD_SIGNATURE_CODE,
  UPLOAD_TOO_LARGE_CODE,
} from "../utils/uploadStream.ts";
import {
  isCronTooFrequent,
  isSupportedFiveFieldCron,
} from "../utils/cronValidation.ts";
import { parseClampedInteger } from "../utils/queryNumbers.ts";
const log = createLogger("API:Backup");

const router = express.Router();
const requireAnyBackupCapability = requireAnyPermission(
  "backups.manage",
  "backups.download",
  "backups.restore",
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBackupBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return undefined;
}

function parseBackupMaxCount(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined;
}

router.get("/status", requireAnyBackupCapability, async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const status = await backupService.getStatus();
    res.json(status);
  } catch (error) {
    log.error(`Failed to get backup status: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/info", async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const info = backupService.getBackupContentsInfo();
    res.json(info);
  } catch (error) {
    log.error(`Failed to get backup info: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/list", requireAnyBackupCapability, async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backups = await backupService.listBackups();
    res.json({ backups });
  } catch (error) {
    log.error(`Failed to list backups: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/history", requireAnyBackupCapability, async (req, res) => {
  try {
    const limit =
      req.query.limit === undefined
        ? undefined
        : parseClampedInteger(req.query.limit, null, 1, 500);
    if (req.query.limit !== undefined && limit === null) {
      return res.status(400).json({ error: "Invalid history limit" });
    }
    const records = await listBackupRecords({
      serverId:
        typeof req.query.serverId === "string" ? req.query.serverId : undefined,
      limit:
        typeof limit === "number" ? Math.min(Math.max(limit, 1), 500) : undefined,
    });
    res.json({ records });
  } catch (error) {
    log.error(`Failed to list backup history: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/:name/snapshot", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const result = await backupService.getBackupSnapshot(req.params.name);
    if (result.success) return res.json(result);
    return res.status(404).json(result);
  } catch (error) {
    log.error(`Failed to read backup snapshot: ${errorMessage(error)}`);
    return res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/settings", requirePermission("backups.manage"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const scheduler = req.app.get("scheduler");

    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        error: "Request body must be an object",
      });
    }

    const allowed: Record<string, unknown> = {};
    if (req.body.enabled !== undefined) {
      const enabled = parseBackupBoolean(req.body.enabled);
      if (enabled === undefined) {
        return res.status(400).json({
          success: false,
          error: "enabled must be a boolean or 0/1",
        });
      }
      allowed.enabled = enabled;
    }
    if (req.body.schedule !== undefined) {
      if (
        !isSupportedFiveFieldCron(req.body.schedule) ||
        isCronTooFrequent(req.body.schedule)
      ) {
        return res.status(400).json({
          success: false,
          error:
            "Invalid backup schedule. Use exactly 5 cron fields and no more than one run every 5 minutes.",
        });
      }
      allowed.schedule = req.body.schedule.trim();
    }
    if (req.body.maxBackups !== undefined) {
      const maxBackups = parseBackupMaxCount(req.body.maxBackups);
      if (maxBackups === undefined) {
        return res.status(400).json({
          success: false,
          error: "maxBackups must be an integer between 1 and 100",
        });
      }
      allowed.maxBackups = maxBackups;
    }
    if (req.body.includeDb !== undefined) {
      const includeDb = parseBackupBoolean(req.body.includeDb);
      if (includeDb === undefined) {
        return res.status(400).json({
          success: false,
          error: "includeDb must be a boolean or 0/1",
        });
      }
      allowed.includeDb = includeDb;
    }

    const settings = await backupService.updateSettings(allowed);

    if (scheduler && scheduler.setupBackupSchedule) {
      await scheduler.setupBackupSchedule();
    }

    res.json({ success: true, settings });
  } catch (error) {
    log.error(`Failed to update backup settings: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/create", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info("POST /create — creating manual backup");
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backups are not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const io = req.app.get("io");

    const result = await backupService.createBackup({ ...req.body, io });

    if (result.success) {
      if (result.skippedFiles?.length > 0) {
        res.json({
          ...result,
          warnings: [
            `${result.skippedFiles.length} file(s) could not be included in the backup: ${result.skippedFiles.join(", ")}. This is usually a temp, log, or lock file the running server rewrote mid-backup, or a symbolic link that was deliberately not followed -- check that the backup still restores correctly if any of these look like save data.`,
          ],
        });
      } else {
        res.json(result);
      }
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to create backup: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.delete("/:name", requirePermission("backups.manage"), async (req, res) => {
  try {
    log.info(`DELETE /${req.params.name}`);
    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackup(req.params.name);

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    log.error(`Failed to delete backup: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.get("/download/:name", requirePermission("backups.download"), async (req, res) => {
  try {
    const backupService = req.app.get("backupService");
    const backupsPath = await backupService.getBackupsPath();

    if (!backupsPath) {
      return res.status(404).json({ error: "Backups folder not found", code: ErrorCode.BACKUPS_FOLDER_NOT_FOUND });
    }

    const safeName = path.basename(req.params.name as string);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    const backupPath = path.join(backupsPath, safeName);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: "Backup not found", code: ErrorCode.BACKUP_NOT_FOUND });
    }

    res.download(backupPath, safeName);
  } catch (error) {
    log.error(`Failed to download backup: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/restore/:name", requirePermission("backups.restore"), async (req, res) => {
  const activeServerForLock = await getActiveServer();
  const lifecycleLock = acquireLifecycleLock(
    "restore",
    activeServerForLock?.name || activeServerForLock?.serverName || null,
  );
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }
  try {
    const activeServer = activeServerForLock;
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Backup restore is not available for remote servers. The server filesystem is not accessible from this panel.",
          code: ErrorCode.BACKUP_RESTORE_REMOTE_NOT_AVAILABLE,
        });
    }

    const backupService = req.app.get("backupService");
    const serverManager = req.app.get("serverManager");

    const safeName = path.basename(req.params.name as string);
    if (!safeName.endsWith(".zip")) {
      return res.status(400).json({ error: "Invalid backup file", code: ErrorCode.BACKUP_INVALID_FILE });
    }

    if (activeServer?.installPath) {
      const normalizedRestoreTargetPath = path
        .normalize(activeServer.installPath)
        .toLowerCase();
      if (hasActiveSteamOperation(normalizedRestoreTargetPath)) {
        return res.status(409).json({
          error:
            "A Steam operation is already in progress for this path. Please wait for it to complete.",
          code: ErrorCode.STEAM_OPERATION_IN_PROGRESS_PATH,
        });
      }
    }

    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        success: false,
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
        code: ErrorCode.SERVER_STATE_UNKNOWN,
      });
    }
    if (processDetails.running) {
      return res.status(400).json({
        success: false,
        error:
          "Server must be stopped before restoring a backup. Please stop the server first.",
        code: ErrorCode.BACKUP_RESTORE_SERVER_RUNNING,
      });
    }

    const io = req.app.get("io");
    const result = await backupService.restoreBackup(safeName, { ...req.body, io });

    if (result.success) {
      res.json(result);
    } else {
      const isRollbackFailureMessage =
        typeof result.message === "string" &&
        result.message.startsWith(
          "Restore failed and the previous save could not be put back automatically.",
        );
      res.status(400).json(
        isRollbackFailureMessage
          ? result
          : { ...result, message: sanitizeError(result.message) },
      );
    }
  } catch (error) {
    log.error(`Failed to restore backup: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  } finally {
    lifecycleLock.release();
  }
});

router.post("/delete-older-than", requirePermission("backups.manage"), async (req, res) => {
  try {
    const days = req.body?.days;

    if (
      typeof days !== "number" ||
      !Number.isInteger(days) ||
      days < 1
    ) {
      return res.status(400).json({
        error: "Invalid days parameter. Must be a whole number >= 1",
        code: ErrorCode.BACKUP_INVALID_DAYS_PARAMETER,
      });
    }

    const backupService = req.app.get("backupService");
    const result = await backupService.deleteBackupsOlderThan(days);

    res.json(result);
  } catch (error) {
    log.error(`Failed to delete old backups: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;
router.post(
  "/upload",
  requirePermission("backups.manage"),
  async (req, res) => {
    let tmpPath: string | null = null;
    try {
      const activeServer = await getActiveServer();
      if (activeServer?.isRemote) {
        return res
          .status(400)
          .json({
            error: "Backup upload is not available for remote servers.",
            code: ErrorCode.BACKUP_UPLOAD_REMOTE_NOT_AVAILABLE,
          });
      }

      const contentType = String(req.headers["content-type"] || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (contentType !== "application/zip") {
        return res
          .status(400)
          .json({
            error:
              "No file uploaded. Send the zip body with Content-Type: application/zip.",
            code: ErrorCode.BACKUP_UPLOAD_NO_FILE,
          });
      }

      const rawName = String(
        req.headers["x-backup-filename"] || "uploaded-backup.zip",
      );
      const baseName = path
        .basename(rawName)
        .replace(/[^A-Za-z0-9_.\- ]/g, "_")
        .slice(0, 200);
      if (!baseName.toLowerCase().endsWith(".zip")) {
        return res
          .status(400)
          .json({ error: "Only .zip backups are accepted.", code: ErrorCode.BACKUP_UPLOAD_INVALID_EXTENSION });
      }

      const backupService = req.app.get("backupService");
      const backupsPath = await backupService.getBackupsPath();
      if (!backupsPath) {
        return res
          .status(500)
          .json({
            error: "Backups folder not available. Configure the server first.",
            code: ErrorCode.BACKUPS_FOLDER_UNAVAILABLE,
          });
      }
      if (!fs.existsSync(backupsPath)) {
        fs.mkdirSync(backupsPath, { recursive: true });
      }

      const finalName = baseName.startsWith("uploaded-")
        ? baseName
        : `uploaded-${baseName}`;
      const targetPath = path.join(backupsPath, finalName);

      if (fs.existsSync(targetPath)) {
        return res
          .status(409)
          .json({
            error: `A backup named "${finalName}" already exists. Delete it first or rename the upload.`,
            code: ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT,
            params: sanitizeErrorParams({ name: finalName }),
          });
      }

      tmpPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
      const totalBytes = await streamUploadToFile(req, tmpPath, MAX_UPLOAD_BYTES);

      if (totalBytes === 0) {
        return res
          .status(400)
          .json({
            error:
              "No file uploaded. Send the zip body with Content-Type: application/zip.",
            code: ErrorCode.BACKUP_UPLOAD_NO_FILE,
          });
      }

      try {
        fs.linkSync(tmpPath, targetPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return res
            .status(409)
            .json({
              error: `A backup named "${finalName}" already exists. Delete it first or rename the upload.`,
              code: ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT,
              params: sanitizeErrorParams({ name: finalName }),
            });
        }
        throw error;
      }
      fs.unlinkSync(tmpPath);
      tmpPath = null;

      log.info(`POST /upload — stored ${finalName} (${totalBytes} bytes)`);
      res.json({
        success: true,
        name: finalName,
        size: totalBytes,
        message: `Uploaded backup saved as ${finalName}. Use Restore to apply it.`,
      });
    } catch (error) {
      const errorCode =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (errorCode === UPLOAD_BAD_SIGNATURE_CODE) {
        return res.status(400).json({
          error: "File does not look like a valid .zip archive.",
          code: ErrorCode.BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE,
        });
      }
      if (errorCode === UPLOAD_TOO_LARGE_CODE) {
        return res.status(413).json({
          error: "Upload exceeds the configured size limit.",
          code: ErrorCode.BACKUP_UPLOAD_TOO_LARGE,
        });
      }
      log.error(`Failed to upload backup: ${errorMessage(error)}`);
      return res.status(500).json({ error: sanitizeError(errorMessage(error)) });
    } finally {
      if (tmpPath) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // The temporary file may already have been removed by the stream.
        }
      }
    }
  },
);

export default router;
