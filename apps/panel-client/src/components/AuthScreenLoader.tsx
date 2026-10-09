import { Spinner } from '@/components/ui/spinner'

export function AuthScreenLoader() {
  return (
    <div role="status" aria-label="Loading" className="flex min-h-dvh items-center justify-center bg-background text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  )
}
