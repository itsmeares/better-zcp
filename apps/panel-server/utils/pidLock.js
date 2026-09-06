
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { isPidAlive } from './pidLiveness.js';

const log = createLogger('Lock');

let _lockFilePath = null;
let _released = false;

export function acquireLock(dataDir) {
  const lockPath = path.join(dataDir, 'panel.lock');
  _lockFilePath = lockPath;

  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf8').trim();
      const existingPid = parseInt(raw, 10);
      if (
        Number.isInteger(existingPid) &&
        existingPid > 0 &&
        existingPid !== process.pid &&
        isPidAlive(existingPid)
      ) {
        return {
          acquired: false,
          reason: `another panel instance is already running (pid ${existingPid})`,
          existingPid,
          lockPath,
        };
      }
      log.debug(`Removing stale lock at ${lockPath} (pid ${raw})`);
    }

    fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', mode: 0o600 });
    registerExitHandlers();
    return { acquired: true, lockPath };
  } catch (err) {
    log.warn(`Could not create lock file: ${err.message} — continuing without duplicate-instance protection`);
    _lockFilePath = null;
    return { acquired: true, lockPath: null };
  }
}

export function releaseLock() {
  if (_released || !_lockFilePath) return;
  _released = true;
  try {
    if (fs.existsSync(_lockFilePath)) {
      const raw = fs.readFileSync(_lockFilePath, 'utf8').trim();
      if (raw === String(process.pid)) {
        fs.unlinkSync(_lockFilePath);
      }
    }
  } catch {
    // best-effort
  }
}

let _handlersRegistered = false;
function registerExitHandlers() {
  if (_handlersRegistered) return;
  _handlersRegistered = true;
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      releaseLock();
      // Let other handlers run; default behaviour will exit.
    });
  }
}
