"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          // Base tokens — popover-style fallback for neutral toasts
          "--normal-bg": "var(--color-bg-elevated)",
          "--normal-text": "var(--color-text-primary)",
          "--normal-border": "var(--color-border-sem)",
          // Success toast
          "--success-bg": "var(--color-success-light)",
          "--success-text": "var(--color-success)",
          "--success-border": "var(--color-success)",
          // Error toast
          "--error-bg": "var(--color-danger-light)",
          "--error-text": "var(--color-danger)",
          "--error-border": "var(--color-danger)",
          // Warning toast
          "--warning-bg": "var(--color-warning-light)",
          "--warning-text": "var(--color-warning)",
          "--warning-border": "var(--color-warning)",
          // Info toast
          "--info-bg": "var(--color-info-light)",
          "--info-text": "var(--color-info)",
          "--info-border": "var(--color-info)",
          // Shape
          "--border-radius": "var(--radius-token-md)",
          "--toast-shadow": "var(--shadow-md)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "toast-item",
          success: "toast-success",
          error: "toast-error",
          warning: "toast-warning",
          info: "toast-info",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
