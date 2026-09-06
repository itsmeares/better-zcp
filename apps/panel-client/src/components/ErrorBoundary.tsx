import React from 'react'
import { withTranslation, type WithTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './ui/card'
import { reportClientError } from '@/lib/client-errors'
import { getRecoveryUrl, rawErrorMessageIntentional } from '@/lib/errorMessage'

interface Props extends WithTranslation {
  children: React.ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

// Class component -- useTranslation() is a hook and doesn't work here.
// withTranslation() HOC injects `t` as a prop instead (see FeatureErrorBoundary.tsx
// for the same pattern, deliberately kept identical between the two boundaries).
class ErrorBoundaryBase extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportClientError('ErrorBoundary caught an error.', { error, errorInfo })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const { t } = this.props
      // getRecoveryUrl() rarely resolves here -- most caught crashes are a
      // render-logic bug (a null property access, a bad prop), not an
      // ApiError with a code, so this is usually null. Worth attempting
      // anyway: an occasional crash IS caused by an already-failed request
      // whose error object propagated into render, and this is the one
      // place a matching case (RCON, PanelBridge, EACCES...) can offer a
      // concrete next step instead of just "refresh the page."
      const recoveryUrl = this.state.error ? getRecoveryUrl(this.state.error) : null
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
          <Card className="max-w-md w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="w-6 h-6" />
                {t('title')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-muted-foreground">
                {t('description')}
              </p>
              {this.state.error && (
                // Collapsed by default -- the raw message is genuinely
                // useful for diagnosis (reportClientError above already
                // sent it off for that), but showing it prominently and
                // untranslated as the primary text is the opposite of what
                // a non-technical operator needs at the exact moment
                // something has already gone wrong.
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    {t('showDetails')}
                  </summary>
                  {/* rawErrorMessageIntentional(), not a direct .message
                      access -- this IS the named, deliberate "keep the raw
                      text for diagnosis" site the escape hatch exists for,
                      not an oversight the lint rule should catch. */}
                  <pre className="mt-2 p-3 bg-muted rounded-lg overflow-auto max-h-32">
                    {rawErrorMessageIntentional(this.state.error, String(this.state.error))}
                  </pre>
                </details>
              )}
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => window.location.reload()}>
                  <RefreshCw className="w-4 h-4 me-2" />
                  {t('refreshPage')}
                </Button>
                <Button variant="outline" onClick={this.handleReset}>
                  {t('tryAgain')}
                </Button>
                {recoveryUrl && (
                  // A plain <a>, not react-router's <Link> -- this is the
                  // app's own top-level crash boundary, so a full page
                  // navigation that doesn't lean on the current (just-
                  // crashed) React tree's routing state is the safer choice
                  // here, even though Router context happens to be present.
                  <Button variant="outline" asChild>
                    <a href={recoveryUrl}>{t('openRecoveryPage')}</a>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}

export const ErrorBoundary = withTranslation('errorBoundary')(ErrorBoundaryBase)
