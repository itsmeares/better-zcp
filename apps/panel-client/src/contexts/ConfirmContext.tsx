import { createContext, useCallback, useContext, useMemo, useRef, useState, useEffect, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export interface ConfirmOptions {
  title?: string
  description: string
  items?: string[]
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
  variant?: 'warning'
  requireTypedConfirmation?: {
    value: string
    label: string
    placeholder?: string
  }
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null)
  const [open, setOpen] = useState(false)
  const [typedValue, setTypedValue] = useState('')
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  useEffect(() => () => { resolveRef.current?.(false); resolveRef.current = null }, [])

  const confirm = useCallback<ConfirmFn>((opts) => {
    resolveRef.current?.(false)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
      setOptions(opts)
      setTypedValue('')
      setOpen(true)
    })
  }, [])

  const settle = useCallback((value: boolean) => {
    setOpen(false)
    resolveRef.current?.(value)
    resolveRef.current = null
  }, [])

  const value = useMemo(() => confirm, [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <AlertDialog open={open} onOpenChange={(next) => { if (!next) settle(false) }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title ?? 'Are you sure?'}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">{options?.description}</AlertDialogDescription>
            {options?.items && options.items.length > 0 && (
              <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto rounded-lg border bg-muted p-3 ps-7 text-sm text-muted-foreground">
                {options.items.map((item) => (
                  <li key={item} className="truncate">{item}</li>
                ))}
              </ul>
            )}
            {options?.requireTypedConfirmation && (
              <div className="mt-3 grid gap-1.5 text-start">
                <Label htmlFor="confirm-dialog-typed-input">{options.requireTypedConfirmation.label}</Label>
                <Input
                  id="confirm-dialog-typed-input"
                  autoComplete="off"
                  autoFocus
                  value={typedValue}
                  onChange={(e) => setTypedValue(e.target.value)}
                  placeholder={options.requireTypedConfirmation.placeholder ?? options.requireTypedConfirmation.value}
                />
              </div>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />} onClick={() => settle(false)}>
              {options?.cancelLabel ?? 'Cancel'}
            </AlertDialogClose>
            <Button
              variant={options?.variant === 'warning' || options?.destructive === false ? 'default' : 'destructive'}
              onClick={() => settle(true)}
              disabled={options?.requireTypedConfirmation !== undefined && typedValue !== options.requireTypedConfirmation.value}
            >
              {options?.confirmLabel ?? 'Confirm'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
