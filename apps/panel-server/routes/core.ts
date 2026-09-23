import { Router } from "../http/apiRouter.ts";
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

router.get("/panel-info", async (_req, res) => {
  try {
    const port = resolvePanelInfoPort(await getSetting("panelPort"));
    const localIp = await resolvePanelLocalIp(getSetting);
    res.json(buildPanelInfo(localIp, port));
  } catch (error: any) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.get("/panel/update-check", handlePanelUpdateCheck);
router.get("/panel/update-status", handlePanelUpdateStatus);
router.get("/panel/update-preflight", handlePanelUpdatePreflight);
router.get("/panel/update-apply-log", handlePanelUpdateApplyLog);
router.post("/panel/update-download", handlePanelUpdateDownload);
router.post("/panel/restart", handlePanelRestart);

export default router;
