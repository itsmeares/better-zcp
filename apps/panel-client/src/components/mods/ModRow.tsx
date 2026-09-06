import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { copyText } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const workshopUrl = (wsId: string) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${wsId}`

/**
 * Copyable Workshop-ID chip. The bare number reads as noise, so it is always
 * prefixed with "WS" and doubles as a copy button.
 */
export function WorkshopIdChip({
  wsId,
  onCopied,
  className = '',
}: {
  wsId: string
  onCopied?: (wsId: string) => void
  className?: string
}) {
  const { t } = useTranslation('modRow')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            copyText(wsId).then(() => onCopied?.(wsId)).catch(() => { /* clipboard blocked — ignore */ })
          }}
          className={`inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50 ${className}`}
          aria-label={t('copyWorkshopIdAria', { id: wsId })}
        >
          <span className="text-[9px] font-semibold uppercase tracking-wider opacity-70">WS</span>
          <span>{wsId}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{t('copyWorkshopIdTooltip')}</TooltipContent>
    </Tooltip>
  )
}

/** "Open on Steam Workshop" action, sized to sit in a row's action cluster. */
export function WorkshopLinkAction({ wsId, label, hint }: { wsId: string; label: string; hint?: string }) {
  const { t } = useTranslation('modRow')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <a
          href={workshopUrl(wsId)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
          aria-label={t('openWorkshopPageForAria', { label })}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </TooltipTrigger>
      <TooltipContent>{hint || t('openWorkshopPageHint')}</TooltipContent>
    </Tooltip>
  )
}

/** Square thumbnail tile that links to the Workshop page. */
export function WorkshopThumb({
  wsId,
  label,
  tone,
  fallbackIcon,
  demo,
}: {
  wsId: string
  label: string
  tone: string
  fallbackIcon: ReactNode
  demo?: boolean
}) {
  const { t } = useTranslation('modRow')
  return (
    <a
      href={workshopUrl(wsId)}
      target="_blank"
      rel="noreferrer"
      className={`relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 ${tone}`}
      aria-label={t('openOnSteamAria', { label })}
      title={t('openWorkshopPageTitle')}
    >
      {fallbackIcon}
      <img
        src={demo ? `${import.meta.env.BASE_URL}spiffo.png` : `/api/mods/thumbnail/${wsId}`}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 h-full w-full rounded-md object-cover"
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    </a>
  )
}

export interface ModRowProps {
  /** Checkbox, status dot or thumbnail — whatever anchors the row. */
  leading?: ReactNode
  title: ReactNode
  /** Chips rendered inline after the title. */
  titleBadges?: ReactNode
  /** Second line: workshop ID chip, timestamps, state pills. */
  meta?: ReactNode
  /** Right-hand action cluster. */
  actions?: ReactNode
  /** Full-width area under the row — ID chips, warnings, missing deps. */
  footer?: ReactNode
  selected?: boolean
  /** Rendered at 60% opacity, for items the server is not loading. */
  dimmed?: boolean
  onClick?: () => void
  className?: string
}

/**
 * Shared row shell for both mod lists. "Installed" tracks Workshop items for
 * updates; "Active on server" reflects the server INI — different data, same
 * anatomy: leading slot, title + meta, action cluster, optional footer.
 */
export function ModRow({
  leading,
  title,
  titleBadges,
  meta,
  actions,
  footer,
  selected = false,
  dimmed = false,
  onClick,
  className = '',
}: ModRowProps) {
  return (
    <div
      onClick={onClick}
      className={`group/modrow perf-list-row motion-safe:transition-colors ${onClick ? 'cursor-pointer' : ''} ${
        selected ? 'bg-primary/[0.055] shadow-[inset_2px_0_0_hsl(var(--primary)/0.55)]' : 'hover:bg-accent/40'
      } ${dimmed ? 'opacity-60' : ''} ${className}`}
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:flex-nowrap sm:gap-3">
        {leading != null && <div className="shrink-0">{leading}</div>}
        <div className="min-w-0 flex-[1_1_calc(100%-2rem)] sm:flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            {title}
            {titleBadges}
          </div>
          {meta != null && (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">{meta}</div>
          )}
        </div>
        {actions != null && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
      </div>
      {footer != null && <div className="space-y-1 px-3 pb-2 sm:ps-8">{footer}</div>}
    </div>
  )
}
