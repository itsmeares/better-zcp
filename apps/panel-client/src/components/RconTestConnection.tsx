import { useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { rconApi, type RconTestResult } from '@/lib/api'
import { cn } from '@/lib/utils'
import { getRecoveryUrl, getUserErrorMessage } from '@/lib/errorMessage'

interface RconTestConnectionProps {
  host: string
  port: number
  password: string
  className?: string
}

// Lets a user verify RCON host/port/password before saving — distinguishes
// "can't reach the host at all" from "reached it but the password is wrong",
// which a bare connect failure can't tell apart.
export function RconTestConnection({ host, port, password, className }: RconTestConnectionProps) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RconTestResult | null>(null)
  const [recoveryUrl, setRecoveryUrl] = useState<string | null>(null)

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    setRecoveryUrl(null)
    try {
      const outcome = await rconApi.testConnection(host, port, password)
      setResult(outcome)
    } catch (error) {
      const detail = getUserErrorMessage(error, 'Test request failed')
      setResult({ success: false, error: 'internal_error', detail })
      setRecoveryUrl(getRecoveryUrl(error))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={runTest}
        disabled={testing || !host.trim() || !port}
      >
        {testing ? (
          <><Loader2 className="w-3.5 h-3.5 me-1.5 animate-spin" /> Testing...</>
        ) : (
          'Test Connection'
        )}
      </Button>
      {result && (
        <div className="space-y-1">
          <p
            role="status"
            aria-live="polite"
            className={cn(
              'flex items-start gap-1.5 text-xs',
              result.success ? 'text-muted-foreground' : 'text-destructive',
            )}
          >
            {result.success ? (
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            ) : (
              <XCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            )}
            {result.detail}
          </p>
          {!result.success && recoveryUrl && (
            <Link to={recoveryUrl} className="text-xs text-primary hover:underline">
              Open connection settings
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
