import express from "express";
import { requirePermission } from "../services/permissions.ts";
import {
  QUERY_FAILURE_MESSAGES,
  getServerFinderDebug,
  getServerFinderResponse,
  parseQueryPort,
  pingFinderServer,
  queryFinderServer,
  validateQueryIp,
} from "../services/serverFinder.ts";
import { sanitizeError } from "../utils/sanitize.ts";

const router = express.Router();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

router.use(requirePermission("server.install"));

router.get("/", async (req, res) => {
  try {
    res.json(await getServerFinderResponse(req.query.refresh === "true"));
  } catch (error: unknown) {
    res.status(500).json({
      success: false,
      error: sanitizeError(errorMessage(error)),
    });
  }
});

router.get("/query", async (req, res) => {
  const { ip, port } = req.query;
  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: "IP and port are required",
    });
  }
  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: "Invalid or disallowed IP address",
    });
  }
  const portNumber = parseQueryPort(port);
  if (portNumber === null) {
    return res.status(400).json({
      success: false,
      error: "Invalid port number",
    });
  }

  try {
    const { info, reason } = await queryFinderServer(ip, portNumber);
    if (!info) {
      return res.status(504).json({
        success: false,
        error: QUERY_FAILURE_MESSAGES[reason],
        reason,
      });
    }
    return res.json({ success: true, server: info });
  } catch (error: unknown) {
    return res.status(500).json({
      success: false,
      error: sanitizeError(errorMessage(error)),
    });
  }
});

router.get("/ping", async (req, res) => {
  const { ip, port } = req.query;
  if (!ip || !port) {
    return res.status(400).json({
      success: false,
      error: "IP and port are required",
    });
  }
  if (!validateQueryIp(ip)) {
    return res.status(400).json({
      success: false,
      error: "Invalid or disallowed IP address",
    });
  }
  const portNumber = parseQueryPort(port);
  if (portNumber === null) {
    return res.status(400).json({
      success: false,
      error: "Invalid port number",
    });
  }

  return res.json(await pingFinderServer(ip, portNumber));
});

router.get("/debug", async (_req, res) => {
  try {
    return res.json(await getServerFinderDebug());
  } catch (error: unknown) {
    const status =
      error &&
      typeof error === "object" &&
      "status" in error &&
      typeof error.status === "number"
        ? error.status
        : 500;
    return res
      .status(status)
      .json({ error: sanitizeError(errorMessage(error)) });
  }
});

export * from "../services/serverFinder.ts";
export default router;
