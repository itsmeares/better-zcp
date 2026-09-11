import { Router } from "../http/legacyRouter.ts";
import { createLogger } from "../utils/logger.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import { ErrorCode } from "../utils/errorCodes.ts";
import { requirePermission } from "../services/permissions.ts";
import { getActiveServer } from "../database/init.ts";
import {
  acquireLifecycleLock,
  lifecycleInProgressResponse,
} from "../services/lifecycleCoordinator.ts";
import {
  listTemplates,
  listHiddenBuiltinTemplates,
  getTemplate,
  saveTemplate,
  deleteTemplate,
  unhideTemplate,
  exportTemplate,
  importTemplate,
  previewTemplate,
  applyTemplate,
} from "../services/templateService.ts";

const log = createLogger("API:Templates");
const router = Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get("/", async (req, res) => {
  try {
    res.json({ templates: await listTemplates() });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to list templates: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get("/hidden", requirePermission("templates.manage"), async (req, res) => {
  try {
    res.json({ templates: await listHiddenBuiltinTemplates() });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to list hidden templates: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const template = await getTemplate(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ error: "Template not found", code: ErrorCode.SIM_TEMPLATE_NOT_FOUND });
    }
    res.json({ template });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to get template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await saveTemplate(req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to create template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/import", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await importTemplate(req.body?.template ?? req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to import template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const result = await exportTemplate(req.params.id);
    if (!result.success) return res.status(404).json(result);
    res
      .set("Content-Disposition", `attachment; filename="${req.params.id}.json"`)
      .json(result.template);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to export template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/:id/preview", async (req, res) => {
  try {
    const { serverId } = req.body || {};
    if (!serverId) {
      return res
        .status(400)
        .json({ error: "serverId is required", code: ErrorCode.SIM_TEMPLATE_SERVER_ID_REQUIRED });
    }

    const result = await previewTemplate(req.params.id, serverId);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to preview template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/:id/apply", requirePermission("templates.manage"), async (req, res) => {
  const lifecycleLock = acquireLifecycleLock("template-apply");
  if (!lifecycleLock) {
    return res.status(409).json(lifecycleInProgressResponse());
  }

  try {
    const { serverId, options } = req.body || {};
    if (!serverId) {
      return res
        .status(400)
        .json({ error: "serverId is required", code: ErrorCode.SIM_TEMPLATE_SERVER_ID_REQUIRED });
    }

    const activeServer = await getActiveServer();
    if (String(activeServer?.id) === String(serverId)) {
      const serverManager = req.app.get("serverManager");
      if (!serverManager?.getServerProcessDetails) {
        return res.status(503).json({
          error: "Unable to verify server state",
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        });
      }
      try {
        await serverManager.reloadConfig();
        const details = await serverManager.getServerProcessDetails();
        if (details.scanFailed) {
          return res.status(503).json({
            error: "Unable to verify server state",
            code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
          });
        }
        if (details.running) {
          return res.status(409).json({
            error: "Stop the server before applying a template",
            code: ErrorCode.SIM_TEMPLATE_APPLY_SERVER_RUNNING,
          });
        }
      } catch (error: unknown) {
        log.warn(
          `Could not verify server state before template apply: ${errorMessage(error)}`,
        );
        return res.status(503).json({
          error: "Unable to verify server state",
          code: ErrorCode.SIM_TEMPLATE_APPLY_STATE_UNKNOWN,
        });
      }
    } else {
      return res.status(409).json({
        error:
          "Can't verify this server's running state — the panel can only check the currently active server. Switch to this server first, then apply the template.",
        code: ErrorCode.SIM_TEMPLATE_APPLY_INACTIVE_SERVER_UNVERIFIABLE,
      });
    }

    const result = await applyTemplate(req.params.id as string, serverId, options || {});
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to apply template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  } finally {
    lifecycleLock.release();
  }
});

router.delete("/:id", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id as string);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to delete template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/:id/unhide", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await unhideTemplate(req.params.id as string);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Failed to unhide template: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

export default router;
