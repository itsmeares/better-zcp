import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isPkg = typeof (process as NodeJS.Process & { pkg?: unknown }).pkg !== 'undefined';

const baseDir = isPkg
  ? path.dirname(process.execPath)
  : path.join(__dirname, '../../..');

const defaultDataDir = path.join(baseDir, 'data');
const defaultLogsDir = path.join(baseDir, 'logs');

const configPath = process.env.PANEL_PATHS_CONFIG_PATH
  ? path.resolve(process.env.PANEL_PATHS_CONFIG_PATH)
  : path.join(baseDir, 'paths.config.json');

interface DataPaths {
  dataDir: string;
  logsDir: string;
  /** The pre-SQLite database location, kept for explicit legacy import checks. */
  dbPath: string;
  configPath: string;
}

interface PathsConfig {
  dataDir?: string;
  logsDir?: string;
}

interface SetDataPathsInput {
  dataDir?: string;
  logsDir?: string;
}

interface SetDataPathsOptions {
  extraBlockedPaths?: unknown;
}

type SetDataPathsResult =
  | { success: false; error: string }
  | { success: true; paths: DataPaths; filesMoved: { data: boolean; logs: boolean } };

let currentPaths: DataPaths | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredPath(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function getDataPaths(): DataPaths {
  if (currentPaths) {
    return currentPaths;
  }

  let config: PathsConfig = {};

  if (fs.existsSync(configPath)) {
    try {
      const configData = fs.readFileSync(configPath, 'utf8');
      const parsed: unknown = JSON.parse(configData);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as PathsConfig;
      }
    } catch (e) {
      console.error(`[PATHS] Failed to load paths config (${configPath}): ${errorMessage(e)}`);
    }
  }

  const dataDir = configuredPath(config.dataDir, defaultDataDir);
  const logsDir = configuredPath(config.logsDir, defaultLogsDir);

  for (const dir of [dataDir, logsDir]) {
    if (fs.existsSync(dir)) continue;
    try {
      fs.mkdirSync(dir, { recursive: true, ...(dir === dataDir ? { mode: 0o700 } : {}) });
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (process.platform === 'win32' && (error.code === 'EPERM' || error.code === 'EACCES')) {
        console.error(
          `\nRefusing to start: could not create "${dir}".\n\n` +
          `This almost always means the panel is installed somewhere your Windows account ` +
          `cannot write to -- most commonly "Program Files" without running as Administrator.\n\n` +
          `Fix one of these, then restart:\n` +
          `  - Move the panel folder somewhere your account can write to (for example C:\\ZomboidPanel), or\n` +
          `  - Right-click Start.bat and choose "Run as administrator".\n\n` +
          `Underlying error: ${errorMessage(err)}\n`
        );
        process.exit(77);
      }
      throw err;
    }
  }

  try {
    fs.chmodSync(dataDir, 0o700);
  } catch {
    /* best-effort: Windows / network shares don't support POSIX modes */
  }

  currentPaths = {
    dataDir,
    logsDir,
    dbPath: path.join(dataDir, 'db.json'),
    configPath
  };

  return currentPaths;
}

function copyDirSync(src: string, dest: string): boolean {
  if (!fs.existsSync(src)) return false;

  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  return true;
}

function normalizeForCompare(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (na === nb) return true;
  const relAB = path.relative(na, nb);
  const relBA = path.relative(nb, na);
  const aContainsB = relAB !== '' && !relAB.startsWith('..') && !path.isAbsolute(relAB);
  const bContainsA = relBA !== '' && !relBA.startsWith('..') && !path.isAbsolute(relBA);
  return aContainsB || bContainsA;
}

export async function setDataPaths(
  newPaths: SetDataPathsInput,
  moveFiles = false,
  options: SetDataPathsOptions = {},
): Promise<SetDataPathsResult> {
  const current = getDataPaths();
  const filesMoved = { data: false, logs: false };
  const extraBlockedPaths = Array.isArray(options.extraBlockedPaths)
    ? options.extraBlockedPaths.filter(
        (p): p is string => typeof p === 'string' && Boolean(p.trim()),
      )
    : [];

  const BLOCKED_PREFIXES = process.platform === 'win32'
    ? [
        'c:\\windows', 'c:\\program files', 'c:\\program files (x86)',
        'c:\\programdata', 'c:\\users\\public'
      ]
    : [
        '/etc', '/usr', '/bin', '/sbin', '/var', '/boot', '/proc', '/sys', '/dev'
      ];

  for (const dir of [newPaths.dataDir, newPaths.logsDir]) {
    if (!dir) continue;
    if (typeof dir !== 'string' || dir.length > 500) {
      return { success: false, error: 'Invalid path format' };
    }
    if (!path.isAbsolute(dir)) {
      return { success: false, error: 'Path must be absolute' };
    }
    const resolved = process.platform === 'win32'
      ? path.resolve(dir).toLowerCase()
      : path.resolve(dir);
    if (BLOCKED_PREFIXES.some(p => resolved.startsWith(p))) {
      return { success: false, error: 'Path targets a protected system directory' };
    }
    const overlappingBlocked = extraBlockedPaths.find((blocked) => pathsOverlap(dir, blocked));
    if (overlappingBlocked) {
      return {
        success: false,
        error: `Path overlaps a configured PZ server's install or data directory (${overlappingBlocked})`,
      };
    }
  }

  const updatedConfig = {
    dataDir: newPaths.dataDir || current.dataDir,
    logsDir: newPaths.logsDir || current.logsDir
  };

  try {
    if (newPaths.dataDir) {
      const testPath = path.join(newPaths.dataDir, '.test');
      fs.mkdirSync(newPaths.dataDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }

    if (newPaths.logsDir) {
      const testPath = path.join(newPaths.logsDir, '.test');
      fs.mkdirSync(newPaths.logsDir, { recursive: true });
      fs.writeFileSync(testPath, 'test');
      fs.unlinkSync(testPath);
    }
  } catch (e) {
    return { success: false, error: `Invalid path: ${errorMessage(e)}` };
  }

  if (moveFiles) {
    try {
      const newDataDir = newPaths.dataDir;
      if (newDataDir && newDataDir !== current.dataDir) {
        if (fs.existsSync(current.dataDir)) {
          copyDirSync(current.dataDir, newDataDir);
          filesMoved.data = true;

          const databaseFiles = ['db.sqlite', 'db.json'];
          const sourceHasDatabase = databaseFiles.some((name) =>
            fs.existsSync(path.join(current.dataDir, name)),
          );
          const destinationHasDatabase = databaseFiles.some((name) =>
            fs.existsSync(path.join(newDataDir, name)),
          );
          if (sourceHasDatabase && !destinationHasDatabase) {
            return {
              success: false,
              error: 'Data directory move did not produce a database file at the new location -- aborted before switching paths. The old location is untouched.',
            };
          }
        }
      }

      if (newPaths.logsDir && newPaths.logsDir !== current.logsDir) {
        if (fs.existsSync(current.logsDir)) {
          copyDirSync(current.logsDir, newPaths.logsDir);
          filesMoved.logs = true;
        }
      }
    } catch (e) {
      return { success: false, error: `Failed to move files: ${errorMessage(e)}` };
    }
  }

  try {
    fs.writeFileSync(configPath, JSON.stringify(updatedConfig, null, 2));
  } catch (e) {
    return { success: false, error: `Failed to save config: ${errorMessage(e)}` };
  }

  currentPaths = null;

  return {
    success: true,
    paths: getDataPaths(),
    filesMoved
  };
}
