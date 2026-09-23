import { Router } from "../http/apiRouter.ts";
import type { RequestHandler } from "../http/apiRouter.ts";
import { getSetting } from "../database/init.ts";
import { buildPanelInfo, resolvePanelInfoPort, resolvePanelLocalIp } from "../utils/panelInfo.ts";
import { sanitizeError } from "../utils/sanitize.ts";
import {
  handlePanelRestart,
  handlePanelUpdateApplyLog,
  handlePanelUpdateCheck,
  handlePanelUpdateDownload,
  handlePanelUpdatePreflight,
  handlePanelUpdateStatus,
} from "../http/panelUpdateHandlers.ts";

const router = Router();

const requirePanelAdmin: RequestHandler = (req, res, next) => {
  if (req.user?.role === "admin" || req.user?.authDisabled === true) return next();
  res.status(403).json({ error: "Administrator access required" });
};

router.get("/panel-info", async (_req, res) => {
  try {
    const port = resolvePanelInfoPort(await getSetting("panelPort"));
    const localIp = await resolvePanelLocalIp(getSetting);
    res.json(buildPanelInfo(localIp, port));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/panel/update-check", requirePanelAdmin, handlePanelUpdateCheck);
router.get("/panel/update-status", requirePanelAdmin, handlePanelUpdateStatus);
router.get("/panel/update-preflight", requirePanelAdmin, handlePanelUpdatePreflight);
router.get("/panel/update-apply-log", requirePanelAdmin, handlePanelUpdateApplyLog);
router.post("/panel/update-download", requirePanelAdmin, handlePanelUpdateDownload);
router.post("/panel/restart", requirePanelAdmin, handlePanelRestart);

export default router;
