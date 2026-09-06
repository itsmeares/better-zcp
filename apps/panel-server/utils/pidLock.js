/**
 * PID lock file for the panel.
 *
 * Prevents two instances of the panel from racing on the same data folder,
 * which previously caused:
 *   - port 3001 EADDRINUSE restart loops (systemd respawning while the
 *     previous process still owned the socket)
 *   - db.json.tmp rename ENOENT races (two writers, one shared tmp name)
 *
 * Behaviour:
 *   - acquireLock() reads any existing lock file and bails out if that PID
 *     is still alive, via the shared isPidAlive() (utils/pidLiveness.js) --
 *     process.kill(pid, 0), treating any error OTHER than ESRCH ("no such
 *     process") as "still alive," never as "safe to overwrite." An
 *     ambiguous signal belongs on the side that fails toward refusing to
 *     start, not toward proceeding (operator ruling, bughunt-2026-08-31-c):
 *     a false PROCEED here is the port-conflict / db.json-corruption pair
 *     this whole file exists to prevent; a false REFUSAL is visible and
 *     recoverable in one step (delete the lock file, restart). This file
 *     used to carry its own separate isProcessAlive(), which got that
 *     direction backwards -- it treated any non-EPERM error as "not alive,"
 *     i.e. safe to proceed -- and was a THIRD, undeduplicated copy of the
 *     exact check pidLiveness.js's own header already claimed was
 *     consolidated to one place. Folding this file onto the shared
 *     primitive removes that copy AND fixes its direction in the same
 *     change; the direction fix is the reason to do this now, not a side
 *     effect of a dedup.
 *   - "Alive" still does NOT verify the PID is actually a panel process
 *     (this comment claimed it did, from this file's very first commit;
 *     the code never did). On a system that reuses PIDs quickly (small
 *     pid_max, Windows), a panel crash followed by a fast restart can land
 *     on a PID the OS has already handed to an unrelated process, and this
 *     would refuse to start believing it's a duplicate instance -- the
 *     SAME "fail toward refusing to start" direction as above, so this is
 *     a known, accepted cost of that ruling, not a separate bug. A real
 *     identity check means reading the target process's argv/image name,
 *     which has no single cross-platform primitive.
 *   - Stale locks (process gone, confirmed via ESRCH) are silently replaced.
 *   - releaseLock() removes the file; registered for process exit signals.
 */

import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { isPidAlive } from './pidLiveness.js';

const log = createLogger('Lock');

let _lockFilePath = null;
let _released = false;

/**
 * Try to acquire the lock. Returns { acquired: true } on success.
 * On failure returns { acquired: false, reason, existingPid }.
 *
 * On success, the caller MUST eventually call releaseLock() or rely on
 * the registered exit handlers to clean up.
 */
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
      // Stale lock (process dead or our own PID re-used) — overwrite.
      log.debug(`Removing stale lock at ${lockPath} (pid ${raw})`);
    }

    fs.writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', mode: 0o600 });
    registerExitHandlers();
    return { acquired: true, lockPath };
  } catch (err) {
    // If we can't write the lock file, log and continue — better to start
    // up without a lock than to refuse to launch entirely (e.g. read-only
    // /data mount in a misconfigured container).
    log.warn(`Could not create lock file: ${err.message} — continuing without duplicate-instance protection`);
    _lockFilePath = null;
    return { acquired: true, lockPath: null };
  }
}

export function releaseLock() {
  if (_released || !_lockFilePath) return;
  _released = true;
  try {
    // Only delete if it still contains our PID — never clobber another
    // instance that may have taken over.
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
  // Use 'exit' for synchronous cleanup. Also catch signals so the file is
  // gone before systemd respawns us.
  process.on('exit', releaseLock);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      releaseLock();
      // Let other handlers run; default behaviour will exit.
    });
  }
}
