import type { ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { apiUrl } from '@/lib/serverSelection'
import { cn, copyText } from '@/lib/utils'
import { notify, workshopUrl } from './modsShared'

/** The Workshop ID as a small chip that copies itself. */
export function WorkshopIdChip({ wsId }: { wsId: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        copyText(wsId)
          .then(() => notify('Copied', `Workshop ID ${wsId}`))
          .catch(() => {
            /* clipboard blocked */
          })
      }}
      className="inline-flex items-center gap-1 rounded-sm border px-1.5 py-px font-mono text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
      title="Copy the Workshop ID"
      aria-label={`Copy Workshop ID ${wsId}`}
    >
      {wsId}
    </button>
  )
}

export function WorkshopLink({ wsId, label }: { wsId: string; label: string }) {
  return (
    <a
      href={workshopUrl(wsId)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={`Open ${label} on the Steam Workshop`}
      title="Open on the Steam Workshop"
    >
      <ExternalLink className="size-4" />
    </a>
  )
}

/** The Workshop preview image, falling back to an icon when Steam has none. */
export function WorkshopThumb({ wsId, label, fallback, demo, size = 'md' }: { wsId: string; label: string; fallback: ReactNode; demo?: boolean; size?: 'sm' | 'md' }) {
  return (
    <a
      href={workshopUrl(wsId)}
      target="_blank"
      rel="noreferrer"
      className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-md border bg-muted text-muted-foreground', size === 'md' ? 'size-14' : 'size-10')}
      aria-label={`Open ${label} on the Steam Workshop`}
    >
      {fallback}
      <img
        src={demo ? `${import.meta.env.BASE_URL}spiffo.png` : apiUrl(`/mods/thumbnail/${wsId}`)}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
        onError={(event) => {
          event.currentTarget.style.display = 'none'
        }}
      />
    </a>
  )
}

/** One mod in a list: a leading control, the name with badges, a meta line, actions and an optional footer. */
export function ModRow({
  leading,
  title,
  badges,
  meta,
  actions,
  footer,
  selected = false,
  dimmed = false,
  onClick,
}: {
  leading?: ReactNode
  title: ReactNode
  badges?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  footer?: ReactNode
  selected?: boolean
  dimmed?: boolean
  onClick?: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={cn('group/row border-b last:border-b-0', onClick && 'cursor-pointer', selected ? 'bg-accent' : 'hover:bg-accent/50', dimmed && 'opacity-60')}
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 64px' }}
    >
      <div className="flex items-center gap-3 px-3 py-2.5">
        {leading != null && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            {title}
            {badges}
          </div>
          {meta != null && <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">{meta}</div>}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {footer != null && <div className="grid gap-1 px-3 pb-2.5 sm:ps-10">{footer}</div>}
    </div>
  )
}
