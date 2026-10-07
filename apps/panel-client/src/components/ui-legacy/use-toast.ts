import type { ReactElement, ReactNode } from "react"
import { toastManager } from "@/components/ui/toast"

// Bridge for pages not rebuilt yet: the old toast() call shape, shown through
// the coss toast manager. Deleted with ui-legacy once every page calls
// toastManager directly.

type LegacyVariant = "default" | "destructive" | "success" | "warning" | null

interface LegacyToast {
  title?: ReactNode
  description?: ReactNode
  variant?: LegacyVariant
  action?: ReactElement
  duration?: number
}

const TYPES = { destructive: "error", success: "success", warning: "warning" } as const

function toast({ title, description, variant, action, duration }: LegacyToast) {
  const actionProps = action?.props as { children?: ReactNode; onClick?: () => void } | undefined
  toastManager.add({
    title,
    description,
    type: variant && variant !== "default" ? TYPES[variant] : undefined,
    timeout: duration ?? (variant === "destructive" ? 15000 : undefined),
    actionProps: actionProps ? { children: actionProps.children, onClick: actionProps.onClick } : undefined,
  })
}

function useToast() {
  return { toast }
}

export { useToast, toast }
