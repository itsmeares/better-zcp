import {
  Router,
  type Request,
  createRateLimiter as rateLimit,
} from "../http/startApiRouter.ts";
import authService from "../services/auth.ts";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { setSetting } from "../database/init.ts";
import { verifySetupToken, clearSetupToken } from "../utils/setupToken.ts";
import { getRefreshCookieOptions } from "../utils/refreshCookie.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import {
  checkResetToken,
  createLocalResetResponse,
  createLocalResetToken,
  getResetTokenState,
  isLocalPanelRequest,
  isPanelBehindTrustProxy,
  removeResetToken,
} from "../services/passwordRecovery.ts";
import { z } from "zod";

const log = createLogger("Auth");
const router = Router();

type AuthenticatedRequest = Request & {
  user?: {
    userId?: string | null;
    username?: string | null;
  } | null;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const loginBodySchema = z
  .object({
    username: z.string().min(1).max(32),
    password: z.string().min(1).max(128),
    rememberMe: z.boolean().optional().default(false),
  })
  .strict();

const setupBodySchema = loginBodySchema
  .extend({
    setupToken: z.string().min(1),
    panelPort: z.coerce.number().int().min(1024).max(65535).default(3001),
  })
  .strict();

export {
  createLocalResetResponse,
  isLocalPanelRequest,
  isPanelBehindTrustProxy,
} from "../services/passwordRecovery.ts";

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authService.authenticateAccessToken(authHeader.substring(7));
}

const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many login attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_LOGIN,
  },
});

router.get("/status", async (req, res) => {
  try {
    const needsSetup = await authService.needsSetup();
    const authEnabled = await authService.isAuthEnabled();
    res.json({ needsSetup, authEnabled });
  } catch (error: unknown) {
    log.error(`Failed to get auth status: ${errorMessage(error)}`);
    res.status(500).json({
      error: "Failed to get auth status",
      code: ErrorCode.AUTH_STATUS_CHECK_FAILED,
    });
  }
});

const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many setup attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_SETUP,
  },
});

router.post("/setup", setupLimiter, async (req, res) => {
  try {
    const needsSetup = await authService.needsSetup();
    if (!needsSetup) {
      return res.status(400).json({
        error: "Setup already completed. Use login instead.",
        code: ErrorCode.SETUP_ALREADY_COMPLETED,
      });
    }

    const { setupToken } = req.body || {};
    if (!(await verifySetupToken(setupToken))) {
      return res.status(403).json({
        error: "Invalid or missing setup token",
        code: "SETUP_TOKEN_REQUIRED",
      });
    }

    const parsedBody = setupBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      const hasPanelPortError = parsedBody.error.issues.some(
        (issue) => issue.path[0] === "panelPort",
      );
      return res.status(400).json({
        error: hasPanelPortError
          ? "Panel port must be a whole number between 1024 and 65535"
          : "Setup fields are invalid",
        code: hasPanelPortError
          ? ErrorCode.SETUP_PANEL_PORT_INVALID
          : ErrorCode.AUTH_REQUEST_INVALID,
      });
    }
    const {
      username,
      password,
      rememberMe,
      panelPort: normalizedPanelPort,
    } = parsedBody.data;
    await setSetting("panelPort", normalizedPanelPort);
    await authService.createAdmin(username, password);
    await clearSetupToken();

    const result = await authService.login(
      username,
      password,
      rememberMe === true,
    );

    if (result.refreshToken) {
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    } else {
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
    }

    log.info(`Setup complete — admin account created: ${username}`);
    res.status(201).json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: unknown) {
    log.error(`Setup failed: ${errorMessage(error)}`);
    res.status(400).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const parsedBody = loginBodySchema.safeParse(req.body);
    if (!parsedBody.success) {
      return res.status(400).json({
        error: "Login fields are invalid",
        code: ErrorCode.AUTH_REQUEST_INVALID,
      });
    }
    const { username, password, rememberMe } = parsedBody.data;
    const result = await authService.login(
      username,
      password,
      rememberMe === true,
    );

    if (result.refreshToken) {
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    } else {
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: unknown) {
    log.warn(`Login failed: ${errorMessage(error)}`);
    res.status(401).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.cookies?.refreshToken;
    if (!refreshToken) {
      return res
        .status(401)
        .json({ error: "No refresh token", code: "NO_REFRESH_TOKEN" });
    }

    const result = await authService.refreshAccessToken(refreshToken);
    if (!result) {
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
      return res.status(401).json({
        error: "Invalid refresh token",
        code: "INVALID_REFRESH_TOKEN",
      });
    }

    if (result.refreshToken) {
      res.cookie(
        "refreshToken",
        result.refreshToken,
        getRefreshCookieOptions(req),
      );
    }

    res.json({
      success: true,
      user: result.user,
      accessToken: result.accessToken,
    });
  } catch (error: unknown) {
    log.error(`Token refresh failed: ${errorMessage(error)}`);
    try {
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
    } catch {
      // Headers may already be sent; the 401 below is what matters.
    }
    res.status(401).json({
      error: "Token refresh failed",
      code: ErrorCode.TOKEN_REFRESH_FAILED,
    });
  }
});

router.post("/logout", async (req, res) => {
  await authService.logout(req.cookies?.refreshToken);
  res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
  res.json({ success: true });
});

