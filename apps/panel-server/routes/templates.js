import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { requirePermission } from "../services/permissions.js";
import { getActiveServer } from "../database/init.js";
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
} from "../services/templateService.js";

const log = createLogger("API:Templates");
const router = express.Router();

router.get("/", async (req, res) => {
  try {
    res.json({ templates: await listTemplates() });
  } catch (error) {
    log.error(`Failed to list templates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/hidden", requirePermission("templates.manage"), async (req, res) => {
  try {
    res.json({ templates: await listHiddenBuiltinTemplates() });
  } catch (error) {
    log.error(`Failed to list hidden templates: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
  } catch (error) {
    log.error(`Failed to get template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await saveTemplate(req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to create template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/import", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await importTemplate(req.body?.template ?? req.body);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to import template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/:id/export", async (req, res) => {
  try {
    const result = await exportTemplate(req.params.id);
    if (!result.success) return res.status(404).json(result);
    res
      .set("Content-Disposition", `attachment; filename="${req.params.id}.json"`)
      .json(result.template);
  } catch (error) {
    log.error(`Failed to export template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
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
  } catch (error) {
    log.error(`Failed to preview template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/apply", requirePermission("templates.manage"), async (req, res) => {
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
      } catch (error) {
        log.warn(`Could not verify server state before template apply: ${error.message}`);
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

    const result = await applyTemplate(req.params.id, serverId, options || {});
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to apply template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/:id", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to delete template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.post("/:id/unhide", requirePermission("templates.manage"), async (req, res) => {
  try {
    const result = await unhideTemplate(req.params.id);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (error) {
    log.error(`Failed to unhide template: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
