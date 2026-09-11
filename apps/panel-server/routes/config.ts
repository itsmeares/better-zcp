import { Router, type Request } from "../http/legacyRouter.ts";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Config");
import { getAllSettings } from "../database/init.ts";
import { sanitizeError, maskSensitiveObject } from "../utils/sanitize.ts";
import { requirePermission } from "../services/permissions.ts";
import {
  checkTcpReachable,
  RCON_UNREACHABLE_DETAIL,
  RCON_AUTH_FAILED_DETAIL,
  RCON_USER_ACTION_TIMEOUT_MS,
} from "../services/rcon.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  AppSettingsError,
  saveAppSettings,
} from "../services/appSettings.ts";

const router = Router();

type ConfigRequest = Request & {
  user?: { role?: string } | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const maskSensitiveSettings = maskSensitiveObject;

router.get("/app-settings", async (_req, res) => {
  try {
    const settings = await getAllSettings();
    res.json({ settings: maskSensitiveSettings(settings) });
  } catch (error: unknown) {
    log.error(`Failed to get app settings: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.put(
  "/app-settings",
  requirePermission("panel.settings"),
  async (req: ConfigRequest, res) => {
    try {
      const settings = req.body?.settings;
      const settingCount =
        settings && typeof settings === "object" ? Object.keys(settings).length : 0;
      log.info(
        `PUT /app-settings — updating ${settingCount} keys: [${settings && typeof settings === "object" ? Object.keys(settings).join(", ") : ""}]`,
      );

      const result = await saveAppSettings(settings, {
        userRole: req.user?.role,
        runtime: {
          modChecker: req.app.get("modChecker"),
          serverManager: req.app.get("serverManager"),
          rconService: req.app.get("rconService"),
          refreshCorsConfig: req.app.get("refreshCorsConfig"),
        },
      });
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof AppSettingsError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.params !== undefined ? { params: error.params } : {}),
          ...(error.missing ? { missing: error.missing } : {}),
        });
      }
      log.error(`Failed to save app settings: ${errorMessage(error)}`);
      res.status(500).json({ error: sanitizeError(errorMessage(error)) });
    }
  },
);

router.get("/cors-debug", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (typeof getCorsDebugSnapshot !== "function") {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }
    res.json({ diagnostics: getCorsDebugSnapshot() });
  } catch (error: unknown) {
    log.error(`Failed to get CORS diagnostics: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/cors-debug/reload", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const refreshCorsConfig = req.app.get("refreshCorsConfig");
    if (typeof refreshCorsConfig !== "function") {
      return res
        .status(500)
        .json({ error: "CORS config reload is not available", code: ErrorCode.CONFIG_CORS_RELOAD_UNAVAILABLE });
    }
    const diagnostics = await refreshCorsConfig();
    res.json({ success: true, diagnostics });
  } catch (error: unknown) {
    log.error(`Failed to reload CORS config: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.delete("/cors-debug/blocked", requirePermission("diagnostics.manage"), async (req, res) => {
  try {
    const clearCorsBlockedOrigins = req.app.get("clearCorsBlockedOrigins");
    const getCorsDebugSnapshot = req.app.get("getCorsDebugSnapshot");
    if (
      typeof clearCorsBlockedOrigins !== "function" ||
      typeof getCorsDebugSnapshot !== "function"
    ) {
      return res
        .status(500)
        .json({ error: "CORS diagnostics are not available", code: ErrorCode.CONFIG_CORS_DIAGNOSTICS_UNAVAILABLE });
    }

    clearCorsBlockedOrigins();
    res.json({ success: true, diagnostics: getCorsDebugSnapshot() });
  } catch (error: unknown) {
    log.error(`Failed to clear blocked CORS origins: ${errorMessage(error)}`);
    res.status(500).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/test-rcon", requirePermission("server.configure"), async (req, res) => {
  try {
    const rconService = req.app.get("rconService");

    const connected = await rconService.connect();

    if (connected) {
      try {
        const probe = await rconService.execute("players", { skipLog: true });
        if (!probe?.success) {
          res.json({
            success: true,
            message:
              "Connected but command failed: " + sanitizeError(probe?.error),
            connected: true,
            warning: true,
          });
          return;
        }
        res.json({
          success: true,
          message: "RCON connection successful",
          connected: true,
        });
      } catch (cmdError: unknown) {
        res.json({
          success: true,
          message:
            "Connected but command failed: " + sanitizeError(errorMessage(cmdError)),
          connected: true,
          warning: true,
        });
      }
    } else {
      const { host: configuredHost, port: configuredPort } =
        rconService.getConfig();
      const reachable = await checkTcpReachable(
        configuredHost,
        configuredPort,
        RCON_USER_ACTION_TIMEOUT_MS,
      );
      if (!reachable) {
        return res.json({
          success: false,
          error: "unreachable",
          detail: RCON_UNREACHABLE_DETAIL,
          message: RCON_UNREACHABLE_DETAIL,
          connected: false,
          code: ErrorCode.RCON_CONNECT_UNREACHABLE,
        });
      }
      res.json({
        success: false,
        error: "auth_failed",
        detail: RCON_AUTH_FAILED_DETAIL,
        message: RCON_AUTH_FAILED_DETAIL,
        connected: false,
        code: ErrorCode.RCON_CONNECT_AUTH_FAILED,
      });
    }
  } catch (error: unknown) {
    log.error(`RCON test failed: ${errorMessage(error)}`);
    res.status(500).json({
      success: false,
      error: sanitizeError(errorMessage(error)),
      connected: false,
    });
  }
});

export default router;
