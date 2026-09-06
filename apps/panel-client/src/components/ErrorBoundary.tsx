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
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                    {t('showDetails')}
                  </summary>
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
