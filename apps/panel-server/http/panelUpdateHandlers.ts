import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { logServerEvent } from "../database/init.ts";
import { getDatabaseFilePath, setSetting, flushWrites } from "../database/init.ts";
import { getPanelRuntime } from "../utils/panelRuntime.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import { getDataPaths } from "../utils/paths.ts";
import { isLinuxPanelSupervisor } from "../utils/restartSupervisor.ts";
import { createUpdateDataBackup } from "../services/panelUpdateChecker.ts";
import { applyUpdateBundle, recoverInterruptedUpdateBundle } from "../services/updateBundle.ts";
import type { Request, Response } from "./apiRouter.ts";

type AnyRecord = Record<string, any>;

function runtime(): AnyRecord {
  try {
    return getPanelRuntime();
  } catch {
    return {};
  }
}

function appValue(request: Request, name: string): any {
  return request.app?.get(name) ?? runtime()[name];
}

export async function handlePanelUpdateStatus(
  request: Request,
  response: Response,
): Promise<Response | void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) {
      return response
        .status(500)
        .json({ error: "Panel update checker not available" });
    }
    response.json(checker.getStatus());
  } catch (error: any) {
    response.status(500).json({ error: sanitizeError(error.message) });
  }
}

export async function handlePanelUpdateCheck(request: Request, response: Response): Promise<void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json(await checker.checkForUpdate());
  } catch (error: any) {
    response.status(500).json({ error: sanitizeError(error.message) });
  }
}

export async function handlePanelUpdatePreflight(request: Request, response: Response): Promise<void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json(await checker.preflight());
  } catch (error: any) {
    response.status(500).json({ error: sanitizeError(error.message) });
  }
}

export function handlePanelUpdateApplyLog(request: Request, response: Response): void {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json({
      log: checker.readMostRecentApplyLog(),
      logPath: path.join(getDataPaths().logsDir, "panel-update-last.log"),
    });
  } catch (error: any) {
    response.status(500).json({ error: sanitizeError(error.message) });
  }
}

export async function handlePanelUpdateDownload(
  request: Request,
  response: Response,
): Promise<Response | void> {
  try {
    const panelUpdateChecker = appValue(request, "panelUpdateChecker");
    if (!panelUpdateChecker) {
      return response
        .status(500)
        .json({ error: "Panel update checker not available" });
    }

    if (panelUpdateChecker.dockerUpdateProxy?.enabled) {
      if (request.body?.confirm !== true) {
        return response.status(400).json({
          error:
            "Confirm the Docker update before recreating the all-in-one container.",
          code: ErrorCode.CONFIRMATION_REQUIRED_LEGACY,
        });
      }

      const serverManager = appValue(request, "serverManager");
      const processDetails =
        typeof serverManager?.getServerProcessDetails === "function"
          ? await serverManager.getServerProcessDetails()
          : null;
      if (!processDetails || processDetails.scanFailed) {
        return response.status(503).json({
          success: false,
          error:
            "Can't verify whether the server is stopped because process detection failed. The Docker update was not started.",
          code: ErrorCode.SERVER_STATE_UNKNOWN,
        });
      }

      if (processDetails.running) {
        const rconService = appValue(request, "rconService");
        if (!rconService?.connected) {
          return response.status(409).json({
            error:
              "Stop the Project Zomboid server before applying a Docker update. RCON is not connected, so the panel cannot safely stop it for you.",
            code: ErrorCode.SERVER_RUNNING_RCON_UNAVAILABLE,
          });
        }

        const saved = await rconService.save();
        if (!saved?.success) {
          const reason = saved?.error || "unknown error";
          return response.status(409).json({
            error: `The world could not be saved (${reason}), so the server was left running. Applying the update now would lose everything since the last save.`,
            code: ErrorCode.SAVE_FAILED_LEGACY,
            params: sanitizeErrorParams({ reason }),
          });
        }

        const quit = await rconService.quit();
        if (!quit?.success) {
          const reason = quit?.error || "unknown error";
          return response.status(502).json({
            error: `The world was saved, but the server could not be shut down (${reason}). It is still running, so the update was not applied.`,
            code: ErrorCode.STOP_FAILED_LEGACY,
            params: sanitizeErrorParams({ reason }),
          });
        }
        await logServerEvent(
          "server_stop",
          "Server stopped before Docker panel update",
        );
      }
    }

    const result = await panelUpdateChecker.downloadUpdate();
    if (!result.success) {
      return response
        .status(result.code === ErrorCode.ALREADY_DOWNLOADING_LEGACY ? 409 : 400)
        .json(result);
    }
    response.json(result);
  } catch (error: any) {
    response.status(500).json({ error: sanitizeError(error.message) });
  }
}

