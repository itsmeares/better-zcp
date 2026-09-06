function sendToServer(message: string, error?: unknown) {
  try {
    const payload = {
      message: String(message).slice(0, 500),
      error: error instanceof Error ? error.message : String(error ?? '').slice(0, 1000),
      url: typeof window !== 'undefined' ? window.location.href : undefined,
    }
    fetch('/api/debug/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {}) // swallow network errors — don't cascade
  } catch { /* swallow */ }
}

export function reportClientError(message: string, error?: unknown) {
  if (import.meta.env.DEV) {
    console.error(message, error)
  }
  sendToServer(message, error)
}

export function reportClientWarning(message: string, details?: unknown) {
  if (import.meta.env.DEV) {
    console.warn(message, details)
  }
  sendToServer(message, details)
}