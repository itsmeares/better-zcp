import { Copy } from 'lucide-react'
import { copyText } from '@/lib/utils'
import { toastManager } from '@/components/ui/toast'

export function CopyPath({ label, value }: { label: string; value: string }) {
  const copy = async () => {
    const ok = await copyText(value)
    toastManager.add(ok ? { title: `${label} copied`, description: value, type: 'success' } : { title: "Couldn't copy", description: 'The browser blocked clipboard access.', type: 'error' })
  }
  return (
    <button type="button" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`} className="group inline-flex max-w-full items-start gap-1.5 text-start">
      <code className="font-mono text-xs leading-5 break-all group-hover:text-foreground">{value}</code>
      <Copy className="mt-1 size-3 shrink-0 text-muted-foreground group-hover:text-foreground" />
    </button>
  )
}
