import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Base: layout + shape — uses token radius, padding, font-size
  "inline-flex items-center justify-center w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden font-medium",
  {
    variants: {
      variant: {
        // Default → brand primary pill
        default:
          "[background:var(--color-brand)] text-white border-0 rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        // Secondary → neutral / draft / unknown
        secondary:
          "[background:var(--color-bg-overlay)] [color:var(--color-text-muted)] border-0 rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        // Destructive → danger / high / failed
        destructive:
          "[background:var(--color-danger-light)] [color:var(--color-danger)] [border:1px_solid_color-mix(in_srgb,var(--color-danger)_20%,transparent)] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        // Outline → neutral outline (kept for compat — styled as muted)
        outline:
          "[color:var(--color-text-secondary)] [border:1px_solid_var(--color-border-sem)] [background:transparent] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        // ── Semantic status variants ──
        success:
          "[background:var(--color-success-light)] [color:var(--color-success)] [border:1px_solid_color-mix(in_srgb,var(--color-success)_20%,transparent)] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        warning:
          "[background:var(--color-warning-light)] [color:var(--color-warning)] [border:1px_solid_color-mix(in_srgb,var(--color-warning)_20%,transparent)] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        info:
          "[background:var(--color-info-light)] [color:var(--color-info)] [border:1px_solid_color-mix(in_srgb,var(--color-info)_20%,transparent)] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs",
        running:
          "[background:var(--color-info-light)] [color:var(--color-info)] [border:1px_solid_color-mix(in_srgb,var(--color-info)_20%,transparent)] rounded-[var(--radius-token-sm)] px-2 py-0.5 text-xs animate-pulse",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span"

  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