router.get("/me", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    res.json({
      user: {
        id: user.userId,
        username: user.username,
      },
    });
  } catch (error: unknown) {
    res.status(401).json({
      error: "Authentication error",
      code: ErrorCode.AUTHENTICATION_ERROR,
    });
  }
});

router.post("/change-password", async (req, res) => {
  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }

    const { currentPassword, newPassword } = req.body || {};
    if (!isNonEmptyString(currentPassword) || !isNonEmptyString(newPassword)) {
      return res.status(400).json({
        error: "Current and new password are required",
        code: ErrorCode.CHANGE_PASSWORD_FIELDS_REQUIRED,
      });
    }
    if (newPassword.length > 128) {
      return res.status(400).json({
        error: "Password must be 128 characters or fewer",
        code: ErrorCode.RESET_PASSWORD_TOO_LONG,
      });
    }
    if (typeof user.userId !== "string") {
      return res.status(401).json({
        error: "Not authenticated",
        code: ErrorCode.NOT_AUTHENTICATED,
      });
    }
    await authService.changePassword(user.userId, currentPassword, newPassword);
    res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));

    res.json({ success: true, message: "Password changed successfully" });
  } catch (error: unknown) {
    res.status(400).json({ error: sanitizeError(errorMessage(error)) });
  }
});

router.post(
  "/regenerate-jwt-secret",
  async (req: AuthenticatedRequest, res) => {
    try {
      await authService.regenerateJwtSecret();
      log.warn(
        `JWT secret regenerated by admin: ${req.user?.username || "unknown"}`,
      );
      res.clearCookie("refreshToken", getRefreshCookieOptions(req, false));
      res.json({
        success: true,
        message:
          "JWT signing key regenerated. Every session has been invalidated, including this one — you will need to log in again.",
      });
    } catch (error: unknown) {
      log.error(`JWT secret regeneration failed: ${errorMessage(error)}`);
      res.status(400).json({ error: sanitizeError(errorMessage(error)) });
    }
  },
);

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many reset attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_RESET,
  },
});

router.get("/reset-status", async (req, res) => {
  try {
    const tokenState = getResetTokenState();
    res.json({
      resetAvailable: tokenState.available,
      localResetSupported: isLocalPanelRequest(req),
    });
  } catch (error: unknown) {
    res.json({ resetAvailable: false, localResetSupported: false });
  }
});

const localResetTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many local recovery attempts. Please try again later.",
    code: ErrorCode.RATE_LIMIT_LOCAL_RECOVERY,
  },
});

router.post("/reset-token/local", localResetTokenLimiter, async (req, res) => {
  try {
    if (!isLocalPanelRequest(req)) {
      if (isPanelBehindTrustProxy(req)) {
        return res.status(403).json({
          error:
            "This panel is running behind a reverse proxy, so it can't verify a request came from the server itself. Create data/reset-token.txt on the host directly.",
          code: ErrorCode.LOCAL_RESET_BEHIND_PROXY,
        });
      }
      return res.status(403).json({
        error:
          "This recovery action is only available when the panel is opened from the server itself.",
        code: ErrorCode.LOCAL_RESET_NOT_LOCAL,
      });
    }

    const tokenState = getResetTokenState();
    if (tokenState.available && tokenState.token) {
      return res.json(
        createLocalResetResponse(
          "A recovery token is already available at data/reset-token.txt. Paste it below to continue.",
        ),
      );
    }

    const result = createLocalResetToken();
    if (result.alreadyAvailable) {
      return res.json(
        createLocalResetResponse(
          "A recovery token is already available at data/reset-token.txt. Paste it below to continue.",
        ),
      );
    }

    log.info(
      "Local recovery token created from a request originating on the server",
    );
    res.json(
      createLocalResetResponse(
        "Recovery token created at data/reset-token.txt. Paste it below to continue.",
      ),
    );
  } catch (error: unknown) {
    log.error(`Local recovery token creation failed: ${errorMessage(error)}`);
    res.status(500).json({
      error: "Could not create a recovery token on this server.",
      code: ErrorCode.LOCAL_RESET_TOKEN_CREATE_FAILED,
    });
  }
});

router.post("/reset-password", resetLimiter, async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    if (
      !token ||
      !newPassword ||
      typeof token !== "string" ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({
        error: "Token and new password are required",
        code: ErrorCode.RESET_PASSWORD_FIELDS_REQUIRED,
      });
    }

    if (newPassword.length > 128) {
      return res.status(400).json({
        error: "Password must be 128 characters or fewer",
        code: ErrorCode.RESET_PASSWORD_TOO_LONG,
      });
    }

    const tokenCheck = checkResetToken(token);
    if (!tokenCheck.ok) {
      log.warn(`Password reset rejected: ${tokenCheck.code}`);
      return res
        .status(403)
        .json({ error: tokenCheck.error, code: tokenCheck.code });
    }

    const result = await authService.resetPassword(newPassword);

    try {
      removeResetToken(tokenCheck.tokenPath);
    } catch (unlinkErr: unknown) {
      log.warn(`Could not delete reset-token.txt: ${errorMessage(unlinkErr)}`);
    }

    log.info(`Password reset successful for user: ${result.username}`);
    res.json({
      success: true,
      message: `Password reset for ${result.username}`,
    });
  } catch (error: unknown) {
    log.error(`Password reset failed: ${errorMessage(error)}`);
    res.status(400).json({ error: sanitizeError(errorMessage(error)) });
  }
});

export default router;
