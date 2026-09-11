import fs from "fs";
import path from "path";
import { getDataPaths } from "../utils/paths.ts";
import { ErrorCode } from "../utils/errorCodes.ts";

const MAX_EXPORT_FILE_BYTES = 5 * 1024 * 1024;
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const FILENAME_PATTERN = /^[a-zA-Z0-9_.-]+\.json$/;

type PlayerExportError = Error & { code?: string; status?: number };

function exportError(
  message: string,
  code: string,
  status: number,
): PlayerExportError {
  return Object.assign(new Error(message), { code, status });
}

export function parsePlayerExportFile(
  filePath: string,
): Record<string, unknown> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error("Export not found");
  }
  if (stat.size > MAX_EXPORT_FILE_BYTES)
    throw new Error("Export file is too large");

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("Could not read export file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON export file");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid export structure");
  }
  return parsed as Record<string, unknown>;
}

function exportsRoot(): string {
  return path.join(getDataPaths().dataDir, "exports");
}

function exportPath(username: string, filename: string): string {
  if (!USERNAME_PATTERN.test(username) || !FILENAME_PATTERN.test(filename)) {
    throw exportError(
      "Invalid parameters",
      ErrorCode.PLAYERS_EXPORT_INVALID_PARAMETERS,
      400,
    );
  }
  return path.join(exportsRoot(), username, filename);
}

export function listPlayerExports(
  username?: string,
): Array<Record<string, unknown>> {
  const root = exportsRoot();
  if (!fs.existsSync(root)) return [];

  const players = username
    ? [username.replace(/[^a-zA-Z0-9_-]/g, "_")]
    : fs.readdirSync(root).filter((entry) => {
        try {
          return fs.statSync(path.join(root, entry)).isDirectory();
        } catch {
          return false;
        }
      });
  const results: Array<Record<string, unknown>> = [];
  for (const playerDir of players) {
    const dirPath = path.join(root, playerDir);
    if (!fs.existsSync(dirPath)) continue;
    for (const filename of fs
      .readdirSync(dirPath)
      .filter((entry) => entry.endsWith(".json"))
      .sort()
      .reverse()) {
      const stat = fs.statSync(path.join(dirPath, filename));
      results.push({
        username: playerDir,
        filename,
        size: stat.size,
        timestamp: stat.mtime.toISOString(),
      });
    }
  }
  return results.sort((a, b) =>
    String(b.timestamp).localeCompare(String(a.timestamp)),
  );
}

export function getPlayerExport(
  username: string,
  filename: string,
): Record<string, unknown> {
  const filePath = exportPath(username, filename);
  if (!fs.existsSync(filePath)) {
    throw exportError(
      "Export not found",
      ErrorCode.PLAYERS_EXPORT_NOT_FOUND,
      404,
    );
  }
  return parsePlayerExportFile(filePath);
}

export function deletePlayerExport(username: string, filename: string): void {
  const filePath = exportPath(username, filename);
  if (!fs.existsSync(filePath)) {
    throw exportError(
      "Export not found",
      ErrorCode.PLAYERS_EXPORT_NOT_FOUND,
      404,
    );
  }
  fs.unlinkSync(filePath);
}
