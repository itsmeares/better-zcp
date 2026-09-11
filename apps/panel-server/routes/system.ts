import { Router, type Request } from "../http/legacyRouter.ts";
import { getCircuitBreakerStatus } from "../database/init.ts";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { buildRuntimeInfo } from "../utils/runtimeInfo.ts";
import { buildDiskSpace as buildSystemDiskSpace } from "../utils/systemInfo.ts";

const log = createLogger("API:System");
const router = Router();

export { buildRuntimeInfo };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildDiskSpace(req: Request) {
  return buildSystemDiskSpace(req.app.get("diskMonitor"));
}

router.get("/disk-space", async (req, res) => {
  try {
    res.json(await buildDiskSpace(req));
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get disk space: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get("/runtime", (_req, res) => {
  res.json(buildRuntimeInfo());
});

router.get("/storage-health", async (req, res) => {
  try {
    const diskSpace = await buildDiskSpace(req);
    const circuitBreaker = getCircuitBreakerStatus();
    res.json({
      diskSpace,
      circuitBreaker: {
        ...circuitBreaker,
        lastError: circuitBreaker.lastError
          ? sanitizeError(circuitBreaker.lastError)
          : null,
      },
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get storage health: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

export default router;
