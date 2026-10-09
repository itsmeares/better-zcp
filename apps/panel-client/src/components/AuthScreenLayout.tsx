import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { cn } from '@/lib/utils'
import { panelHealthQueryOptions } from '@/lib/panelHealth'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'

/** The frame around sign-in and first-run setup: brand, one card, and whether the panel answers. */
export function AuthScreenLayout({ title, description, children, footer }: { title: string; description: string; children: ReactNode; footer?: ReactNode }) {
  const { data, isPending, isError } = useQuery({ ...panelHealthQueryOptions(), refetchInterval: 15_000 })
  const status = isPending ? 'Checking the panel…' : isError ? "The panel isn't answering" : 'Panel online'

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-4 py-12 text-foreground">
      <div className="flex items-center gap-2.5 font-semibold">
        <img src={`${import.meta.env.BASE_URL}spiffo.png`} alt="" width={28} height={28} className="size-7 object-contain" />
        Better ZCP
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardPanel>{children}</CardPanel>
      </Card>
      {footer && <p className="max-w-sm text-center text-xs text-muted-foreground">{footer}</p>}
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className={cn('size-1.5 rounded-full', isPending ? 'bg-muted-foreground' : isError ? 'bg-destructive' : 'bg-success')} />
        {status}
        {data?.version && <span>· v{data.version}</span>}
      </p>
    </main>
  )
}
