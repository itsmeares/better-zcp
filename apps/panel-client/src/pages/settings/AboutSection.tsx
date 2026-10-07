import { ExternalLink } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { panelHealthQueryOptions } from '@/lib/panelHealth'
import { SettingsCard, SettingsRow } from '@/components/settings-layout'
import { Button } from '@/components/ui/button'

const LINKS = [
  { label: 'GitHub repository', href: 'https://github.com/itsmeares/better-zcp' },
  { label: 'Releases and changelog', href: 'https://github.com/itsmeares/better-zcp/releases' },
  { label: 'Report an issue', href: 'https://github.com/itsmeares/better-zcp/issues' },
  { label: 'Discord', href: 'https://discord.gg/jHsWJDNmSg' },
]

export function AboutSection() {
  const { data: health } = useQuery(panelHealthQueryOptions())
  return (
    <SettingsCard title="Better ZCP" description="A web panel for running Project Zomboid dedicated servers.">
      <SettingsRow label="Version">
        <span className="font-mono text-sm">v{health?.version || '—'}</span>
      </SettingsRow>
      <SettingsRow label="License">
        <a className="text-sm underline underline-offset-4" href="https://github.com/itsmeares/better-zcp/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
          AGPL-3.0-only
        </a>
      </SettingsRow>
      <div className="flex flex-wrap gap-2 py-4">
        {LINKS.map((link) => (
          <Button key={link.href} variant="outline" size="sm" render={<a href={link.href} target="_blank" rel="noopener noreferrer" />}>
            <ExternalLink />
            {link.label}
          </Button>
        ))}
      </div>
    </SettingsCard>
  )
}
