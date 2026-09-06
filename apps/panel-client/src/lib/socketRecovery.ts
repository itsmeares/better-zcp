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
