import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  autoInstallBridgeIfNeeded,
  canAutoInstall,
  checkBridgeInstalled,
  getBundledBridgeVersion,
  installBridge,
  isBridgeVersionBehindBundled,
  resolveInstallDir,
  resolveSourcePath,
} from '../services/panelBridgeInstaller.js';

// These tests exercise the real integrations/panelbridge/PanelBridge/media/lua/server/PanelBridge.lua
// source shipped with the repo (never modified — only ever copied) against a
// throwaway server install directory under the OS temp dir.
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelbridge-installer-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const localServer = () => ({ id: 's1', installPath: tmpDir, isRemote: false });

describe('canAutoInstall', () => {
  it('is true for a local server with a writable install path', () => {
    expect(canAutoInstall(localServer())).toBe(true);
  });

  it('is false for a remote/SFTP server', () => {
    expect(canAutoInstall({ ...localServer(), isRemote: true })).toBe(false);
  });

  it('is false when installPath is missing', () => {
    expect(canAutoInstall({ id: 's1', isRemote: false })).toBe(false);
  });

  it('is false when installPath points to a regular file', () => {
    const filePath = path.join(tmpDir, 'server-install.txt');
    fs.writeFileSync(filePath, 'not a directory');
    expect(canAutoInstall({ installPath: filePath, isRemote: false })).toBe(false);
  });

  it('is false when installPath does not exist on disk', () => {
    const missing = path.join(tmpDir, 'does-not-exist');
    expect(canAutoInstall({ installPath: missing, isRemote: false })).toBe(false);
  });

  it('resolves a launch-script installPath (.sh) to its parent directory', () => {
    const scriptPath = path.join(tmpDir, 'start-server.sh');
    expect(canAutoInstall({ installPath: scriptPath, isRemote: false })).toBe(true);
  });

  it('is false when the install directory is not writable', () => {
    if (process.platform === 'win32') return; // chmod does not enforce POSIX mode bits
    if (process.getuid && process.getuid() === 0) return; // root bypasses permission bits
    fs.chmodSync(tmpDir, 0o555);
    try {
      expect(canAutoInstall(localServer())).toBe(false);
    } finally {
      fs.chmodSync(tmpDir, 0o755);
    }
  });
});

describe('checkBridgeInstalled', () => {
  it('reports not installed when the mod file is absent', () => {
    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(false);
    expect(status.needsUpdate).toBe(false);
    expect(status.sourcePath).toBe(resolveSourcePath());
    expect(status.targetPath).toBe(
      path.join(tmpDir, 'media', 'lua', 'server', 'PanelBridge.lua'),
    );
  });

  it('reports installed with no update needed once freshly installed', () => {
    installBridge(localServer());
    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(false);
    expect(status.version).toBeTruthy();
  });

  it('flags an update when the installed version is older than the source', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'PanelBridge.lua'),
      'local VERSION = "0.0.1"\n',
    );

    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(true);
  });

  it('flags an update when the installed version cannot be read', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'PanelBridge.lua'), 'invalid lua');

    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(true);
  });

  // 2026-08-31, operator-fix-the-three: three consecutive real bridge fixes
  // shipped without a VERSION bump. A VERSION-only comparison reports "up
  // to date" here even though the installed content is stale -- the exact
  // gap that let those fixes go undelivered to every server this function
  // gates.
  it('flags an update when content differs but VERSION is unchanged', () => {
    const sourceContent = fs.readFileSync(resolveSourcePath(), 'utf8');
    const sourceVersion = sourceContent.match(/VERSION\s*=\s*"([^"]+)"/)[1];
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(
      path.join(targetDir, 'PanelBridge.lua'),
      `-- stale body, same version label\nlocal VERSION = "${sourceVersion}"\n`,
    );

    const status = checkBridgeInstalled(localServer());
    expect(status.installed).toBe(true);
    expect(status.needsUpdate).toBe(true);
  });
});

describe('installBridge', () => {
  it('copies the mod file to the target path unchanged', () => {
    const sourceContent = fs.readFileSync(resolveSourcePath(), 'utf8');
    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(fs.existsSync(result.targetPath)).toBe(true);
    expect(fs.readFileSync(result.targetPath, 'utf8')).toBe(sourceContent);
    expect(result.version).toBeTruthy();
  });

  it('creates the media/lua/server directory tree if missing', () => {
    const target = path.join(tmpDir, 'media', 'lua', 'server', 'PanelBridge.lua');
    expect(fs.existsSync(target)).toBe(false);
    installBridge(localServer());
    expect(fs.existsSync(target)).toBe(true);
  });

  it('fails cleanly when the install path is not configured', () => {
    const result = installBridge({ id: 's1', isRemote: false });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/install path/i);
  });

  it('fails cleanly instead of throwing when the target cannot be created', () => {
    // Make "media" a plain file so mkdirSync('media/lua/server') fails with ENOTDIR.
    fs.writeFileSync(path.join(tmpDir, 'media'), 'not a directory');
    const result = installBridge(localServer());
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('does not downgrade a newer installed bridge', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'PanelBridge.lua');
    fs.writeFileSync(targetPath, 'local VERSION = "99.0.0"\n');

    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(result.updated).toBe(false);
    expect(fs.readFileSync(targetPath, 'utf8')).toContain('99.0.0');
  });

  // 2026-08-31, operator-fix-the-three: same VERSION label as the bundled
  // source, but stale content underneath (a real fix that never bumped the
  // version) -- must still be overwritten with the bundled content.
  it('overwrites a stale install whose VERSION matches the bundled source', () => {
    const sourceContent = fs.readFileSync(resolveSourcePath(), 'utf8');
    const sourceVersion = sourceContent.match(/VERSION\s*=\s*"([^"]+)"/)[1];
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'PanelBridge.lua');
    fs.writeFileSync(
      targetPath,
      `-- stale body, same version label\nlocal VERSION = "${sourceVersion}"\n`,
    );

    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(result.updated).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(sourceContent);
  });

  // Content-identical installs (the common case: nothing changed since the
  // last install) must remain a true no-op, not an unconditional rewrite.
  it('leaves a byte-identical install untouched and reports updated: false', () => {
    installBridge(localServer());
    const result = installBridge(localServer());

    expect(result.success).toBe(true);
    expect(result.updated).toBe(false);
  });
});

