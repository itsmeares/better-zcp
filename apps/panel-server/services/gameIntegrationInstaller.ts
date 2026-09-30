import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getEmbeddedArgusLua } from "../utils/embeddedLua.ts";
import { readRegularFile } from "../utils/regularFile.ts";
import { writeFileAtomic } from "../utils/fileWriteQueue.ts";

interface GameServer { serverPath?: string | null; installPath?: string | null }

export function resolveInstallDir(server?: GameServer | null): string | null {
  const target = server?.serverPath || server?.installPath;
  if (!target || !path.isAbsolute(target)) return null;
  return /\.(bat|sh|exe)$/i.test(target) ? path.dirname(target) : target;
}

function bundledLua(): string {
  const embedded = getEmbeddedArgusLua();
  if (embedded) return embedded;
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const candidates = [
    path.join(root, "integrations/argus/Argus/media/lua/server/Argus.lua"),
    path.join(path.dirname(process.execPath), "pz-mod/Argus/media/lua/server/Argus.lua"),
    path.join(process.cwd(), "pz-mod/Argus/media/lua/server/Argus.lua"),
  ];
  const source = candidates.find((file) => fs.existsSync(file));
  if (!source) throw new Error("Bundled game integration is missing from the panel installation.");
  return readRegularFile(source, 1024 * 1024);
}

export function getGameIntegrationInstallStatus(server?: GameServer | null) {
  const directory = resolveInstallDir(server);
  const targetPath = directory ? path.join(directory, "media/lua/server/Argus.lua") : null;
  let installed = false, needsUpdate = false, canAutoInstall = false;
  let version: string | null = null;
  let source: string | null = null;
  try { source = bundledLua(); } catch { /* An incomplete panel install cannot install the integration. */ }
  if (targetPath) {
    try {
      const content = readRegularFile(targetPath, 1024 * 1024);
      installed = true;
      version = content.match(/VERSION\s*=\s*"([^"]+)"/)?.[1] || null;
      needsUpdate = source !== null && content !== source;
    } catch { /* Missing or unreadable target. */ }
  }
  if (directory && targetPath && source) {
    try {
      if (!fs.statSync(directory).isDirectory()) throw new Error("Game install is not a directory.");
      let parent = path.dirname(targetPath);
      while (!fs.existsSync(parent)) parent = path.dirname(parent);
      if (!fs.statSync(parent).isDirectory()) throw new Error("Game Lua path is not a directory.");
      if (fs.existsSync(targetPath) && !fs.lstatSync(targetPath).isFile()) throw new Error("Game integration target is not a regular file.");
      fs.accessSync(parent, fs.constants.W_OK);
      canAutoInstall = true;
    } catch { /* A readable installation may still be unwritable. */ }
  }
  return { installed, needsUpdate, canAutoInstall, version, targetPath };
}

export function installGameIntegration(server?: GameServer | null) {
  const directory = resolveInstallDir(server);
  if (!directory || !fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    return { success: false, error: "Configure an existing local game installation first." };
  }
  const targetPath = path.join(directory, "media/lua/server/Argus.lua");
  try {
    const source = bundledLua();
    if (!/VERSION\s*=\s*"[^"]+"/.test(source)) throw new Error("Bundled game integration has no version.");
    const legacy = path.join(directory, "media/lua/server/PanelBridge.lua");
    if (fs.existsSync(legacy) && !readRegularFile(legacy, 1024 * 1024).includes("local PanelBridge =")) {
      throw new Error("An unrecognized PanelBridge.lua exists in this installation. Move it out of the server Lua directory before installing.");
    }
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
    const existing = fs.existsSync(targetPath) ? readRegularFile(targetPath, 1024 * 1024) : null;
    if (existing !== null && !existing.includes("local Argus =")) throw new Error("An unrecognized Argus.lua exists in this installation. Move it out of the server Lua directory before installing.");
    const unchanged = existing === source;
    if (!unchanged) {
      writeFileAtomic(targetPath, source, { encoding: "utf8", mode: 0o644 });
      if (readRegularFile(targetPath, 1024 * 1024) !== source) throw new Error("Game integration verification failed after installation.");
    }
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
    return { success: true, targetPath, version: source.match(/VERSION\s*=\s*"([^"]+)"/)![1], updated: !unchanged };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function ensureGameIntegrationInstalled(server?: GameServer | null): void {
  const result = installGameIntegration(server);
  if (!result.success) throw new Error(result.error);
}
