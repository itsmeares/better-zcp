import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,box-shadow,transform] duration-200 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 motion-safe:active:translate-y-px",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/92 disabled:bg-primary/40 disabled:text-primary-foreground/70 disabled:shadow-none",
        command:
          "bg-[hsl(var(--primary))] text-primary-foreground border border-primary/45 shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_8px_20px_-12px_hsl(var(--primary)/0.8)] hover:bg-[hsl(var(--primary)/0.9)] hover:shadow-[0_0_0_1px_hsl(var(--primary)/0.35),0_12px_28px_-14px_hsl(var(--primary)/0.9)] disabled:bg-primary/35 disabled:text-primary-foreground/70 disabled:shadow-none",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 disabled:bg-muted/30 disabled:text-muted-foreground disabled:shadow-none",
        outline:
          "border border-input bg-background hover:bg-accent/80 hover:text-accent-foreground disabled:border-border/60 disabled:bg-muted/30 disabled:text-muted-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/85 disabled:bg-secondary/70 disabled:text-muted-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground disabled:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        success: "bg-success text-success-foreground shadow-sm hover:bg-success/90 disabled:bg-muted/30 disabled:text-muted-foreground disabled:shadow-none",
        warning: "bg-warning text-warning-foreground shadow-sm hover:bg-warning/90 disabled:bg-muted/30 disabled:text-muted-foreground disabled:shadow-none",
      },
      size: {
        default: "h-11 px-4 py-2 sm:h-9",
        sm: "h-11 rounded-md px-3 text-xs sm:h-8",
        lg: "h-10 rounded-md px-8",
        icon: "h-11 w-11 sm:h-9 sm:w-9",
        iconDense: "h-11 w-11 sm:h-8 sm:w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        data-slot="button"
        data-variant={variant ?? "default"}
        data-size={size ?? "default"}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

// eslint-disable-next-line react-refresh/only-export-components -- buttonVariants is a shared style utility, not a component
export { Button, buttonVariants }
