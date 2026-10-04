import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "./logger.ts";

const log = createLogger("WorkshopMaps");

export function getWorkshopPaths(workshopId: string, serverPath: string): string[] {
  const home = os.homedir();
  const paths = [
    path.join(
      serverPath,
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    path.join(
      serverPath,
      "..",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
    path.join(
      home,
      "Steam",
      "steamapps",
      "workshop",
      "content",
      "108600",
      workshopId,
    ),
  ];
  if (process.platform !== "win32") {
    paths.push(
      path.join(
        home,
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      path.join(
        home,
        ".steam",
        "steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
      path.join(
        home,
        ".var",
        "app",
        "com.valvesoftware.Steam",
        ".local",
        "share",
        "Steam",
        "steamapps",
        "workshop",
        "content",
        "108600",
        workshopId,
      ),
    );
  }
  return paths;
}

function isValidMapFolder(mapFolderPath: string): boolean {
  try {
    const files = fs.readdirSync(mapFolderPath);
    for (const file of files) {
      const lower = file.toLowerCase();
      if (
        lower.endsWith(".lotheader") ||
        lower === "objects.lua" ||
        lower.endsWith(".lotpack")
      ) {
        return true;
      }
      if (lower.startsWith("world_") || lower.startsWith("chunkdata_")) {
        return true;
      }
    }
    return false;
  } catch (e: any) {
    log.debug(`Error validating map folder ${mapFolderPath}: ${e.message}`);
    return false;
  }
}

/** Map folders (name and absolute path) shipped by one workshop item. */
export function findMapFolderPathsFromWorkshop(
  workshopId: string,
  serverPath: string,
): Array<{ name: string; path: string }> {
  const mapFolders: Array<{ name: string; path: string }> = [];
  const possiblePaths = getWorkshopPaths(workshopId, serverPath);

  function scanMapsDir(mapsPath: string): void {
    if (!fs.existsSync(mapsPath)) return;
    const mapEntries = fs.readdirSync(mapsPath, { withFileTypes: true });
    for (const mapEntry of mapEntries) {
      if (
        mapEntry.isDirectory() &&
        !mapFolders.some((folder) => folder.name === mapEntry.name) &&
        isValidMapFolder(path.join(mapsPath, mapEntry.name))
      ) {
        mapFolders.push({ name: mapEntry.name, path: path.join(mapsPath, mapEntry.name) });
        log.debug(
          `Found valid map folder: ${mapEntry.name} in workshop ${workshopId}`,
        );
      }
    }
  }

  for (const workshopPath of possiblePaths) {
    if (!fs.existsSync(workshopPath)) continue;

    const modsFolder = path.join(workshopPath, "mods");
    const searchPath = fs.existsSync(modsFolder) ? modsFolder : workshopPath;

    try {
      if (fs.existsSync(searchPath)) {
        const entries = fs.readdirSync(searchPath, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const entryPath = path.join(searchPath, entry.name);

          scanMapsDir(path.join(entryPath, "media", "maps"));

          try {
            const subEntries = fs.readdirSync(entryPath, {
              withFileTypes: true,
            });
            for (const sub of subEntries) {
              if (sub.isDirectory()) {
                scanMapsDir(path.join(entryPath, sub.name, "media", "maps"));
              }
            }
          } catch {
            // Ignore unreadable mod folders
          }
        }
      }

      scanMapsDir(path.join(workshopPath, "media", "maps"));

      if (mapFolders.length > 0) return mapFolders;
    } catch (e: any) {
      // Continue to next path
    }
  }

  return mapFolders;
}

export function findMapFoldersFromWorkshop(workshopId: string, serverPath: string): string[] {
  return findMapFolderPathsFromWorkshop(workshopId, serverPath).map((folder) => folder.name);
}
