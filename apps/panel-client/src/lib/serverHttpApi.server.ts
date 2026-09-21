import '@tanstack/react-start/server-only'

import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  streamUploadToFile,
  UPLOAD_BAD_SIGNATURE_CODE,
  UPLOAD_TOO_LARGE_CODE,
} from '../../../panel-server/utils/uploadStream.ts'
import { ErrorCode } from '../../../panel-server/utils/errorCodes.ts'
import { sanitizeErrorParams } from '../../../panel-server/utils/sanitize.ts'

type AnyRecord = Record<string, any>
type HandlerContext = {
  authenticatedUser: AnyRecord | null
  request?: Request
}

async function runtime(): Promise<AnyRecord> {
  const { getPanelRuntime } =
    await import('../../../panel-server/utils/panelRuntime.ts')
  return getPanelRuntime()
}

function fail(message: string, status = 500, code?: string, extra?: AnyRecord): never {
  throw Object.assign(new Error(message), {
    status,
    ...(code ? { code } : {}),
    ...(extra || {}),
  })
}

export async function downloadBackup(data: AnyRecord): Promise<Response> {
  const backupService = (await runtime()).backupService
  const backupsPath = await backupService.getBackupsPath()
  if (!backupsPath) fail('Backups folder not found', 404, ErrorCode.BACKUPS_FOLDER_NOT_FOUND)
  const name = path.basename(String(data.name || ''))
  if (!name.endsWith('.zip')) fail('Invalid backup file', 400, ErrorCode.BACKUP_INVALID_FILE)
  const filePath = path.join(backupsPath, name)
  if (!fs.existsSync(filePath)) fail('Backup not found', 404, ErrorCode.BACKUP_NOT_FOUND)
  const stats = await fs.promises.stat(filePath)
  return new Response(Readable.toWeb(fs.createReadStream(filePath)) as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(stats.size),
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
    },
  })
}

export async function uploadBackup(_data: AnyRecord, context: HandlerContext): Promise<AnyRecord> {
  const request = context.request
  if (!request?.body || request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/zip') {
    fail('No file uploaded. Send the zip body with Content-Type: application/zip.', 400, ErrorCode.BACKUP_UPLOAD_NO_FILE)
  }
  const rawName = request.headers.get('x-backup-filename') || 'uploaded-backup.zip'
  const baseName = path.basename(rawName).replace(/[^A-Za-z0-9_.\- ]/g, '_').slice(0, 200)
  if (!baseName.toLowerCase().endsWith('.zip')) fail('Only .zip backups are accepted.', 400, ErrorCode.BACKUP_UPLOAD_INVALID_EXTENSION)
  const backupService = (await runtime()).backupService
  const backupsPath = await backupService.getBackupsPath()
  if (!backupsPath) fail('Backups folder not available. Configure the server first.', 500, ErrorCode.BACKUPS_FOLDER_UNAVAILABLE)
  await fs.promises.mkdir(backupsPath, { recursive: true })
  const finalName = baseName.startsWith('uploaded-') ? baseName : `uploaded-${baseName}`
  const targetPath = path.join(backupsPath, finalName)
  if (fs.existsSync(targetPath)) fail(`A backup named "${finalName}" already exists. Delete it first or rename the upload.`, 409, ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT, { params: sanitizeErrorParams({ name: finalName }) })
  const tempPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    const totalBytes = await streamUploadToFile(
      Readable.fromWeb(request.body as any),
      tempPath,
      4 * 1024 * 1024 * 1024,
    )
    if (totalBytes === 0) fail('No file uploaded. Send the zip body with Content-Type: application/zip.', 400, ErrorCode.BACKUP_UPLOAD_NO_FILE)
    try {
      await fs.promises.link(tempPath, targetPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail(`A backup named "${finalName}" already exists. Delete it first or rename the upload.`, 409, ErrorCode.BACKUP_UPLOAD_NAME_CONFLICT, { params: sanitizeErrorParams({ name: finalName }) })
      throw error
    }
    return {
      success: true,
      name: finalName,
      size: totalBytes,
      message: `Uploaded backup saved as ${finalName}. Use Restore to apply it.`,
    }
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as AnyRecord).code : undefined
    if (code === UPLOAD_BAD_SIGNATURE_CODE) fail('File does not look like a valid .zip archive.', 400, ErrorCode.BACKUP_UPLOAD_INVALID_ZIP_SIGNATURE)
    if (code === UPLOAD_TOO_LARGE_CODE) fail('Upload exceeds the configured size limit.', 413, ErrorCode.BACKUP_UPLOAD_TOO_LARGE)
    throw error
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined)
  }
}

export async function getActiveServerStatus(): Promise<AnyRecord> {
  const runtimeValue = await runtime()
  const { getActiveServer } = await import('../../../panel-server/database/init.ts')
  const { composeServerStatus, resolveProvider } = await import('../../../panel-server/utils/serverStatusModel.ts')
  const { resolveDockerHostSignal } = await import('../../../panel-server/services/managedContainer.ts')
  const { getActiveLifecycleOperation } = await import('../../../panel-server/services/lifecycleCoordinator.ts')
  const server = await getActiveServer()
  if (!server) fail('No active server configured', 404)
  const provider = resolveProvider(server)
  const processDetails = provider === 'docker-local' || provider === 'docker-managed'
    ? await resolveDockerHostSignal(server, runtimeValue.dockerClient)
    : await runtimeValue.serverManager.getServerProcessDetails()
  const rconService = runtimeValue.rconService
  return composeServerStatus({
    server,
    isRunning: Boolean(processDetails.running),
    scanFailed: Boolean(processDetails.scanFailed),
    dockerContainer: provider === 'docker-local' || provider === 'docker-managed'
      ? processDetails.scanFailed ? { handled: true, error: 'Docker container status unavailable' } : { handled: true, running: processDetails.running }
      : null,
    rcon: { ...rconService.getConfig(), connecting: Boolean(rconService.connecting || rconService.reconnecting) },
    bridge: { configured: Boolean(runtimeValue.panelBridge?.bridgePath), running: Boolean(runtimeValue.panelBridge?.isRunning), modConnected: Boolean(runtimeValue.panelBridge?.isModConnected?.()) },
    lifecycleOperation: getActiveLifecycleOperation(),
  })
}
