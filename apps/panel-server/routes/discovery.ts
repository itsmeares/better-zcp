import express from "express";
import path from "path";
import { createLogger } from "../utils/logger.ts";
const log = createLogger("API:Discovery");
import { sanitizeError, sanitizeServerResponse } from "../utils/sanitize.ts";
import { normalizeRconHost } from "../services/rcon.js";
import { createServer } from "../database/init.js";
import { requirePermission } from "../services/permissions.ts";
import {
  discoverMounts,
  discoverMountIssues,
  probeInstallPath,
  probeDataPath,
  readServerIniSettings,
} from "../services/mountDiscovery.ts";

const router = express.Router();
const SERVER_NAME_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_ -]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;

function normalizePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.get("/discover-mounts", requirePermission("servers.discover"), async (req, res) => {
  try {
    res.json({ mounts: discoverMounts(), inaccessible: discoverMountIssues() });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`Mount discovery failed: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

router.post("/create-from-discovery", requirePermission("servers.discover"), async (req, res) => {
  try {
    const { installPath, dataPath, serverName, name } = req.body || {};
    if (
      typeof installPath !== "string" ||
      typeof dataPath !== "string" ||
      !installPath ||
      !dataPath
    ) {
      return res
        .status(400)
        .json({ error: "installPath and dataPath are required" });
    }

    const discovered = discoverMounts().find(
      (mount) =>
        normalizePath(mount.installPath) === normalizePath(installPath) &&
        typeof mount.dataPath === "string" &&
        normalizePath(mount.dataPath) === normalizePath(dataPath),
    );
    if (!discovered) {
      return res.status(400).json({ error: "Mount is not a discovered PZ server" });
    }
    if (typeof discovered.dataPath !== "string") {
      return res.status(400).json({ error: "Discovered mount has no data path" });
    }

    const installResult = probeInstallPath(discovered.installPath);
    if (!installResult.valid) {
      return res
        .status(400)
        .json({ error: "installPath does not look like a PZ server install" });
    }

    const dataResult = probeDataPath(discovered.dataPath);
    if (!dataResult.valid) {
      return res
        .status(400)
        .json({ error: "dataPath does not look like a PZ data folder" });
    }

    const resolvedName =
      serverName || dataResult.serverNames[0] || installResult.serverNames[0];
    if (!resolvedName) {
      return res.status(400).json({
        error: "No server config (Server/*.ini) found — specify serverName",
      });
    }
    if (!SERVER_NAME_RE.test(resolvedName)) {
      return res.status(400).json({ error: "Invalid serverName" });
    }
    if (
      discovered.serverNames.length > 0 &&
      !discovered.serverNames.includes(resolvedName)
    ) {
      return res.status(400).json({ error: "Server is not part of this mount" });
    }

    const iniSettings = readServerIniSettings(discovered.dataPath, resolvedName);
    if (!iniSettings) {
      return res.status(400).json({
        error: `Could not read valid RCON or game port settings from ${resolvedName}.ini — fix the file, then retry.`,
      });
    }
    if (!iniSettings.rconPassword) {
      return res.status(400).json({
        error: `RCON password not set in ${resolvedName}.ini — set RCONPassword on the server, then retry.`,
      });
    }

    const server = await createServer({
      name: name || iniSettings.publicName || resolvedName,
      serverName: resolvedName,
      installPath: discovered.installPath,
      zomboidDataPath: discovered.dataPath,
      rconHost: normalizeRconHost("127.0.0.1"),
      rconPort: iniSettings.rconPort,
      rconPassword: iniSettings.rconPassword,
      serverPort: iniSettings.serverPort,
      isRemote: false,
    });

    log.info(
      `Created server from discovered mount: ${server.name} (ID: ${server.id})`,
    );
    res
      .status(201)
      .json({
        server: sanitizeServerResponse(server),
        message: "Server created from discovered mount",
      });
  } catch (error: unknown) {
    const message = errorMessage(error);
    log.error(`create-from-discovery failed: ${message}`);
    res.status(500).json({ error: sanitizeError(message) });
  }
});

export default router;
