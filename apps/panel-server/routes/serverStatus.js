import express from "express";
import { createLogger } from "../utils/logger.js";
import { sanitizeError } from "../utils/sanitize.js";
import { getActiveServer } from "../database/init.js";
import panelBridge from "../services/panelBridge.js";
import { composeServerStatus, resolveProvider } from "../utils/serverStatusModel.js";
import { resolveDockerHostSignal } from "../services/managedContainer.js";

const log = createLogger("API:ServerStatus");
const router = express.Router();

router.get("/active/status", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }

    const serverManager = req.app.get("serverManager");
    const rconService = req.app.get("rconService");
    const rconConfig = rconService?.getConfig ? rconService.getConfig() : {};

    const provider = resolveProvider(server);
    const isContainerProvider =
      provider === "docker-local" || provider === "docker-managed";

    let processDetails;
    let dockerContainer = null;
    if (isContainerProvider) {
      const dockerClient = req.app.get("dockerClient");
      const dockerSignal = await resolveDockerHostSignal(server, dockerClient);
      processDetails = dockerSignal;
      dockerContainer = dockerSignal.scanFailed
        ? { handled: true, error: "Docker container status unavailable" }
        : { handled: true, running: dockerSignal.running };
    } else {
      processDetails = typeof serverManager?.getServerProcessDetails === "function"
        ? await serverManager.getServerProcessDetails()
        : { running: !!serverManager?.isRunning, scanFailed: false };
    }

    const status = composeServerStatus({
      server,
      isRunning: !!processDetails.running,
      scanFailed: !!processDetails.scanFailed,
      dockerContainer,
      rcon: {
        ...rconConfig,
        connecting: !!(rconService?.connecting || rconService?.reconnecting),
      },
      bridge: {
        configured: !!panelBridge.bridgePath,
        running: !!panelBridge.isRunning,
        modConnected: panelBridge.isModConnected ? panelBridge.isModConnected() : false,
      },
    });

    res.json(status);
  } catch (error) {
    log.error(`Failed to get composed server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
