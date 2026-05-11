"use client"

import { useEffect, useState } from "react"

interface LogoProps {
  /** sm = sidebar/header (32px), md = login card (40px), lg = landing hero (56px) */
  size?: "sm" | "md" | "lg" | "xl"
  /** Show the wordmark next to the icon */
  showText?: boolean
  /** Additional className on the wrapper */
  className?: string
}

const sizeMap = {
  sm: { icon: 28, text: "text-lg", gap: "gap-2" },
  md: { icon: 36, text: "text-xl", gap: "gap-2.5" },
  lg: { icon: 48, text: "text-3xl", gap: "gap-3" },
  xl: { icon: 64, text: "text-5xl", gap: "gap-4" },
}

export default function Logo({ size = "md", showText = true, className = "" }: LogoProps) {
  // Stable gradient IDs — use size as a discriminator so multiple
  // Logo instances on the same page don't share SVG defs.
  // (Avoids useId() which produces different values on server vs client,
  // causing Next.js hydration mismatch errors.)
  const stableKey = size
  const s = sizeMap[size]
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const grad1 = `logo-grad-a-${stableKey}`
  const grad2 = `logo-grad-b-${stableKey}`
  const grad3 = `logo-grad-c-${stableKey}`
  const glowId = `logo-glow-${stableKey}`

  return (
    <span className={`inline-flex items-center ${s.gap} ${className}`}>
      {/* ── Animated Icon ── */}
      <span
        className="logo-icon-wrapper"
        style={{
          width: s.icon,
          height: s.icon,
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <svg
          viewBox="0 0 64 64"
          width={s.icon}
          height={s.icon}
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="AutoTest AI logo"
          style={{ overflow: "visible" }}
        >
          <defs>
            {/* Primary gradient — animated rotation */}
            <linearGradient id={grad1} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#7c3aed">
                {mounted && (
                  <animate attributeName="stop-color" values="#7c3aed;#3b82f6;#06b6d4;#7c3aed" dur="4s" repeatCount="indefinite" />
                )}
              </stop>
              <stop offset="50%" stopColor="#3b82f6">
                {mounted && (
                  <animate attributeName="stop-color" values="#3b82f6;#06b6d4;#7c3aed;#3b82f6" dur="4s" repeatCount="indefinite" />
                )}
              </stop>
              <stop offset="100%" stopColor="#06b6d4">
                {mounted && (
                  <animate attributeName="stop-color" values="#06b6d4;#7c3aed;#3b82f6;#06b6d4" dur="4s" repeatCount="indefinite" />
                )}
              </stop>
            </linearGradient>

            {/* Secondary accent gradient */}
            <linearGradient id={grad2} x1="0%" y1="100%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#a78bfa" />
              <stop offset="100%" stopColor="#38bdf8" />
            </linearGradient>

            {/* Glow filter */}
            <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>

            {/* Text fill gradient */}
            <linearGradient id={grad3} x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#7c3aed" />
              <stop offset="100%" stopColor="#3b82f6" />
            </linearGradient>
          </defs>

          {/* Outer ring — animated dash */}
          <circle
            cx="32"
            cy="32"
            r="29"
            stroke={`url(#${grad1})`}
            strokeWidth="2.2"
            strokeDasharray="12 6"
            fill="none"
            opacity="0.55"
          >
            {mounted && (
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 32 32"
                to="360 32 32"
                dur="18s"
                repeatCount="indefinite"
              />
            )}
          </circle>

          {/* Background circle with subtle glass fill */}
          <circle
            cx="32"
            cy="32"
            r="25"
            fill={`url(#${grad1})`}
            opacity="0.12"
          />

          {/* ── Flask / beaker shape — test tube abstraction ── */}
          <g filter={`url(#${glowId})`}>
            {/* Flask body */}
            <path
              d="M26 16 L26 30 L20 42 Q18 46 22 48 L42 48 Q46 46 44 42 L38 30 L38 16"
              stroke={`url(#${grad1})`}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            />

            {/* Flask top rim */}
            <path
              d="M23 16 L41 16"
              stroke={`url(#${grad2})`}
              strokeWidth="2.5"
              strokeLinecap="round"
            />

            {/* Liquid fill — animated level */}
            <path
              d="M22.5 42 L25 36 L39 36 L41.5 42 Q43 45 40 46 L24 46 Q21 45 22.5 42Z"
              fill={`url(#${grad1})`}
              opacity="0.35"
            >
              {mounted && (
                <animate
                  attributeName="opacity"
                  values="0.25;0.45;0.25"
                  dur="3s"
                  repeatCount="indefinite"
                />
              )}
            </path>

            {/* Bubbles — animated */}
            <circle cx="29" cy="40" r="1.8" fill={`url(#${grad2})`} opacity="0.7">
              {mounted && (
                <>
                  <animate attributeName="cy" values="40;33;28" dur="2.5s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.7;0.4;0" dur="2.5s" repeatCount="indefinite" />
                  <animate attributeName="r" values="1.8;1.2;0.6" dur="2.5s" repeatCount="indefinite" />
                </>
              )}
            </circle>
            <circle cx="34" cy="42" r="1.3" fill={`url(#${grad1})`} opacity="0.6">
              {mounted && (
                <>
                  <animate attributeName="cy" values="42;35;30" dur="3.2s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0.3;0" dur="3.2s" repeatCount="indefinite" />
                  <animate attributeName="r" values="1.3;0.9;0.3" dur="3.2s" repeatCount="indefinite" />
                </>
              )}
            </circle>
            <circle cx="31" cy="43" r="1" fill="#a78bfa" opacity="0.5">
              {mounted && (
                <>
                  <animate attributeName="cy" values="43;37;31" dur="2.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.5;0.25;0" dur="2.8s" repeatCount="indefinite" />
                </>
              )}
            </circle>
          </g>

          {/* ── AI sparkle accents ── */}
          {/* Sparkle top-right */}
          <g opacity="0.8">
            <path
              d="M48 14 L49.5 17 L53 18 L49.5 19 L48 22 L46.5 19 L43 18 L46.5 17Z"
              fill={`url(#${grad2})`}
            >
              {mounted && (
                <animate
                  attributeName="opacity"
                  values="0.5;1;0.5"
                  dur="2s"
                  repeatCount="indefinite"
                />
              )}
            </path>
          </g>
          {/* Sparkle bottom-left — smaller */}
          <g opacity="0.6">
            <path
              d="M14 44 L15 46 L17.5 47 L15 48 L14 50 L13 48 L10.5 47 L13 46Z"
              fill="#38bdf8"
            >
              {mounted && (
                <animate
                  attributeName="opacity"
                  values="0.3;0.8;0.3"
                  dur="2.6s"
                  repeatCount="indefinite"
                />
              )}
            </path>
          </g>

          {/* Center checkmark / AI tick inside flask */}
          <path
            d="M29 36 L31.5 38.5 L36 33"
            stroke={`url(#${grad1})`}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            opacity="0.85"
          >
            {mounted && (
              <animate
                attributeName="opacity"
                values="0.6;1;0.6"
                dur="2.5s"
                repeatCount="indefinite"
              />
            )}
          </path>
        </svg>
      </span>

      {/* ── Wordmark ── */}
      {showText && (
        <span className={`font-bold tracking-tight ${s.text}`} style={{ lineHeight: 1.1 }}>
          <span style={{ color: "var(--color-text-primary)" }}>Auto</span>
          <span style={{ color: "var(--color-text-primary)" }}>Test</span>{" "}
          <span
            className="logo-ai-text"
            style={{
              background: "linear-gradient(135deg, #7c3aed, #3b82f6, #06b6d4)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
              fontWeight: 900,
            }}
          >
            AI
          </span>
        </span>
      )}
    </span>
  )
}
