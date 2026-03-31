/**
 * AutoTest AI — Centralised API Client
 *
 * Feature-flag driven backend switcher.
 *
 * NEXT_PUBLIC_BACKEND_VERSION unset (or anything ≠ "node") → Python :8000  (safe default)
 * NEXT_PUBLIC_BACKEND_VERSION=node                           → Node.js :4000
 *
 * All pages should import BASE_URL from here rather than reading
 * process.env.NEXT_PUBLIC_API_URL directly; doing so enables the
 * single flag to swap the entire backend with no further code changes.
 */

export const BASE_URL =
  process.env.NEXT_PUBLIC_BACKEND_VERSION === 'node'
    ? process.env.NEXT_PUBLIC_NODE_API_URL   ?? 'http://localhost:4000'
    : process.env.NEXT_PUBLIC_PYTHON_API_URL ?? 'http://localhost:8000'
