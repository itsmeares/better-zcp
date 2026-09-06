/**
 * Registers the recovery path for a socket that just exhausted socket.io's
 * own automatic reconnect attempts (reconnect_failed) -- which, left alone,
 * is a PERMANENT dead end; socket.io never retries again on its own past
 * that point. Two real, event-driven triggers are covered here:
 *   1. the tab was hidden and just became visible again (a background tab
 *      can exhaust all its reconnect attempts while nobody is watching)
 *   2. the browser's network just came back (the actual trigger for a
 *      transient blip)
 * Neither is a timer, and neither runs unless the corresponding real event
 * fires. A third case -- the tab was visible and the network never
 * dropped, so neither of the above can ever fire, and the server was
 * simply down the whole time -- has no event to hang off; that path is a
 * manual retry affordance instead (see ConnectionStatus.tsx's Retry
 * button), which calls `connect` directly rather than through here.
 *
 * Both listeners remove themselves the first time either fires, so
 * recovery is attempted at most once per call to this function. Returns a
 * disposer that only removes the listeners (does NOT call `connect`) --
 * for the caller to force early cleanup if the socket reconnects some
 * other way first (e.g. the manual Retry button). Safe to call even after
 * the listeners have already self-removed.
 */
export function registerReconnectRecovery(connect: () => void): () => void {
  function onVisible() {
    if (document.visibilityState === 'visible') attemptRecovery()
  }
  function attemptRecovery() {
    dispose()
    connect()
  }
  function dispose() {
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('online', attemptRecovery)
  }
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('online', attemptRecovery)
  return dispose
}
