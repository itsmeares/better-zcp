import { Skeleton } from '@/components/ui/skeleton'

/** Placeholder while a page's code or first data loads. */
export function PageLoading() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading">
      <Skeleton className="h-8 w-56" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-72 rounded-2xl" />
    </div>
  )
}
