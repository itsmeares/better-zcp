import '@tanstack/react-start/server-only'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import {
  streamUploadToFile,
  UPLOAD_BAD_SIGNATURE_CODE,
  UPLOAD_TOO_LARGE_CODE,
} from '../../../panel-server/utils/uploadStream.ts'
import { confineToRoots } from '../../../panel-server/utils/browseRoots.ts'
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

async function allowedBrowseRoots(): Promise<string[]> {
  const { getActiveServer, getAllSettings } = await import('../../../panel-server/database/init.ts')
  const activeServer = await getActiveServer()
  const settings = await getAllSettings()
  return [...new Set([
    activeServer?.serverConfigPath,
    activeServer?.zomboidDataPath,
    activeServer?.serverPath,
    settings.serverConfigPath,
    settings.zomboidDataPath,
    path.join(os.homedir(), 'Zomboid'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).map((value) => path.resolve(value)))]
}

export async function previewServerImage(data: AnyRecord): Promise<Response> {
  const filePath = typeof data.path === 'string' ? data.path : ''
  if (!filePath) fail('Path is required', 400, ErrorCode.IMAGE_PREVIEW_PATH_REQUIRED)
  const resolved = confineToRoots(filePath, await allowedBrowseRoots())
  if (!resolved) fail('Access denied: path is outside allowed server directories', 403, ErrorCode.BROWSE_ACCESS_DENIED)
  if (!fs.existsSync(resolved)) fail('File not found', 404, ErrorCode.FILE_NOT_FOUND)
  const ext = path.extname(resolved).toLowerCase()
  const contentType: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  }
  if (!contentType[ext]) fail('Not an image file', 400, ErrorCode.IMAGE_PREVIEW_NOT_IMAGE)
  const stats = await fs.promises.stat(resolved)
  if (stats.size > 5 * 1024 * 1024) fail('Image file exceeds 5MB limit', 400, ErrorCode.IMAGE_PREVIEW_TOO_LARGE)
  return new Response(Readable.toWeb(fs.createReadStream(resolved)) as BodyInit, {
    headers: { 'Content-Type': contentType[ext], 'Cache-Control': 'private, max-age=60', 'Content-Length': String(stats.size) },
  })
}

export async function listServerDirectory(data: AnyRecord): Promise<AnyRecord> {
  const requested = typeof data.dirPath === 'string' ? data.dirPath.trim() : ''
  if (!requested) return { entries: [{ name: '/', path: '/', label: '/', isDrive: true }], currentPath: null, parentPath: null }
  if (!path.isAbsolute(requested) || requested.includes('..')) fail('Invalid path', 400, ErrorCode.INVALID_PATH)
  const currentPath = path.normalize(requested)
  if (!fs.existsSync(currentPath)) fail('Path does not exist', 404, ErrorCode.PATH_NOT_FOUND)
  if (!(await fs.promises.stat(currentPath)).isDirectory()) fail('Path is not a directory', 400, ErrorCode.PATH_NOT_A_DIRECTORY)
  const entries = (await fs.promises.readdir(currentPath, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== '$RECYCLE.BIN' && entry.name !== 'System Volume Information')
    .map((entry) => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  const parentPath = path.dirname(currentPath)
  return { entries, currentPath, parentPath: parentPath === currentPath ? null : parentPath }
}

export async function browseServerFolder(data: AnyRecord): Promise<Response | AnyRecord> {
  const description = data.description === undefined ? 'Select a folder' : data.description
  if (typeof description !== 'string' || description.length > 100 || !/^[a-zA-Z0-9 _.\-:()]+$/.test(description)) fail('Invalid description parameter', 400, ErrorCode.BROWSE_FOLDER_INVALID_DESCRIPTION)
  const initialPath = typeof data.initialPath === 'string' && data.initialPath ? data.initialPath : ''
  const { exec } = await import('node:child_process')
  if (process.platform === 'win32') return { success: false, path: initialPath || null, cancelled: true, message: 'Folder selection is not available in the server route on Windows.' }
  const safeDescription = description.replace(/'/g, "'\\''")
  const safePath = initialPath && path.isAbsolute(initialPath) && !initialPath.includes('..') ? initialPath.replace(/'/g, "'\\''") : ''
  const command = `zenity --file-selection --directory --title='${safeDescription}'${safePath ? ` --filename='${safePath}/'` : ''}`
  return new Promise((resolve) => {
    exec(command, { timeout: 120000 }, (error, stdout) => {
      if (!error && stdout.trim()) resolve({ success: true, path: stdout.trim(), cancelled: false })
      else resolve({ success: false, path: null, cancelled: true })
    })
  })
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
