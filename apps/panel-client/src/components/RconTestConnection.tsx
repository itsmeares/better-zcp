import { useState } from 'react'
import { CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { rconApi, type RconTestResult } from '@/lib/api'
import { getRecoveryUrl, getUserErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface RconTestConnectionProps {
  host: string
  port: number
  password: string
  className?: string
}

export function RconTestConnection({ host, port, password, className }: RconTestConnectionProps) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<RconTestResult | null>(null)
  const [recoveryUrl, setRecoveryUrl] = useState<string | null>(null)

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    setRecoveryUrl(null)
    try {
      setResult(await rconApi.testConnection(host, port, password))
    } catch (error) {
      setResult({ success: false, error: 'internal_error', detail: getUserErrorMessage(error, 'The test request failed.') })
      setRecoveryUrl(getRecoveryUrl(error))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={cn('grid justify-items-start gap-1.5', className)}>
      <Button type="button" variant="outline" size="sm" onClick={() => void runTest()} disabled={testing || !host.trim() || !port}>
        {testing && <Loader2 className="animate-spin" />}
        {testing ? 'Testing…' : 'Test connection'}
      </Button>
      {result && (
        <p role="status" aria-live="polite" className={cn('flex items-start gap-1.5 text-sm', result.success ? 'text-success-foreground' : 'text-destructive-foreground')}>
          {result.success ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
          {result.detail}
        </p>
      )}
      {result && !result.success && recoveryUrl && (
        <a href={recoveryUrl} className="text-sm underline underline-offset-4">
          Open connection settings
        </a>
      )}
    </div>
  )
}