async function savePreUpdateDataBackup(version: string): Promise<void> {
  try {
    const dataBackupPath = createUpdateDataBackup(
      { ...getDataPaths(), dbPath: getDatabaseFilePath() },
      version,
    );
    if (dataBackupPath) {
      await setSetting("preUpdateDataBackupPath", dataBackupPath);
      await flushWrites();
    }
  } catch {
    // Keep the existing best-effort snapshot behavior for panel updates.
  }
}

export async function handlePanelRestart(request: Request, response: Response): Promise<void> {
  const checker = appValue(request, "panelUpdateChecker");
  if (!checker) {
    response.status(500).json({ error: "Panel update checker not available" });
    return;
  }

  const staged = checker.getStagedUpdate?.() || null;
  const isPackaged = typeof process.pkg !== "undefined";
  const isWindows = process.platform === "win32";

  if (isPackaged && isWindows && staged) {
    if (!checker.isSupervisorAvailable?.()) {
      response.status(409).json({ error: "This update requires the packaged Start.bat supervisor. Stop the panel and launch Start.bat, then apply again." });
      return;
    }
    if (checker.isApplying) {
      response.status(409).json({ error: "An update apply is already in progress.", code: ErrorCode.APPLY_IN_PROGRESS_LEGACY });
      return;
    }
    checker.isApplying = true;
    try {
      await savePreUpdateDataBackup(staged.version);
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      checker.writeSupervisorMarker(staged);
      setTimeout(() => process.exit(75), 500);
      response.json({
        success: true,
        message: "Stopping panel for supervisor to apply update...",
        applyingUpdate: true,
        supervisor: true,
      });
    } catch (error: any) {
      checker.isApplying = false;
      response.status(500).json({ error: sanitizeError(error.message) });
    }
    return;
  }

  let linuxRespawnPath: string | null = null;
  if (isPackaged && !isWindows && staged) {
    if (checker.isApplying) {
      response.status(409).json({ error: "An update apply is already in progress.", code: ErrorCode.APPLY_IN_PROGRESS_LEGACY });
      return;
    }
    checker.isApplying = true;
    try {
      await savePreUpdateDataBackup(staged.version);
      if (staged.version) {
        await setSetting("pendingPanelUpdate", staged.version);
        await flushWrites();
      }
      const appliedBundle = applyUpdateBundle(staged.journalPath);
      const targetPath = appliedBundle.paths.binary;
      await fs.promises.chmod(targetPath, 0o755).catch(() => {});
      try {
        await fs.promises.access(targetPath, fs.constants.X_OK);
      } catch (error: any) {
        recoverInterruptedUpdateBundle(staged.journalPath, "binary_not_executable");
        throw new Error(`Applied update is not executable: ${error.message}`);
      }
      linuxRespawnPath = targetPath;
    } catch (error: any) {
      checker.isApplying = false;
      response.status(500).json({ error: sanitizeError(error.message) });
      return;
    }
  }

  setTimeout(async () => {
    await flushWrites().catch(() => {});
    const linuxSupervisor = isLinuxPanelSupervisor();
    const orchestrated = isPackaged && Boolean(
      process.env.INVOCATION_ID ||
      process.env.NOTIFY_SOCKET ||
      fs.existsSync("/.dockerenv") ||
      fs.existsSync("/run/.containerenv"),
    );
    if (isPackaged && !orchestrated && !linuxSupervisor) {
      spawn(linuxRespawnPath || process.execPath, [], {
        detached: true,
        stdio: "ignore",
      }).unref();
    }
    process.exit(linuxSupervisor ? 75 : orchestrated ? 1 : 0);
  }, 1000);

  response.json({ success: true, message: "Panel is restarting..." });
}
