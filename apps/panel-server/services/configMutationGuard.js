import fs from "fs";
import { getActiveServer } from "../database/init.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ConfigMutationGuard");

function resolveLocalPathReachability(server) {
  const installPath = server?.installPath || process.env.PZ_SERVER_PATH || "";
  const zomboidDataPath = server?.zomboidDataPath || process.env.PZ_SAVE_PATH || null;
  const pathsConfigured = Boolean(installPath || zomboidDataPath);
  const pathsExistLocally =
    Boolean(installPath && fs.existsSync(installPath)) ||
    Boolean(zomboidDataPath && fs.existsSync(zomboidDataPath));
  return { pathsConfigured, pathsExistLocally };
}

export async function requireStoppedForLocalConfigMutation(req, res, next) {
  try {
    const activeServer = await getActiveServer();

    const { pathsConfigured, pathsExistLocally } = resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      return res.status(503).json({
        code: "SERVER_STATE_UNKNOWN",
        error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
      });
    }

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
  } catch (error) {
    log.warn(
      `Could not verify server state before config mutation: ${error.message}`,
    );
    return res.status(503).json({
      code: "SERVER_STATE_UNKNOWN",
      error: "Can't verify whether the server is actually stopped — the process-detection scan itself failed, not the server. Check the panel's log for the error. If this keeps happening, something on this host (antivirus, a full disk, or a missing system tool) may be blocking detection.",
    });
  }
}

export async function warnRunningForLocalConfigEdit(req, res, next) {
  try {
    const activeServer = await getActiveServer();

    const { pathsConfigured, pathsExistLocally } = resolveLocalPathReachability(activeServer);
    if (pathsConfigured && !pathsExistLocally) {
      req.configEditRestartWarning = true;
      return next();
    }
    if (activeServer?.isRemote) return next();

    const serverManager = req.app?.get?.("serverManager");
    if (typeof serverManager?.getServerProcessDetails !== "function") {
      req.configEditRestartWarning = true;
      return next();
    }

    const processDetails = await serverManager
      .getServerProcessDetails()
      .catch(() => ({ running: true, scanFailed: true }));
    req.configEditRestartWarning =
      processDetails.scanFailed || processDetails.running !== false;
    return next();
  } catch (error) {
    log.warn(
      `Could not verify server state before config edit: ${error.message}`,
    );
    req.configEditRestartWarning = true;
    return next();
  }
}
