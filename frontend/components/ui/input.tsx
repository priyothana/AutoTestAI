import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Layout — unchanged
        "h-9 w-full min-w-0 px-3 py-1 text-sm",
        // Shape
        "rounded-[var(--radius-token-md)]",
        // Colors — CSS var tokens
        "[background:var(--color-bg-base)] [color:var(--color-text-primary)]",
        "[border:1px_solid_var(--color-border-sem)]",
        // Placeholder
        "placeholder:[color:var(--color-text-muted)]",
        // Focus — brand ring
        "outline-none transition-[border-color,box-shadow]",
        "focus-visible:[border-color:var(--color-brand)]",
        "focus-visible:[box-shadow:0_0_0_3px_rgba(107,107,255,0.15)]",
        // Disabled
        "disabled:cursor-not-allowed disabled:[background:var(--color-bg-overlay)] disabled:[color:var(--color-text-muted)] disabled:opacity-70",
        // File input
        "file:text-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium",
        // Validation
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:[border-color:var(--color-danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
