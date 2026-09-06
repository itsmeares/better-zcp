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
  /** Plain text or a list of items to render as a bullet list under the description. */
  description: string
  /** Extra items to render as a bulleted list (e.g. the specific files/mods about to be deleted). */
  items?: string[]
  confirmLabel?: string
  cancelLabel?: string
  /** Renders the confirm button in the destructive (red) style. Defaults to true since this
   *  is primarily used to replace native confirm() calls guarding delete/destructive actions. */
  destructive?: boolean
  /** Renders the confirm button in the warning (amber) style instead of destructive-red or
   *  plain. For the "affects others but reversible" tier -- an action that's fully undoable
   *  (a server restart, a shared setting re-added later) but can disrupt or reach someone
   *  other than the admin clicking. Full red overstates it; no styling at all understates it.
   *  Takes precedence over `destructive` when set. */
  variant?: 'warning'
  /** When set, the Confirm button stays disabled until the admin types this
   *  exact value into an input rendered in the dialog. Optional and defaulted
   *  off -- every existing call site is unaffected. For the rare action where
   *  a click alone is too cheap a barrier: permanent, other-person harm with
   *  no undo (e.g. killPlayer, guarded by typing the target's username). This
   *  is the one typed-confirmation mechanism in the app; do not build a
   *  second dialog that means the same thing -- extend this instead. */
  requireTypedConfirmation?: {
    /** The exact string the admin must type, e.g. the target player's username. */
    value: string
    /** Label rendered above the input, e.g. "Type PlayerName to confirm". */
    label: string
    /** Placeholder text in the input. Defaults to the required value. */
    placeholder?: string
  }
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(async () => false)

/**
 * App-wide replacement for window.confirm(). Renders the app's themed
 * AlertDialog instead of the native, unstyled browser confirm (which breaks
 * the visual language mid-flow, blocks the main thread, can't show rich
 * context, and behaves inconsistently in embedded/kiosk webviews).
 *
 * Usage: const confirm = useConfirm(); if (!(await confirm({ description: '...' }))) return
 */
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
                // The Button component's normal disabled treatment
                // (destructive/35 background, /70 text) reads fine for a
                // button disabled by some OFF-SCREEN precondition the admin
                // isn't staring at. It is not enough here: this button
                // starts disabled while the admin is actively looking at it
                // and typing, so "barely dimmer red" was easy to mistake for
                // "already clickable" (caught by eye against the real
                // rendered dialog, killplayer-ui-2026-08-30). grayscale
                // strips the color signal entirely while typedValue doesn't
                // match, which is a much harder state to misread as armed.
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
