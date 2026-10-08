import React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { reportClientError } from '@/lib/client-errors'
import { getRecoveryUrl, rawErrorMessageIntentional } from '@/lib/errorMessage'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from '@/components/ui/card'

interface Props {
  children: React.ReactNode
  /** Set for one page. The rest of the panel keeps working around it. Unset, it covers the screen. */
  featureName?: string
}

export class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportClientError(`[${this.props.featureName ?? 'App'}] Error.`, { error, errorInfo })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { featureName } = this.props
    const recoveryUrl = getRecoveryUrl(error)
    const reset = () => this.setState({ error: null })

    const card = (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="size-5 text-destructive" />
            {featureName ? `${featureName} hit an error` : 'Something went wrong'}
          </CardTitle>
          <CardDescription>{featureName ? 'The rest of the panel still works. Try again, or go back to Overview.' : 'Reload the page. If it keeps happening, the details below help with a bug report.'}</CardDescription>
        </CardHeader>
        <CardPanel className="grid gap-4">
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Technical details</summary>
            <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{rawErrorMessageIntentional(error, String(error))}</pre>
          </details>
          <div className="flex flex-wrap gap-2">
            {featureName ? (
              <>
                <Button onClick={reset}>Try again</Button>
                <Button variant="ghost" render={<Link to="/" />}>
                  Overview
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => window.location.reload()}>Reload page</Button>
                <Button variant="outline" onClick={reset}>
                  Try again
                </Button>
              </>
            )}
            {recoveryUrl && (
              <Button variant="ghost" render={<a href={recoveryUrl} />}>
                Open the page that can fix this
              </Button>
            )}
          </div>
        </CardPanel>
      </Card>
    )
    return featureName ? card : <div className="flex min-h-screen items-center justify-center bg-background p-4">{card}</div>
  }
}
