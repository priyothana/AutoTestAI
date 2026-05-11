"use client"

import { useEffect, useState } from "react"

interface TestsIconProps {
  className?: string
  /** Whether this icon is for the currently active nav item */
  active?: boolean
  style?: React.CSSProperties
}

/**
 * Premium animated Tests navigation icon — a mini test-tube with
 * gradient fill, animated bubbles, and a small checkmark overlay.
 * Designed to match the AutoTest AI brand logo.
 */
export default function TestsIcon({ className = "h-4 w-4", active = false, style }: TestsIconProps) {
  // Stable gradient IDs — avoids useId() which causes hydration mismatch
  const grad = `tests-icon-grad-${active ? 'active' : 'idle'}`
  const grad2 = `tests-icon-grad2-${active ? 'active' : 'idle'}`
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      role="img"
      aria-label="Tests"
    >
      <defs>
        <linearGradient id={grad} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={active ? "#7c3aed" : "currentColor"}>
            {mounted && active && (
              <animate attributeName="stop-color" values="#7c3aed;#3b82f6;#7c3aed" dur="3s" repeatCount="indefinite" />
            )}
          </stop>
          <stop offset="100%" stopColor={active ? "#3b82f6" : "currentColor"}>
            {mounted && active && (
              <animate attributeName="stop-color" values="#3b82f6;#06b6d4;#3b82f6" dur="3s" repeatCount="indefinite" />
            )}
          </stop>
        </linearGradient>
        <linearGradient id={grad2} x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
      </defs>

      {/* Flask body */}
      <path
        d="M9 3L9 10L5 18Q4 20 6 21L18 21Q20 20 19 18L15 10L15 3"
        stroke={`url(#${grad})`}
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Flask rim */}
      <path
        d="M7.5 3L16.5 3"
        stroke={`url(#${grad})`}
        strokeWidth="1.7"
        strokeLinecap="round"
      />

      {/* Liquid fill */}
      <path
        d="M6.2 18L8 14L16 14L17.8 18Q18.5 19.5 17 20L7 20Q5.5 19.5 6.2 18Z"
        fill={active ? `url(#${grad})` : "currentColor"}
        opacity={active ? 0.25 : 0.12}
      >
        {mounted && active && (
          <animate attributeName="opacity" values="0.2;0.35;0.2" dur="2.5s" repeatCount="indefinite" />
        )}
      </path>

      {/* Bubble 1 */}
      {active && (
        <circle cx="10.5" cy="17" r="0.9" fill={`url(#${grad2})`} opacity="0.7">
          {mounted && (
            <>
              <animate attributeName="cy" values="17;13;10" dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.7;0.3;0" dur="2.2s" repeatCount="indefinite" />
              <animate attributeName="r" values="0.9;0.6;0.3" dur="2.2s" repeatCount="indefinite" />
            </>
          )}
        </circle>
      )}

      {/* Bubble 2 */}
      {active && (
        <circle cx="13" cy="18" r="0.7" fill={`url(#${grad})`} opacity="0.6">
          {mounted && (
            <>
              <animate attributeName="cy" values="18;14;11" dur="2.8s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.6;0.25;0" dur="2.8s" repeatCount="indefinite" />
              <animate attributeName="r" values="0.7;0.45;0.2" dur="2.8s" repeatCount="indefinite" />
            </>
          )}
        </circle>
      )}

      {/* Checkmark inside flask */}
      <path
        d="M10 16L11.5 17.5L14.5 14"
        stroke={active ? `url(#${grad})` : "currentColor"}
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        opacity={active ? 0.9 : 0.5}
      >
        {mounted && active && (
          <animate attributeName="opacity" values="0.7;1;0.7" dur="2s" repeatCount="indefinite" />
        )}
      </path>
    </svg>
  )
}
