import { logServerEvent } from "../database/init.ts";
import { getPanelRuntime } from "../utils/panelRuntime.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import type { Request, Response } from "./startApiRouter.ts";

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
