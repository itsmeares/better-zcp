import { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Sliders, FileCog, Package } from 'lucide-react'
import { SimTemplateDiff, SimTemplateModRef } from '@/lib/api'
import { getIniKeyLabel, getSandboxKeyLabel, formatDiffValue } from '@/lib/templateLabels'

interface DiffRow {
  label: string
  sub?: string
  from: unknown
  to: unknown
}

function DiffRows({ rows, emptyText }: { rows: DiffRow[]; emptyText: string }) {
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyText}</p>
  }
  return (
    <ul className="divide-y divide-border/50 rounded-md border border-border/50">
      {rows.map((row) => (
        <li key={`${row.sub || ''}${row.label}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground">{row.label}</p>
            {row.sub && <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">{row.sub}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-muted-foreground line-through">{formatDiffValue(row.from)}</span>
            <span className="text-muted-foreground">&rarr;</span>
            <span className="font-semibold text-primary">{formatDiffValue(row.to)}</span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function Section({ icon: Icon, title, children }: { icon: typeof Sliders; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </h4>
      {children}
    </div>
  )
}

interface TemplateDiffListProps {
  diff: SimTemplateDiff
  mods: SimTemplateModRef[]
}

export function TemplateDiffList({ diff, mods }: TemplateDiffListProps) {
  const { t } = useTranslation('templateDiffList')
  const sandboxRows: DiffRow[] = diff.sandboxVars.map((c) => ({
    label: getSandboxKeyLabel(c.key, c.section),
    sub: c.section,
    from: c.from,
    to: c.to,
  }))
  const iniRows: DiffRow[] = diff.serverIni.map((c) => ({
    label: getIniKeyLabel(c.key),
    from: c.from,
    to: c.to,
  }))

  return (
    <div className="space-y-4">
      <Section icon={Sliders} title={t('sandboxChanges')}>
        <DiffRows rows={sandboxRows} emptyText={t('noSandboxChanges')} />
      </Section>
      <Section icon={FileCog} title={t('serverIniChanges')}>
        <DiffRows rows={iniRows} emptyText={t('noIniChanges')} />
      </Section>
      <Section icon={Package} title={t('mods')}>
        {mods.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noModsReferenced')}</p>
        ) : (
          <>
            <ul className="rounded-md border border-border/50 divide-y divide-border/50">
              {mods.map((m) => (
                <li key={m.workshopId} className="px-3 py-2 text-sm">
                  {m.name || m.modId || m.workshopId}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              {t('modsNotInstalledAutomatically')}
            </p>
          </>
        )}
      </Section>
    </div>
  )
}
