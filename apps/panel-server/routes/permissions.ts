import express from "express";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.ts";
import {
  requirePermission,
  listCapabilitiesGrouped,
  listRolesWithMemberCounts,
  createRole,
  updateRole,
  deleteRole,
} from "../services/permissions.ts";

const log = createLogger("API:Permissions");
const router = express.Router();

interface AuthenticatedRequest extends express.Request {
  user?: { role?: string } | null;
}

router.use(requirePermission("roles.manage"));

function respondWithServiceError(
  res: express.Response,
  error: unknown,
  fallbackMessage: string,
): void {
  const serviceError =
    error && typeof error === "object"
      ? (error as {
          status?: number;
          message?: unknown;
          code?: unknown;
          params?: unknown;
        })
      : {};
  const message =
    typeof serviceError.message === "string" && serviceError.message
      ? serviceError.message
      : fallbackMessage;

  if (serviceError.status) {
    const body: { error: string; code?: string; params?: unknown } = {
      error: message,
    };
    if (typeof serviceError.code === "string") body.code = serviceError.code;
    if (serviceError.params !== undefined) {
      body.params = sanitizeErrorParams(serviceError.params);
    }
    res.status(serviceError.status).json(body);
    return;
  }
  log.error(`${fallbackMessage}: ${message}`);
  res.status(500).json({ error: sanitizeError(message) });
}

router.get("/capabilities", (req, res) => {
  res.json({ groups: listCapabilitiesGrouped() });
});

router.get("/roles", async (req, res) => {
  try {
    const roles = await listRolesWithMemberCounts();
    res.json({ roles });
  } catch (error: unknown) {
    respondWithServiceError(res, error, "Failed to list roles");
  }
});

router.post("/roles", async (req, res) => {
  try {
    const { name, capabilities } = req.body || {};
    const role = await createRole({ name, capabilities });
    res.status(201).json({ success: true, role });
  } catch (error: unknown) {
    respondWithServiceError(res, error, "Failed to create role");
  }
});

router.put("/roles/:id", async (req, res) => {
  try {
    const { name, capabilities, confirmSelfCapabilityLoss } = req.body || {};
    const updateOptions = {
      actingUser: (req as AuthenticatedRequest).user,
      confirmSelfCapabilityLoss: confirmSelfCapabilityLoss === true,
    } as Parameters<typeof updateRole>[2] & Record<string, unknown>;
    const role = await updateRole(
      req.params.id,
      { name, capabilities },
      updateOptions,
    );
    res.json({ success: true, role });
  } catch (error: unknown) {
    respondWithServiceError(res, error, "Failed to update role");
  }
});

router.delete("/roles/:id", async (req, res) => {
  try {
    const reassignTo =
      typeof req.query.reassignTo === "string" ? req.query.reassignTo : undefined;
    const result = await deleteRole(req.params.id, {
      reassignTo,
      actingUser: (req as AuthenticatedRequest).user,
    });
    res.json({ success: true, ...result });
  } catch (error: unknown) {
    respondWithServiceError(res, error, "Failed to delete role");
  }
});

export default router;
