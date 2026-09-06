import { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  icon?: ReactNode
  actions?: ReactNode
  badge?: ReactNode
  eyebrow?: string
  tone?: 'ops' | 'world' | 'maintain' | 'config' | 'servers'
  displayFont?: boolean
}

export function PageHeader({ title, description, icon, actions, badge, eyebrow, tone = 'ops', displayFont = false }: PageHeaderProps) {
  return (
    <section className="page-header-shell rounded-lg border border-border/40 bg-card/40 px-4 py-3 sm:px-5 sm:py-4" data-tone={tone}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1 sm:flex-1">
          {eyebrow && <p className="page-eyebrow text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{eyebrow}</p>}
          <div className="flex items-center gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                {icon && <span className="page-title-icon text-primary shrink-0">{icon}</span>}
                <h1 className={`page-title text-xl font-semibold tracking-tight text-foreground sm:text-2xl${displayFont ? ' font-display' : ''}`}>{title}</h1>
                {badge}
              </div>
              {description && (
                <p className="page-description mt-0.5 max-w-3xl text-xs leading-5 text-muted-foreground sm:text-sm">{description}</p>
              )}
            </div>
          </div>
        </div>
        {actions && (
          <div className="flex min-w-0 flex-wrap items-center gap-2 self-start sm:max-w-[48%] sm:justify-end sm:self-auto">
            {actions}
          </div>
        )}
      </div>
    </section>
  )
}
