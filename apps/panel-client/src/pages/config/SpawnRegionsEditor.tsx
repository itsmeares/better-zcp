import { Plus, Trash2 } from 'lucide-react'
import type { SpawnRegion } from '@/lib/api'
import { EmptyState } from '@/components/EmptyState'
import { HelpTip } from '@/components/HelpTip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** The towns players can pick from when they first join. */
export function SpawnRegionsEditor({ regions, onChange }: { regions: SpawnRegion[]; onChange: (regions: SpawnRegion[]) => void }) {
  const update = (index: number, patch: Partial<SpawnRegion>) => onChange(regions.map((region, i) => (i === index ? { ...region, ...patch } : region)))

  return (
    <div className="grid gap-3">
      {regions.length === 0 ? (
        <EmptyState compact type="noData" title="No spawn regions" description="Add one below, or switch to Raw to read the file." />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <div className="hidden grid-cols-[2rem_minmax(10rem,16rem)_minmax(0,1fr)_2.25rem] gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid">
            <span>#</span>
            <span>Name players see</span>
            <span className="flex items-center gap-1">
              Map file
              <HelpTip label="Map file">
                Must match a file in the server's maps exactly, with no extension and the same capitals. A wrong path makes the game skip the region or fail to start.
              </HelpTip>
            </span>
            <span />
          </div>
          <ul className="divide-y">
            {regions.map((region, index) => (
              <li key={index} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[2rem_minmax(10rem,16rem)_minmax(0,1fr)_2.25rem] sm:items-center sm:gap-3">
                <span className="text-sm text-muted-foreground tabular-nums">{index + 1}</span>
                <Input value={region.name} onChange={(event) => update(index, { name: event.target.value })} placeholder="Muldraugh, KY" maxLength={64} aria-label={`Region ${index + 1} name`} />
                <div className="flex items-center gap-2">
                  <Input
                    value={region.file}
                    onChange={(event) => update(index, { file: event.target.value })}
                    placeholder={region.isServerFile ? 'ServerName_spawnpoints.lua' : 'media/maps/Muldraugh, KY/spawnpoints.lua'}
                    maxLength={512}
                    className="font-mono"
                    aria-label={`Region ${index + 1} file`}
                  />
                  {region.isServerFile && <Badge variant="secondary">Server file</Badge>}
                </div>
                <Button size="icon-sm" variant="ghost" onClick={() => onChange(regions.filter((_, i) => i !== index))} aria-label={`Remove ${region.name || `region ${index + 1}`}`}>
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Button variant="outline" size="sm" className="justify-self-end" onClick={() => onChange([...regions, { name: '', file: 'media/maps/' }])}>
        <Plus />
        Add region
      </Button>
    </div>
  )
}
