import { useCallback, useEffect, useState } from 'react'
import { Copy, Loader2, Save } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { reportClientError } from '@/lib/client-errors'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { copyText } from '@/lib/utils'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { toastManager } from '@/components/ui/toast'

interface PanelPaths {
  dbPath: string
  logsPath: string
  dataDir: string
}

function PathValue({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 break-all font-mono text-sm">{value || 'Unavailable'}</code>
      {value && (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Copy ${label}`}
          onClick={async () => {
            const ok = await copyText(value)
            toastManager.add(ok ? { title: 'Copied', description: value, type: 'success' } : { title: "Couldn't copy", type: 'error' })
          }}
        >
          <Copy />
        </Button>
      )}
    </div>
  )
}

export function DataPathsSection() {
  const [paths, setPaths] = useState<PanelPaths | null>(null)
  const [editing, setEditing] = useState(false)
  const [dataDir, setDataDir] = useState('')
  const [logsDir, setLogsDir] = useState('')
  const [moveFiles, setMoveFiles] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/debug/system')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setPaths(await response.json())
    } catch (error) {
      reportClientError('Failed to fetch panel paths.', error)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const startEditing = () => {
    setDataDir(paths?.dataDir || '')
    setLogsDir(paths?.logsPath || '')
    setEditing(true)
  }

  const save = async () => {
    if (!dataDir && !logsDir) {
      toastManager.add({ title: 'Enter at least one folder', type: 'error' })
      return
    }
    setSaving(true)
    try {
      const response = await apiFetch('/debug/paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataDir: dataDir || undefined, logsDir: logsDir || undefined, moveFiles }),
      })
      const data = await response.json()
      if (!data.success) throw new Error(data.error || "The panel couldn't change its folders.")
      toastManager.add({ title: 'Folders changed', description: data.message, type: 'success' })
      setEditing(false)
      void load()
    } catch (error) {
      toastManager.add({ title: "Couldn't change the folders", description: getUserErrorMessage(error, "The panel couldn't change its folders."), type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsCard
      title="Panel data folders"
      description="Where the panel keeps its database and logs. Game server folders are set per server."
      action={
        !editing && (
          <Button size="sm" variant="outline" onClick={startEditing} disabled={!paths}>
            Change folders
          </Button>
        )
      }
    >
      {editing ? (
        <div className="grid gap-4 py-4">
          <Alert variant="warning">
            <AlertTitle>Restart required</AlertTitle>
            <AlertDescription>New folders take effect after the panel restarts.</AlertDescription>
          </Alert>
          <label className="grid gap-1.5 text-sm font-medium">
            Data folder (holds the database)
            <Input value={dataDir} onChange={(e) => setDataDir(e.target.value)} placeholder="/opt/panel/data" className="font-mono" maxLength={260} />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Logs folder
            <Input value={logsDir} onChange={(e) => setLogsDir(e.target.value)} placeholder="/opt/panel/logs" className="font-mono" maxLength={260} />
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={moveFiles} onCheckedChange={(checked) => setMoveFiles(checked === true)} />
            <span>
              <span className="font-medium">Copy existing files to the new folders</span>
              <span className="block text-muted-foreground">Leave this on unless the new folders already hold your data.</span>
            </span>
          </label>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              Save folders
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <SettingsRow label="Database">
            <PathValue label="database path" value={paths?.dbPath} />
          </SettingsRow>
          <SettingsRow label="Logs">
            <PathValue label="logs folder" value={paths?.logsPath} />
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  )
}
