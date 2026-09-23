import { Link } from '@tanstack/react-router'

export function NotFoundRoute() {
  return (
    <div className="space-y-6 page-transition">
      <div className="rounded-xl border border-border/70 bg-card/70 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Page Not Found</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The route you requested does not exist or is no longer available in this panel build.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link to="/" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Go to Dashboard
          </Link>
          <Link to="/servers" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-background px-4 text-sm font-medium hover:bg-muted/50">
            Open Servers
          </Link>
        </div>
      </div>
    </div>
  )
}
