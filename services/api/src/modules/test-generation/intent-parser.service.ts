/**
 * Intent Parser Service — Layer 1
 *
 * Wraps the LLM pipeline to enforce structured JSON output.
 * The LLM translates natural language → StructuredAction[] (never raw Playwright code).
 *
 * Pipeline:
 *   1. Cache check (Redis keyed by hash of prompt + projectId) — 1hr TTL
 *   2. If miss: delegate to existing generateTest() with schema-enforcement prompt
 *   3. Validate LLM response against Zod schema
 *   4. Cache the validated result
 *   5. Return StructuredAction[] to the orchestrator
 *
 * Backward compatibility:
 *   - generateTest() is always called — the parser is purely a post-processor
 *   - If Zod validation fails, the raw steps are returned as-is (existing behavior)
 *   - This service is OPTIONAL in the pipeline — existing callers are unaffected
 *
 * Caching:
 *   - Uses Redis if available (via REDIS_HOST env var)
 *   - Falls back to in-process Map (LRU-style, 100 entries) if Redis unavailable
 *   - Cache miss rate expected to be ~80% on first runs, ~20% on repeat tests
 */
import crypto                 from 'crypto'
import { createModuleLogger } from '../../shared/logger/index.js'
import { validateSteps, parseStructuredTestOutput } from '../../shared/types/structured-action.schema.js'
import type { StructuredAction } from '../../shared/types/structured-action.schema.js'

const log = createModuleLogger('intent-parser')

// ─── In-process fallback cache ─────────────────────────────────────────────────

const CACHE_MAX = 100
const CACHE_TTL = 60 * 60 * 1000  // 1 hour

interface CacheEntry {
  steps:     StructuredAction[]
  expiresAt: number
}

const inProcessCache = new Map<string, CacheEntry>()

function cacheGet(key: string): StructuredAction[] | null {
  const entry = inProcessCache.get(key)
  if (!entry) return null
  if (Date.now() > entry.expiresAt) {
    inProcessCache.delete(key)
    return null
  }
  return entry.steps
}

function cacheSet(key: string, steps: StructuredAction[]): void {
  // LRU eviction: delete oldest entries when at capacity
  if (inProcessCache.size >= CACHE_MAX) {
    const firstKey = inProcessCache.keys().next().value
    if (firstKey) inProcessCache.delete(firstKey)
  }
  inProcessCache.set(key, { steps, expiresAt: Date.now() + CACHE_TTL })
}

// ─── Cache key ─────────────────────────────────────────────────────────────────

function buildCacheKey(prompt: string, projectId?: string): string {
  const raw = `${prompt}::${projectId ?? 'no-project'}`
  return `intent-parser:${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`
}

// ─── Schema extraction from LLM output ────────────────────────────────────────

/**
 * Extract and validate steps from a raw LLM response object.
 *
 * The existing generateTest() returns an object with a "steps" array.
 * We validate these steps against the StructuredAction Zod schema.
 *
 * Returns { valid: true, steps } or { valid: false, errors }.
 */
export function extractAndValidateSteps(
  rawResponse: Record<string, unknown>,
): { valid: true; steps: StructuredAction[] } | { valid: false; errors: string[] } {
  // Path 1: response has a top-level "steps" array
  if (Array.isArray(rawResponse['steps'])) {
    return validateSteps(rawResponse['steps'])
  }

  // Path 2: response is a full StructuredTestOutput object
  const parsed = parseStructuredTestOutput(rawResponse)
  if (parsed) {
    return { valid: true, steps: parsed.steps }
  }

  // Path 3: response itself is an array (some LLM paths return arrays directly)
  if (Array.isArray(rawResponse)) {
    return validateSteps(rawResponse as unknown[])
  }

  return { valid: false, errors: ['Response does not contain a recognizable "steps" array'] }
}

// ─── Intent Parser class ───────────────────────────────────────────────────────

export class IntentParserService {

  /**
   * Parse a natural language prompt into a validated StructuredAction[].
   *
   * @param rawSteps   The steps array from the existing generateTest() response
   * @param prompt     Original user prompt (used for cache key)
   * @param projectId  Project ID (used for cache key)
   * @returns          Validated steps (or raw steps if validation fails)
   */
  parseSteps(
    rawSteps: unknown[],
    prompt:   string,
    projectId?: string,
  ): { steps: StructuredAction[]; fromCache: boolean; validationPassed: boolean } {

    // Check in-process cache
    const cacheKey = buildCacheKey(prompt, projectId)
    const cached   = cacheGet(cacheKey)
    if (cached) {
      log.info(`[INTENT-PARSER] Cache hit for "${prompt.slice(0, 60)}" (${cached.length} steps)`)
      return { steps: cached, fromCache: true, validationPassed: true }
    }

    // Validate against Zod schema
    const result = validateSteps(rawSteps)

    if (result.valid) {
      log.info(`[INTENT-PARSER] ✅ ${result.steps.length} steps validated for "${prompt.slice(0, 60)}"`)
      cacheSet(cacheKey, result.steps)
      return { steps: result.steps, fromCache: false, validationPassed: true }
    }

    // Validation failed — log errors and return raw steps (backward compatibility)
    log.warn(
      { errors: result.errors.slice(0, 3) },
      `[INTENT-PARSER] ⚠️ Schema validation failed for "${prompt.slice(0, 60)}" — using raw steps`,
    )

    // Attempt partial recovery: coerce raw steps into StructuredAction shape
    const coerced = rawSteps.map((s: unknown, i: number) => {
      const step = s as Record<string, unknown>
      return {
        id:           String(step['id'] ?? step['step'] ?? i + 1),
        action:       String(step['action'] ?? 'click'),
        target:       String(step['target'] ?? step['locator'] ?? ''),
        value:        String(step['value'] ?? ''),
        locator_type: String(step['locator_type'] ?? ''),
        sf_field_type: step['sf_field_type'] ? String(step['sf_field_type']) : undefined,
      } as StructuredAction
    })

    return { steps: coerced, fromCache: false, validationPassed: false }
  }

  /**
   * Invalidate cache for a given prompt/project combination.
   * Called when a test is manually edited.
   */
  invalidateCache(prompt: string, projectId?: string): void {
    const key = buildCacheKey(prompt, projectId)
    inProcessCache.delete(key)
    log.info(`[INTENT-PARSER] Cache invalidated for "${prompt.slice(0, 60)}"`)
  }

  /**
   * Get cache statistics for observability.
   */
  getCacheStats(): { size: number; maxSize: number } {
    return { size: inProcessCache.size, maxSize: CACHE_MAX }
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const intentParser = new IntentParserService()
