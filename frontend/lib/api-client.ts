/**
 * AutoTest AI — Centralised API Client
 *
 * All pages should import BASE_URL from here rather than reading
 * process.env.NEXT_PUBLIC_API_URL directly, so a single env change
 * swaps the backend across the entire frontend.
 *
 * Default: http://localhost:4000  (Node.js backend)
 */

export const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'
