import path from "node:path";
import { getPanelRuntime, getServerRuntimes } from "../utils/panelRuntime.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { writePanelRestartRequest, PANEL_RESTART_EXIT } from "../services/panelSupervisor.ts";
import { isContainerized } from "../utils/dockerDetect.ts";
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
    response.status(error.status || 500).json({ error: sanitizeError(error.message) });
  }
}

export async function handlePanelUpdateCheck(request: Request, response: Response): Promise<void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json(await checker.checkForUpdate());
  } catch (error: any) {
    response.status(error.status || 500).json({ error: sanitizeError(error.message) });
  }
}

export async function handlePanelUpdatePreflight(request: Request, response: Response): Promise<void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json(await checker.preflight());
  } catch (error: any) {
    response.status(error.status || 500).json({ error: sanitizeError(error.message) });
  }
}

export function handlePanelUpdateApplyLog(request: Request, response: Response): void {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (!checker) throw new Error("Panel update checker not available");
    response.json({
      log: checker.readMostRecentApplyLog(),
      logPath: path.join(path.dirname(checker.getExeBasePath()), "panel-update-result.json"),
    });
  } catch (error: any) {
    response.status(error.status || 500).json({ error: sanitizeError(error.message) });
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

    if (!panelUpdateChecker.isSupervisorAvailable() && !isContainerized()) {
      response.status(409).json({ error: "Restart using the native package launcher before updating." });
      return;
    }
    if (panelUpdateChecker.isApplying) { response.status(409).json({ error: "A panel update is already in progress." }); return; }
    const staged = panelUpdateChecker.getStagedUpdate();
    const result = staged && (!panelUpdateChecker.latestRelease || staged.version === panelUpdateChecker.latestRelease.version)
      ? { success: true }
      : await panelUpdateChecker.downloadUpdate();
    if (!result.success) {
      return response
        .status(result.code === ErrorCode.ALREADY_DOWNLOADING_LEGACY ? 409 : 400)
        .json(result);
    }
    if (!queueRestart(request, true)) throw new Error("Panel restart is unavailable.");
    response.json({ success: true, applyingUpdate: true, message: "Panel update verified. Backing up data and restarting the panel." });
  } catch (error: any) {
    response.status(error.status || 500).json({ error: sanitizeError(error.message) });
  }
}

function queueRestart(request: Request, update: boolean): boolean {
  if (getServerRuntimes().some(server => server.maintenance?.active || server.backupService?.backupInProgress || server.backupService?.restoreInProgress)) {
    throw Object.assign(new Error("Wait for server maintenance to finish before restarting or updating the panel."), { status: 409 });
  }
  const checker = appValue(request, "panelUpdateChecker");
  const restart = appValue(request, "restartPanel");
  if (!checker || !restart) return false;
  if (checker.isSupervisorAvailable()) {
    writePanelRestartRequest(path.dirname(checker.getExeBasePath()), appValue(request, "getListeningPort")(), update);
    checker.isApplying = update;
    setTimeout(() => void restart(PANEL_RESTART_EXIT), 400).unref();
  } else {
    if (update) return false;
    setTimeout(() => void restart(isContainerized() ? 1 : 0, !isContainerized()), 400).unref();
  }
  return true;
}

export async function handlePanelRestart(request: Request, response: Response): Promise<void> {
  try {
    const checker = appValue(request, "panelUpdateChecker");
    if (checker?.isApplying || checker?.isDownloading) { response.status(409).json({ error: "A panel update is already in progress." }); return; }
    if (!queueRestart(request, false)) throw new Error("Panel restart is unavailable.");
    response.json({ success: true, message: "Panel is restarting. Game processes keep running." });
  } catch (error: any) { response.status(error.status || 500).json({ error: sanitizeError(error.message) }); }
}