// bughunt-2026-08-31-c, launcher-extension-case-sensitivity: index.js's
// PanelBridge auto-update and routes/panelBridge.js's mod auto-install both
// used to reimplement this same launcher-extension check inline, without the
// lowercasing below -- a launcher saved as e.g. "Launch.BAT" resolved its
// install dir as the literal launcher file's own (nonexistent as a
// directory) path instead of its parent folder, silently breaking both
// features for any launcher whose extension wasn't already lowercase. Both
// call sites now share this one implementation instead of each carrying
// their own copy.
// 2026-09-02, bridge-enforcement: the pre-spawn call routes/server.js's
// /start and /restart now make. Route-level ordering (install-before-spawn)
// is covered by serverStartRestartBridgeAutoInstall.test.js; these just
// pin the function's own behavior in isolation.
describe('autoInstallBridgeIfNeeded', () => {
  it('installs a stale bridge', () => {
    const targetDir = path.join(tmpDir, 'media', 'lua', 'server');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'PanelBridge.lua'), 'local VERSION = "0.0.1"\n');

    autoInstallBridgeIfNeeded(localServer());

    expect(fs.readFileSync(path.join(targetDir, 'PanelBridge.lua'), 'utf8')).toBe(
      fs.readFileSync(resolveSourcePath(), 'utf8'),
    );
  });

  it('does not throw when the install fails', () => {
    fs.writeFileSync(path.join(tmpDir, 'media'), 'not a directory');
    expect(() => autoInstallBridgeIfNeeded(localServer())).not.toThrow();
  });

  it('is a no-op for a remote server', () => {
    autoInstallBridgeIfNeeded({ ...localServer(), isRemote: true });
    expect(fs.existsSync(path.join(tmpDir, 'media', 'lua', 'server', 'PanelBridge.lua'))).toBe(false);
  });
});

describe('getBundledBridgeVersion / isBridgeVersionBehindBundled', () => {
  it('returns the same version checkBridgeInstalled reports after a fresh install', () => {
    installBridge(localServer());
    const status = checkBridgeInstalled(localServer());
    expect(getBundledBridgeVersion()).toBe(status.version);
  });

  // The only signal a remote/SFTP server can ever produce: no local file to
  // content-compare, so this is the whole check for that topology.
  it('flags a live version older than what this panel bundles', () => {
    expect(isBridgeVersionBehindBundled('0.0.1')).toBe(true);
  });

  it('does not flag the currently bundled version as behind itself', () => {
    expect(isBridgeVersionBehindBundled(getBundledBridgeVersion())).toBe(false);
  });

  it('does not flag a newer-than-bundled live version as behind', () => {
    expect(isBridgeVersionBehindBundled('999.0.0')).toBe(false);
  });

  it('is false with no live version to compare (unconnected/never reported)', () => {
    expect(isBridgeVersionBehindBundled(null)).toBe(false);
    expect(isBridgeVersionBehindBundled(undefined)).toBe(false);
  });
});

describe('resolveInstallDir', () => {
  it('is case-insensitive for the launch-script extension (.BAT/.Sh/.EXE)', () => {
    for (const ext of ['.bat', '.BAT', '.Bat', '.sh', '.SH', '.Sh', '.exe', '.EXE', '.Exe']) {
      const scriptPath = path.join(tmpDir, `Launch${ext}`);
      expect(resolveInstallDir({ installPath: scriptPath })).toBe(tmpDir);
    }
  });

  it('returns a directory-shaped installPath unchanged', () => {
    expect(resolveInstallDir({ installPath: tmpDir })).toBe(tmpDir);
  });

  it('prefers serverPath over installPath, same as resolveLaunchMode', () => {
    const scriptPath = path.join(tmpDir, 'custom.SH');
    expect(
      resolveInstallDir({ installPath: tmpDir, serverPath: scriptPath }),
    ).toBe(tmpDir);
  });

  it('returns null when neither field is set', () => {
    expect(resolveInstallDir({})).toBeNull();
    expect(resolveInstallDir(null)).toBeNull();
  });
});
