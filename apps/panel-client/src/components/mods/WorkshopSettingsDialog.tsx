import { Loader2 } from 'lucide-react'
import { getUserErrorMessage } from '@/lib/errorMessage'
import { useAppSettings } from '@/pages/settings/useAppSettings'
import { PasswordInput } from '@/components/PasswordInput'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { toastManager } from '@/components/ui/toast'

/** Workshop update checks, the Steam Web API key and the public collection ID. */
export function WorkshopSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { settings, update, save, discard, saving, isDirty, loading } = useAppSettings()
  const keyConfigured = settings.steamApiKey.startsWith('•')
  const interval = Number.parseInt(settings.modCheckInterval, 10)
  const intervalValid = Number.isInteger(interval) && interval >= 1 && interval <= 120

  const submit = async () => {
    try {
      await save()
      toastManager.add({ title: 'Workshop settings saved', type: 'success' })
      onOpenChange(false)
    } catch (error) {
      toastManager.add({ title: "Couldn't save Workshop settings", description: getUserErrorMessage(error, 'Try again.'), type: 'error' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) discard()
        onOpenChange(next)
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Workshop settings</DialogTitle>
          <DialogDescription>How the panel checks Steam Workshop for mod updates.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="grid gap-5">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Check for updates every</span>
            <span className="flex items-center gap-2">
              <Input
                className="w-24"
                type="number"
                inputMode="numeric"
                min={1}
                max={120}
                value={settings.modCheckInterval}
                onChange={(e) => update('modCheckInterval', e.target.value)}
                onWheel={(e) => e.currentTarget.blur()}
                aria-invalid={!intervalValid}
                disabled={loading}
              />
              <span className="text-muted-foreground">minutes, from 1 to 120</span>
            </span>
          </label>
          <div className="grid gap-1.5 text-sm">
            <span className="font-medium">Steam Web API key</span>
            <PasswordInput
              value={settings.steamApiKey}
              onChange={(value) => update('steamApiKey', value)}
              placeholder={keyConfigured ? 'Saved' : 'Paste your key'}
              label="Steam Web API key"
              maxLength={128}
            />
            <span className="text-muted-foreground">
              Used to look up Workshop mod details. Get one at{' '}
              <a className="underline underline-offset-4" href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener noreferrer">
                steamcommunity.com/dev/apikey
              </a>
              ; "localhost" works as the domain for personal use.
            </span>
          </div>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Public collection ID</span>
            <Input
              className="font-mono"
              value={settings.workshopCollectionId}
              onChange={(e) => update('workshopCollectionId', e.target.value.trim())}
              placeholder="3123456789"
              maxLength={20}
              disabled={loading}
            />
            <span className="text-muted-foreground">
              Compare this server with a public collection. Copy the digits after <code className="font-mono">?id=</code> in the collection's
              URL. The panel only reads the collection; it never changes Steam.
            </span>
          </label>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
          <Button onClick={() => void submit()} disabled={!isDirty || saving || !intervalValid}>
            {saving && <Loader2 className="animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}
