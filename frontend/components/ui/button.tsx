import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // Base: layout + a11y classes — no color here
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive active:scale-[0.98]",
  {
    variants: {
      variant: {
        // Primary — brand purple
        default:
          "[background:var(--color-brand)] text-white border-0 hover:[background:var(--color-brand-hover)] focus-visible:[box-shadow:0_0_0_3px_rgba(107,107,255,0.3)]",
        // Danger — uses danger tokens
        destructive:
          "[background:var(--color-danger-light)] [color:var(--color-danger)] [border:1px_solid_var(--color-danger)] hover:[background:var(--color-danger)] hover:text-white focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        // Secondary — outline style (was "outline" variant)
        outline:
          "bg-transparent [color:var(--color-text-primary)] [border:1px_solid_var(--color-border-sem)] hover:[background:var(--color-bg-overlay)] hover:[border-color:var(--color-border-hover)]",
        // Secondary filled (was "secondary" variant)
        secondary:
          "bg-transparent [color:var(--color-text-primary)] [border:1px_solid_var(--color-border-sem)] hover:[background:var(--color-bg-overlay)] hover:[border-color:var(--color-border-hover)]",
        // Ghost — transparent, no border
        ghost:
          "bg-transparent [color:var(--color-text-secondary)] border-0 hover:[background:var(--color-bg-overlay)] hover:[color:var(--color-text-primary)]",
        // Link — text only
        link: "[color:var(--color-brand)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 rounded-[var(--radius-token-md)] has-[>svg]:px-3",
        sm: "h-8 rounded-[var(--radius-token-md)] gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-[var(--radius-token-md)] px-6 has-[>svg]:px-4",
        icon: "size-9 rounded-[var(--radius-token-md)]",
        "icon-sm": "size-8 rounded-[var(--radius-token-md)]",
        "icon-lg": "size-10 rounded-[var(--radius-token-md)]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
