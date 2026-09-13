import { useEffect, useState } from 'react'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { Loader2, AlertCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { HelpTip } from '@/components/HelpTip'
import {
  serversApi,
  type DiscoveredMount,
  type ServerInstance,
} from '@/lib/api'

interface DiscoverySetupProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mount: DiscoveredMount | null
  onCreated?: (server: ServerInstance) => void
}

export function DiscoverySetup({
  open,
  onOpenChange,
  mount,
  onCreated,
}: DiscoverySetupProps) {
  const [selectedName, setSelectedName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    if (!open || !mount) return
    setCreateError(null)
    const firstName = mount.serverNames[0] || ''
    setSelectedName(firstName)
    setDisplayName(firstName)
  }, [open, mount])

  const selectServer = (name: string) => {
    setSelectedName(name)
    setDisplayName(name)
  }

  const handleCreate = async () => {
    if (!mount || !selectedName) return
    setCreating(true)
    setCreateError(null)
    try {
      const result = await serversApi.createFromDiscovery({
        installPath: mount.installPath,
        dataPath: mount.dataPath || '',
        serverName: selectedName,
        name: displayName || undefined,
      })
      const server = result.server
      await serversApi.activate(server.id)
      onCreated?.(server)
      toast({ title: 'Server added' })
      onOpenChange(false)
    } catch (error) {
      setCreateError(getUserErrorMessage(error, 'Failed to create server'))
    } finally {
      setCreating(false)
    }
  }

  if (!mount) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{'Add discovered server'}</DialogTitle>
          <DialogDescription className="sr-only">
            {'Create a server profile from a discovered mount.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <dl className="grid gap-2 text-xs">
            <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted-foreground">{'Install'}</dt>
              <dd className="truncate font-mono" title={mount.installPath}>
                {mount.installPath}
              </dd>
            </div>
            {mount.dataPath && (
              <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{'Data'}</dt>
                <dd className="truncate font-mono" title={mount.dataPath}>
                  {mount.dataPath}
                </dd>
              </div>
            )}
          </dl>

          {mount.serverNames.length > 1 && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Label>{'Configuration'}</Label>
                <HelpTip label={'Configuration'}>
                  {
                    'This install folder has more than one server config (.ini) file. Pick the one whose settings — name, RCON port, mods — you want the panel to use. You can add the others later from Server Setup.'
                  }
                </HelpTip>
              </div>
              <Select value={selectedName} onValueChange={selectServer}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {mount.serverNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}.ini
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label>{'Display name'}</Label>
              <HelpTip label={'Display name'}>
                {
                  "Just a label shown in this panel's server list. It does not rename any files or change the server's actual name in-game."
                }
              </HelpTip>
            </div>
            <Input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={100}
            />
          </div>

          {createError && (
            <div
              role="alert"
              className="flex items-center gap-2 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{createError}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {'Cancel'}
          </Button>
          <Button onClick={handleCreate} disabled={creating || !selectedName}>
            {creating && (
              <Loader2
                className="me-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            {'Add server'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
