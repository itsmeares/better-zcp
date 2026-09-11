import { Router, type Response } from "../http/startApiRouter.ts";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError, sanitizeServerResponse } from "../utils/sanitize.ts";
import { requirePermission } from "../services/permissions.ts";
import {
  createServerFromDiscovery,
  discoverMountsForServer,
  ServerProfileError,
} from "../services/serverProfiles.ts";

const log = createLogger("API:Discovery");
const router = Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendProfileError(error: unknown, res: Response): boolean {
  if (!(error instanceof ServerProfileError)) return false;
  res.status(error.status).json({
    error: sanitizeError(error.message),
    ...(error.code ? { code: error.code } : {}),
    ...(error.details || {}),
  });
  return true;
}

router.get(
  "/discover-mounts",
  requirePermission("servers.discover"),
  async (_req, res) => {
    try {
      res.json(await discoverMountsForServer());
    } catch (error: unknown) {
      if (sendProfileError(error, res)) return;
      const message = errorMessage(error);
      log.error(`Mount discovery failed: ${message}`);
      res.status(500).json({ error: sanitizeError(message) });
    }
  },
);

router.post(
  "/create-from-discovery",
  requirePermission("servers.discover"),
  async (req, res) => {
    try {
      const server = await createServerFromDiscovery(req.body);
      res.status(201).json({
        server: sanitizeServerResponse(server),
        message: "Server created from discovered mount",
      });
    } catch (error: unknown) {
      if (sendProfileError(error, res)) return;
      const message = errorMessage(error);
      log.error(`create-from-discovery failed: ${message}`);
      res.status(500).json({ error: sanitizeError(message) });
    }
  },
);

export default router;
