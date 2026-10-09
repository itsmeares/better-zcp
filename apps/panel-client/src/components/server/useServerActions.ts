import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { backupApi, rconApi, serverApi } from '@/lib/api'
import { getRecoveryUrl, getUserErrorMessage } from '@/lib/errorMessage'
import { panelQueryKeys } from '@/lib/queryClient'
import { useConfirm, type ConfirmOptions } from '@/contexts/ConfirmContext'
import { CREATE_BACKUP_CONFIRM } from '@/pages/backups/BackupsPage'
import { toastManager } from '@/components/ui/toast'
import { useShell } from '@/components/shell/useShellStatus'

export type ServerAction =
  | { kind: 'start' }
  | { kind: 'stop' }
  | { kind: 'force-stop' }
  | { kind: 'restart'; minutes: number }
  | { kind: 'save' }
  | { kind: 'backup' }
  | { kind: 'connect-rcon' }

export const RESTART_DELAYS = [1, 5, 15] as const

type ToastCopy = { title: string; description?: string; type: 'success' | 'warning' }

function getForceStopSaveOutcomeCopy(saveOutcome: string | undefined) {
  switch (saveOutcome) {
    case 'failed':
      return { title: 'Server force stopped, save failed', description: 'The pre-stop save was refused. Recent progress may be lost.' }
    case 'timedOut':
      return { title: 'Server force stopped, save timed out', description: "The pre-stop save didn't answer within 3 seconds. Recent progress may be lost." }
    case 'skipped':
      return { title: 'Server force stopped without a save', description: "RCON wasn't connected, so the panel couldn't save first. Recent progress may be lost." }
    default:
      return null
  }
}

const minutes = (count: number) => `${count} minute${count === 1 ? '' : 's'}`

function disconnects(players: number) {
  return players > 0 ? ` ${players} player${players === 1 ? ' is' : 's are'} online and will be disconnected.` : ''
}

function confirmFor(action: ServerAction, players: number): ConfirmOptions | null {
  switch (action.kind) {
    case 'stop':
      return { title: 'Stop the server?', description: `The server saves and shuts down.${disconnects(players)}`, confirmLabel: 'Stop server', variant: 'warning' }
    case 'force-stop':
      return {
        title: 'Force stop the server?',
        description: `The panel tries a quick save for up to 3 seconds, then stops the game whether or not the save worked.${disconnects(players)}`,
        confirmLabel: 'Force stop',
        destructive: true,
      }
    case 'restart':
      return action.minutes === 0
        ? { title: 'Restart the server now?', description: `The server restarts right away with no warning.${disconnects(players)}`, confirmLabel: 'Restart now', destructive: true }
        : {
            title: `Restart in ${minutes(action.minutes)}?`,
            description: `Players get a countdown warning in chat, then the server restarts.`,
            confirmLabel: 'Start countdown',
            variant: 'warning',
          }
    case 'backup':
      return CREATE_BACKUP_CONFIRM
    default:
      return null
  }
}

/** Some routes answer 200 with `success: false`; treat that as the error it is. */
async function checked<T>(request: Promise<T>): Promise<T> {
  const result = await request
  if (result && typeof result === 'object' && (result as { success?: boolean }).success === false) {
    const failure = result as { error?: string; message?: string }
    throw new Error(failure.error || failure.message || 'The server refused the action.')
  }
  return result
}

async function perform(action: ServerAction, serverId: string | number | undefined): Promise<ToastCopy> {
  switch (action.kind) {
    case 'start': {
      const result = (await checked(serverApi.start())) as { scriptWarnings?: string[] }
      return result?.scriptWarnings?.length
        ? {
            title: 'Server starting, startup script backed up',
            description: `The panel saved your edited startup script before regenerating it. ${result.scriptWarnings.join(' ')}`,
            type: 'success',
          }
        : { title: 'Server starting', description: 'Status updates here as it comes up.', type: 'success' }
    }
    case 'stop': {
      const result = (await checked(serverApi.stop())) as { confirmed?: boolean }
      return result?.confirmed === false
        ? { title: 'Shutdown requested', description: 'The server is saving and closing. This can take a moment on a large world.', type: 'success' }
        : { title: 'Server stopped', type: 'success' }
    }
    case 'force-stop': {
      const result = (await checked(serverApi.forceStop())) as { saveOutcome?: string }
      const outcome = getForceStopSaveOutcomeCopy(result?.saveOutcome)
      return outcome ? { ...outcome, type: 'warning' } : { title: 'Server force stopped', description: 'The world was saved, then the game stopped.', type: 'success' }
    }
    case 'restart':
      await checked(serverApi.restart(action.minutes))
      return action.minutes === 0
        ? { title: 'Restarting now', type: 'success' }
        : { title: `Restart in ${minutes(action.minutes)}`, description: 'Players are being warned in chat.', type: 'success' }
    case 'save':
      await checked(serverApi.save())
      return { title: 'World saved', type: 'success' }
    case 'backup': {
      const result = await backupApi.createBackup({ expectedServerId: serverId })
      if (!result.success || !result.backup) throw new Error(result.message || 'Failed to create the backup.')
      return result.warnings?.length
        ? { title: 'Backup created, with warnings', description: result.warnings.join(' '), type: 'warning' }
        : { title: 'Backup created', description: result.backup.name, type: 'success' }
    }
    case 'connect-rcon':
      await checked(rconApi.connect())
      return { title: 'RCON connected', type: 'success' }
  }
}

const FAILED_TITLE: Record<ServerAction['kind'], string> = {
  start: 'Could not start the server',
  stop: 'Could not stop the server',
  'force-stop': 'Could not force stop the server',
  restart: 'Could not restart the server',
  save: 'Could not save the world',
  backup: 'Backup failed',
  'connect-rcon': 'Could not connect RCON',
}

/** Lifecycle actions for the selected server, with the same confirms and messages everywhere they appear. */
export function useServerActions() {
  const { selectedServer, playerCount } = useShell()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState<ServerAction['kind'] | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current)
  }, [])

  const refreshStatus = () => {
    void queryClient.invalidateQueries({ queryKey: panelQueryKeys.serverStatus })
    void queryClient.invalidateQueries({ queryKey: panelQueryKeys.activeServerStatus })
  }

  const run = async (action: ServerAction) => {
    if (busy) return
    const confirmOptions = confirmFor(action, playerCount)
    if (confirmOptions && !(await confirm(confirmOptions))) return
    setBusy(action.kind)
    try {
      const result = await perform(action, selectedServer?.id)
      toastManager.add(result)
      refreshStatus()
      if (action.kind === 'start') {
        // A start can take a minute, and not every host reports it over the socket.
        if (pollRef.current) clearInterval(pollRef.current)
        let ticks = 0
        pollRef.current = setInterval(() => {
          refreshStatus()
          if (++ticks >= 15 && pollRef.current) clearInterval(pollRef.current)
        }, 2000)
      }
      if (action.kind === 'backup') void queryClient.invalidateQueries({ queryKey: panelQueryKeys.backupStatus })
    } catch (error) {
      const recoveryUrl = getRecoveryUrl(error)
      toastManager.add({
        title: FAILED_TITLE[action.kind],
        description: getUserErrorMessage(error, 'Try again in a moment.'),
        type: 'error',
        actionProps:
          recoveryUrl === '/server-settings'
            ? { children: 'Open server settings', onClick: () => void navigate({ to: '/server-settings' }) }
            : undefined,
      })
    } finally {
      setBusy(null)
    }
  }

  return { run, busy }
}

export type ServerActions = ReturnType<typeof useServerActions>
