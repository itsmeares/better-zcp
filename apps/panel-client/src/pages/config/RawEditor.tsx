import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { copyText } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { toastManager } from '@/components/ui/toast'

/** The file as text, for anything the form can't edit. */
export function RawEditor({ value, onChange, label }: { value: string; onChange: (value: string) => void; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toastManager.add({ title: 'Could not copy', description: 'Your browser blocked clipboard access.', type: 'error' })
    }
  }
  return (
    <div className="relative">
      <Button size="icon-sm" variant="outline" className="absolute end-3 top-3 z-10" onClick={() => void copy()} aria-label="Copy the file">
        {copied ? <Check /> : <Copy />}
      </Button>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        aria-label={label}
        className="h-[calc(100dvh-22rem)] min-h-96 resize-y font-mono text-sm **:[textarea]:h-full"
      />
    </div>
  )
}
