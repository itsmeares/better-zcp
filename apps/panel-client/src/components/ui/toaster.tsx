import { useToast } from "@/components/ui/use-toast"
import { BellRing, CheckCircle2, AlertTriangle, AlertCircle } from 'lucide-react'
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  const getToastIcon = (variant?: 'default' | 'destructive' | 'success' | 'warning' | null) => {
    if (variant === 'success') {
      return <CheckCircle2 className="h-4 w-4 text-primary" />
    }
    if (variant === 'destructive') {
      return <AlertTriangle className="h-4 w-4 text-destructive" />
    }
    if (variant === 'warning') {
      return <AlertCircle className="h-4 w-4 text-warning" />
    }
    return <BellRing className="h-4 w-4 text-muted-foreground" />
  }

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, variant, ...props }) {
        const iconBg = variant === 'success'
          ? 'border-primary/25 bg-primary/15 text-primary'
          : variant === 'destructive'
            ? 'border-destructive/25 bg-destructive/15 text-destructive'
            : variant === 'warning'
              ? 'border-warning/25 bg-warning/15 text-warning'
              : 'border-border/40 bg-muted text-muted-foreground'
        return (
          <Toast key={id} variant={variant} {...props}>
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${iconBg}`}>
                {getToastIcon(variant)}
              </div>
              <div className="grid gap-1">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}
