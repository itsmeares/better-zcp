export interface InstallProgressPayload {
  progressCode?: unknown
  params?: unknown
}

export function getInstallProgressMessage(
  _payload: InstallProgressPayload,
  fallback: string,
): string {
  return fallback
}
