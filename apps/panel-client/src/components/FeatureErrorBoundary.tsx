import React from 'react'
import { withTranslation, type WithTranslation } from 'react-i18next'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'
import { Button } from './ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card'
import { Link } from '@tanstack/react-router'
import { reportClientError } from '@/lib/client-errors'
import { getRecoveryUrl, rawErrorMessageIntentional } from '@/lib/errorMessage'


interface FeatureErrorBoundaryProps extends WithTranslation {
  children: React.ReactNode
  featureName?: string
  fallback?: React.ReactNode
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void
  compact?: boolean
}

interface FeatureErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

class FeatureErrorBoundaryBase extends React.Component<FeatureErrorBoundaryProps, FeatureErrorBoundaryState> {
  constructor(props: FeatureErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): FeatureErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    reportClientError(`[${this.props.featureName || 'Feature'}] Error.`, { error, errorInfo })
    this.props.onError?.(error, errorInfo)
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      const { t } = this.props
      const { featureName = t('defaultFeatureName'), compact = false } = this.props
      const recoveryUrl = this.state.error ? getRecoveryUrl(this.state.error) : null

      if (compact) {
        return (
          <div className="p-4 border border-destructive/50 bg-destructive/10 rounded-lg">
            <div className="flex items-center gap-2 text-destructive mb-2">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">{t('compactMessage', { featureName })}</span>
            </div>
            <Button size="sm" variant="outline" onClick={this.handleReset}>
              <RefreshCw className="w-3 h-3 me-1" />
              {t('retry')}
            </Button>
          </div>
        )
      }

      return (
        <Card className="border-destructive/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="w-5 h-5" />
              {t('titleSuffix', { featureName })}
            </CardTitle>
            <CardDescription>
              {t('description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {this.state.error && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  {t('showDetails')}
                </summary>
                <pre className="mt-2 p-3 bg-muted rounded-lg overflow-auto max-h-24 text-muted-foreground">
                  {rawErrorMessageIntentional(this.state.error, String(this.state.error))}
                </pre>
              </details>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={this.handleReset}>
                <RefreshCw className="w-4 h-4 me-2" />
                {t('tryAgain')}
              </Button>
              <Button variant="ghost" asChild>
                <Link to="/">
                  <Home className="w-4 h-4 me-2" />
                  {t('dashboard')}
                </Link>
              </Button>
              {recoveryUrl && (
                <Button variant="ghost" asChild>
                  <a href={recoveryUrl}>{t('openRecoveryPage')}</a>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )
    }

    return this.props.children
  }
}

export const FeatureErrorBoundary = withTranslation('featureErrorBoundary')(FeatureErrorBoundaryBase)
