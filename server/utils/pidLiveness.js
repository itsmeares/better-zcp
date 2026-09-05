/**
 * Shared pid-liveness primitive.
 *
 * File and backup temp cleanup use this before deleting a file whose owner
 * might still be writing.
 *
 * The startup lock uses the same answer: an inconclusive signal is treated as
 * "still alive" so a second panel instance is never started speculatively.
 *
 * process.kill(pid, 0) is the standard way to probe for a running process
 * without signaling it: confirmed on this platform and on Linux to throw
 * ESRCH for a pid that is not running, and to not throw (or to throw EPERM,
 * for a pid this process doesn't own) for one that is. Any outcome other
 * than a confirmed ESRCH is treated as "still alive" -- an ambiguous signal
 * never authorises the caller's own destructive/exclusive action (deleting
 * an orphan temp; starting a second panel instance), even at the cost of
 * occasionally waiting out a truly-dead process's evidence a little longer.
 *
 * Deliberately does NOT decide how a caller extracts a pid from a filename
 * or a lock file, or what to do with a value that doesn't parse to one at
 * all -- that stays with each caller, since the shapes they read from don't
 * uniformly embed a pid the same way (see backupService.js's
 * CENTRAL_TEMP_PATTERN vs. its *.zip.tmp pattern-only branch, which has no
 * pid to check and must not be given one just to fit this helper).
 */
export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
