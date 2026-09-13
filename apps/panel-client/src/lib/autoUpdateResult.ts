import type { AutoUpdateResult } from './api'

export function getAutoUpdateServerStateMessage(
  serverUp: boolean | null | undefined,
): string {
  return serverUp === true
    ? 'Your server is currently running.'
    : serverUp === false
      ? 'Your server is currently stopped.'
      : "Nothing was changed — your server's state is unaffected."
}

export function getAutoUpdateReasonMessage(result: AutoUpdateResult): string {
  const params = result.params ?? {}
  const reasons: Record<string, string> = {
    MANAGED_CONTAINER:
      'This server runs in a panel-managed Docker container. Update the container image instead — the panel does not run SteamCMD against a managed container.',
    NOT_CONFIGURED:
      'The SteamCMD path or server install path is not configured.',
    INITIAL_SCAN_FAILED:
      'Could not verify whether the server was running, so the update was abandoned for safety.',
    RCON_NOT_CONNECTED:
      'RCON was not connected, so the server could not be stopped safely.',
    SAVE_FAILED: `The world could not be saved (${String(params.reason ?? 'unknown reason')}), so the update was abandoned rather than lose progress.`,
    STOP_SCAN_FAILED:
      'Lost the ability to verify the server had stopped, so the update was abandoned for safety.',
    STOP_TIMEOUT: 'The server did not stop within 5 minutes.',
    STEAMCMD_NOT_FOUND: `SteamCMD was not found at ${String(params.path ?? 'the configured path')}.`,
    STEAMCMD_EXIT_CODE: `SteamCMD exited with code ${String(params.code ?? 'unknown')}.`,
    STEAM_OPERATION_IN_PROGRESS: `A Steam install or update was already in progress for ${String(params.path ?? 'this server')}, so the automatic update was abandoned to avoid racing it.`,
  }
  return (
    reasons[result.reason ?? ''] ??
    'An unexpected error occurred during the automatic update.'
  )
}

export function getAutoUpdateSuccessMessage(result: AutoUpdateResult): string {
  return result.appliedVersion
    ? `The automatic server update completed successfully (now running ${result.appliedVersion}).`
    : 'The automatic server update completed successfully.'
}
