"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning'
}

function Badge({ className, variant = 'default', ...props }: BadgeProps) {
  const variants = {
    default: "border border-primary/20 bg-primary/12 text-primary",
    secondary: "border border-border/70 bg-secondary/70 text-secondary-foreground",
    destructive: "border border-destructive/25 bg-destructive/12 text-destructive",
    outline: "border border-input bg-transparent text-foreground",
    success: "border border-[hsl(var(--success)/0.28)] bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]",
    warning: "border border-[hsl(var(--warning)/0.72)] bg-[hsl(var(--warning))] text-[hsl(var(--warning-foreground))]"
  }

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        variants[variant],
        className
      )}
      data-badge-variant={variant}
      {...props}
    />
  )
}

export { Badge }
