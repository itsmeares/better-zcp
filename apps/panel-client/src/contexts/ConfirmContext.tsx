import { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

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

  const confirm = useCallback<ConfirmFn>((opts) => {
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
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title ?? 'Are you sure?'}</AlertDialogTitle>
            <AlertDialogDescription className="whitespace-pre-line">
              {options?.description}
            </AlertDialogDescription>
            {options?.items && options.items.length > 0 && (
              <ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto rounded-md border border-border/50 bg-muted/30 p-3 ps-7 text-sm text-muted-foreground">
                {options.items.map((item) => (
                  <li key={item} className="truncate">{item}</li>
                ))}
              </ul>
            )}
            {options?.requireTypedConfirmation && (
              <div className="space-y-1.5 pt-1 text-start">
                <Label htmlFor="confirm-dialog-typed-input" className="text-xs font-medium text-muted-foreground">
                  {options.requireTypedConfirmation.label}
                </Label>
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
            <AlertDialogCancel onClick={() => settle(false)}>
              {options?.cancelLabel ?? 'Cancel'}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => settle(true)}
              disabled={
                options?.requireTypedConfirmation !== undefined &&
                typedValue !== options.requireTypedConfirmation.value
              }
              className={cn(
                options?.variant === 'warning'
                  ? buttonVariants({ variant: 'warning' })
                  : options?.destructive !== false && buttonVariants({ variant: 'destructive' }),
                options?.requireTypedConfirmation && 'disabled:grayscale disabled:opacity-60',
              )}
            >
              {options?.confirmLabel ?? 'Confirm'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
