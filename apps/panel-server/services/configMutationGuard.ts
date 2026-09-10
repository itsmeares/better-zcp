import fs from "fs";
import { getActiveServer } from "../database/init.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("ConfigMutationGuard");

interface ServerProfile {
  installPath?: string | null;
  zomboidDataPath?: string | null;
  isRemote?: boolean;
}

interface ProcessDetails {
  running?: boolean;
  scanFailed?: boolean;
}

interface ServerManager {
  reloadConfig?: () => Promise<unknown>;
  getServerProcessDetails?: () => Promise<ProcessDetails>;
}

interface RequestLike {
  app?: { get?: (name: string) => unknown };
  configEditRestartWarning?: boolean;
}

interface ResponseLike {
  status: (code: number) => { json: (body: Record<string, string>) => unknown };
}

type Next = () => unknown;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveLocalPathReachability(
  server: ServerProfile | null | undefined,
): { pathsConfigured: boolean; pathsExistLocally: boolean } {
  const installPath = server?.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath =
    server?.zomboidDataPath || process.env.PZ_SAVE_PATH || null;
  const pathsConfigured = Boolean(installPath || zomboidDataPath);
  const pathsExistLocally =
    Boolean(installPath && fs.existsSync(installPath)) ||
    Boolean(zomboidDataPath && fs.existsSync(zomboidDataPath));
  return { pathsConfigured, pathsExistLocally };
}

export async function requireStoppedForLocalConfigMutation(
  req: RequestLike,
  res: ResponseLike,
  next: Next,
): Promise<unknown> {
  try {
    const activeServer = (await getActiveServer()) as
      | ServerProfile
      | null
      | undefined;

    const { pathsConfigured, pathsExistLocally } =
      resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager") as
      | ServerManager
      | undefined;
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    await serverManager.reloadConfig!();

    const processDetails = await serverManager.getServerProcessDetails();
    if (processDetails.scanFailed) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

    if (processDetails.running) {
      return res.status(409).json({
        code: "SERVER_RUNNING",
        error: "Stop the server before editing configuration.",
      });
    }

    return next();
  } catch (error: unknown) {
    log.warn(
      `Could not verify server state before config mutation: ${errorMessage(error)}`,
    );
    return res.status(503).json({
      code: "SERVER_STATE_UNKNOWN",
      error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
    });
  }
}

export async function warnRunningForLocalConfigEdit(
  req: RequestLike,
  _res: ResponseLike,
  next: Next,
): Promise<unknown> {
  try {
    const activeServer = (await getActiveServer()) as
      | ServerProfile
      | null
      | undefined;

    const { pathsConfigured, pathsExistLocally } =
      resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      req.configEditRestartWarning = true;
      return next();
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager") as
      | ServerManager
      | undefined;
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      req.configEditRestartWarning = true;
      return next();
    }

    try {
      await serverManager.reloadConfig!();
    } catch {
      req.configEditRestartWarning = true;
      return next();
    }

    const processDetails = await serverManager
      .getServerProcessDetails()
      .catch(() => ({ running: true, scanFailed: true }));
    req.configEditRestartWarning =
      processDetails.scanFailed || processDetails.running !== false;
    return next();
  } catch (error: unknown) {
    log.warn(
      `Could not verify server state before config edit: ${errorMessage(error)}`,
    );
    req.configEditRestartWarning = true;
    return next();
  }
}
