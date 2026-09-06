import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Server, X, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { DiscoveredMount } from '@/lib/api'

const DISMISS_KEY_PREFIX = 'pz-mount-discovery-dismissed-'

function dismissKey(mount: DiscoveredMount): string {
  return DISMISS_KEY_PREFIX + mount.installPath
}

function isDismissed(mount: DiscoveredMount): boolean {
  try {
    return localStorage.getItem(dismissKey(mount)) === 'true'
  } catch {
    return false
  }
}

interface MountDiscoveryBannerProps {
  mount: DiscoveredMount
  onConnect: (mount: DiscoveredMount) => void
}

// Shown when the panel found PZ server files at a common bind-mount path
// but no server profile has been created for it yet — lets the user skip
// typing paths and RCON settings by hand. Dismissal is remembered per
// install path so re-scans don't keep re-surfacing a mount the user
// already declined.
export function MountDiscoveryBanner({ mount, onConnect }: MountDiscoveryBannerProps) {
  const { t } = useTranslation('mountDiscoveryBanner')
  const [dismissed, setDismissed] = useState(() => isDismissed(mount))

  if (dismissed) return null

  const dismiss = () => {
    try {
      localStorage.setItem(dismissKey(mount), 'true')
    } catch {
      /* ignore storage failures */
    }
    setDismissed(true)
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/10 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Server className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium">{t('pzInstall')}</span>
        <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={mount.installPath}>
          {mount.installPath}
        </code>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={dismiss} aria-label={t('dismissAria')} title={t('dismiss')}>
          <X className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => onConnect(mount)}>
          <Plus className="me-1.5 h-3.5 w-3.5" aria-hidden="true" /> {t('add')}
        </Button>
      </div>
    </div>
  )
}
