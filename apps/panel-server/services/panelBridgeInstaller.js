
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { compareModVersions, writeLuaAtomic } from '../utils/embeddedLua.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PanelBridgeInstaller');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VERSION_REGEX = /VERSION\s*=\s*"([^"]+)"/;

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

export function getBundledBridgeVersion() {
  const sourcePath = resolveSourcePath();
  return sourcePath ? readVersion(sourcePath) : null;
}

export function isBridgeVersionBehindBundled(liveVersion) {
  const bundled = getBundledBridgeVersion();
  if (!bundled || !liveVersion) return false;
  return compareModVersions(liveVersion, bundled) < 0;
}
