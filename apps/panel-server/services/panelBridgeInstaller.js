/**
 * PanelBridge Auto-Install
 *
 * When the panel has local filesystem access to the PZ server's install
 * directory (bind mount, same-host install), PanelBridge.lua can be copied
 * into place automatically instead of requiring the user to do it by hand.
 * Remote/SFTP-managed servers are never touched here — the panel has no
 * local path to write to for those.
 *
 * Every function degrades to a clear `{ success: false, error }` rather than
 * throwing: install failures must never block server activation (see the
 * best-effort call in routes/servers.js POST /:id/activate).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareModVersions, writeLuaAtomic } from '../utils/embeddedLua.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PanelBridgeInstaller');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION_REGEX = /VERSION\s*=\s*"([^"]+)"/;

// Mirrors the candidate lookup used by the /install-mod-auto and
// /auto-configure routes (dev checkout vs. packaged pkg binary layouts).
function sourceCandidates() {
  return [
    path.join(__dirname, '..', '..', '..', 'integrations', 'panelbridge', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(path.dirname(process.execPath), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
    path.join(process.cwd(), 'pz-mod', 'PanelBridge', 'media', 'lua', 'server', 'PanelBridge.lua'),
  ];
}

export function resolveSourcePath() {
  return sourceCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

// The server's install directory, resolved the same way serverManager does:
// prefer serverPath, fall back to installPath, and if that names a launch
// script (.bat/.sh/.exe) rather than a directory, use its parent folder.
// Exported so index.js's and routes/panelBridge.js's own auto-update/
// auto-install code paths can share this one implementation instead of
// each reimplementing the extension check without the lowercasing below
// (bughunt-2026-08-31-c, launcher-extension-case-sensitivity).
export function resolveInstallDir(server) {
  let dir = server?.serverPath || server?.installPath;
  if (!dir) return null;
  const lower = dir.toLowerCase();
  if (lower.endsWith('.bat') || lower.endsWith('.sh') || lower.endsWith('.exe')) {
    dir = path.dirname(dir);
  }
  return dir;
}

export function resolveTargetPath(server) {
  const installDir = resolveInstallDir(server);
  return installDir ? path.join(installDir, 'media', 'lua', 'server', 'PanelBridge.lua') : null;
}

function isWritableDir(dirPath) {
  try {
    if (!fs.statSync(dirPath).isDirectory()) return false;
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function canAutoInstall(server) {
  if (!server || server.isRemote) return false;
  const installDir = resolveInstallDir(server);
  if (!installDir || !fs.existsSync(installDir) || !isWritableDir(installDir)) {
    return false;
  }
  return Boolean(resolveSourcePath());
}

function extractVersion(content) {
  return (content.match(VERSION_REGEX) || [])[1] || null;
}

function readContent(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    log.debug(`Could not read ${filePath}: ${error.message}`);
    return null;
  }
}

function readVersion(filePath) {
  const content = readContent(filePath);
  return content ? extractVersion(content) : null;
}

// needsUpdate is decided by comparing file CONTENT, not the hand-maintained
// VERSION label inside it. Three consecutive real bridge fixes (2026-08-31,
// operator-fix-the-three, json.decode/runEventSequence/stopWeather) shipped
// without a version bump, so a VERSION-only comparison silently reported
// "up to date" while the fixes never reached any server this gates. VERSION
// is kept only as a human-readable label on the returned status.
export function checkBridgeInstalled(server) {
  const sourcePath = resolveSourcePath();
  const targetPath = resolveTargetPath(server);
  const installed = Boolean(targetPath && fs.existsSync(targetPath));
  const sourceContent = sourcePath ? readContent(sourcePath) : null;
  const targetContent = installed ? readContent(targetPath) : null;
  const targetVersion = targetContent ? extractVersion(targetContent) : null;
  const needsUpdate = Boolean(
    installed && sourceContent !== null &&
    (targetContent === null || targetContent !== sourceContent),
  );

  return { installed, version: targetVersion, needsUpdate, sourcePath, targetPath };
}

// Best-effort: match the copied file's ownership to the install directory's
// so a game server process running as a different, unprivileged user can
// still read it. chown requires elevated privileges on most systems and
// doesn't exist at all on Windows, so failures here are logged, not thrown.
function matchOwnership(targetPath, referencePath) {
  if (process.platform === 'win32' || !referencePath) return;
  try {
    const { uid, gid } = fs.statSync(referencePath);
    fs.chownSync(targetPath, uid, gid);
  } catch (error) {
    log.debug(`Could not match ownership for ${targetPath}: ${error.message}`);
  }
}

export function installBridge(server) {
  const sourcePath = resolveSourcePath();
  const targetPath = resolveTargetPath(server);
  if (!sourcePath) {
    return { success: false, error: 'PanelBridge source not found in panel install.' };
  }
  if (!targetPath) {
    return { success: false, error: 'Server install path not configured.' };
  }

  try {
    const sourceContent = fs.readFileSync(sourcePath, 'utf8');
    const sourceVersion = extractVersion(sourceContent);
    if (!sourceVersion) {
      return { success: false, error: 'PanelBridge source has no readable version.' };
    }
    if (fs.existsSync(targetPath)) {
      const targetContent = fs.readFileSync(targetPath, 'utf8');
      // Fast path: byte-identical already, regardless of what VERSION says.
      // A same-version-different-content install (the exact shape that let
      // three unbumped fixes go undelivered) still needs to fall through to
      // the write below -- only true content equality short-circuits here.
      if (targetContent === sourceContent) {
        return {
          success: true,
          targetPath,
          version: sourceVersion,
          updated: false,
          message: `Existing PanelBridge v${sourceVersion} already matches the bundled version; left unchanged.`,
        };
      }
      const targetVersion = extractVersion(targetContent);
      if (targetVersion && compareModVersions(targetVersion, sourceVersion) > 0) {
        return {
          success: true,
          targetPath,
          version: targetVersion,
          updated: false,
          message: `Existing PanelBridge v${targetVersion} is newer than the bundled v${sourceVersion}; it was left unchanged.`,
        };
      }
    }
    writeLuaAtomic(targetPath, sourceContent);
    matchOwnership(targetPath, resolveInstallDir(server));
    const installedContent = fs.readFileSync(targetPath, 'utf8');
    const version = readVersion(targetPath);
    if (installedContent !== sourceContent || version !== sourceVersion) {
      return { success: false, error: 'PanelBridge verification failed after install.' };
    }
    // Verifies the file the way the GAME will see it, not just the way the
    // panel's own (trivially-successful, same-process) read just did.
    // writeLuaAtomic() now enforces 0644 unconditionally, so this should
    // never actually fire -- it exists as a visible signal in case some
    // future change to that guarantee (or an unusual filesystem) silently
    // breaks it, rather than the mod just never loading with nothing in
    // the log to explain why (2026-08-29 Linux PanelBridge hunt).
    if (process.platform !== 'win32') {
      try {
        const { mode } = fs.statSync(targetPath);
        if ((mode & 0o004) === 0) {
          log.warn(
            `PanelBridge installed at ${targetPath}, but it is not world-readable ` +
              `(mode ${(mode & 0o777).toString(8)}). If the PZ server runs as a ` +
              'different user than the panel, it will not be able to load this mod.',
          );
        }
      } catch {
        /* best-effort */
      }
    }
    log.info(`PanelBridge installed at ${targetPath} (v${version || 'unknown'})`);
    return { success: true, targetPath, version, updated: true };
  } catch (error) {
    log.warn(`PanelBridge install failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Best-effort: keep PanelBridge.lua current on servers the panel can reach
// directly on disk, immediately before the game process (re)spawns. PZ loads
// Lua at Java-process startup, so this is the only moment a write here can
// take effect for the launch that's about to happen -- writing the file
// afterward just produces a fresher file the already-running JVM ignores
// until its next restart. Previously the equivalent check
// (routes/servers.js's own autoInstallBridgeIfNeeded) only ran on POST
// /:id/activate -- an uncommon "reassign the active server profile" action --
// never on an ordinary start or restart, which is how a server can drift
// arbitrarily far behind the shipped bridge with nothing ever re-checking it
// (2026-09-02 bridge-install-integrity audit). Exported so routes/server.js's
// /start and /restart can call the same logic without reimplementing it.
// Never let an install failure block starting/restarting the server -- the
// caller's own comment explains why that would make this fix worse than the
// bug it closes.
export function autoInstallBridgeIfNeeded(server) {
  try {
    if (!canAutoInstall(server)) return;
    const status = checkBridgeInstalled(server);
    if (status.installed && !status.needsUpdate) return;

    const result = installBridge(server);
    if (result.success) {
      log.info(
        `PanelBridge ${status.installed ? 'updated' : 'installed'} at ${result.targetPath} (v${result.version || 'unknown'})`,
      );
    } else {
      log.warn(`PanelBridge auto-install failed: ${result.error}`);
    }
  } catch (error) {
    log.warn(`PanelBridge auto-install check failed: ${error.message}`);
  }
}

// The version currently bundled with this panel install, independent of any
// per-server target. This is the only signal available for a remote/SFTP
// server: canAutoInstall()/checkBridgeInstalled() both require a local
// target path to compare content against, which a remote server has none of
// -- the panel never writes its files. All a remote status check can do is
// compare the mod's own self-reported live VERSION (PanelBridge.lua reports
// PanelBridge.VERSION every tick via status.json) against this.
export function getBundledBridgeVersion() {
  const sourcePath = resolveSourcePath();
  return sourcePath ? readVersion(sourcePath) : null;
}

// True when a live, self-reported bridge version is older than what this
// panel currently bundles. String comparison is the only signal available
// for a remote server -- see getBundledBridgeVersion() above.
export function isBridgeVersionBehindBundled(liveVersion) {
  const bundled = getBundledBridgeVersion();
  if (!bundled || !liveVersion) return false;
  return compareModVersions(liveVersion, bundled) < 0;
}
