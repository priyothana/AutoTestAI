/**
 * Browser Pool Service — Layer 3 Resource Management
 *
 * Manages a pool of Playwright browser instances to eliminate per-execution
 * startup overhead (typical Chromium launch: 2–4 seconds).
 *
 * Pool model:
 *   - Each execution gets its OWN BrowserContext (isolated cookies/storage/sessions)
 *   - Browser instances are SHARED across executions (safe — contexts are isolated)
 *   - Interactive (headed) executions always get a dedicated, non-pooled browser
 *   - Pool falls back to direct chromium.launch() if pool is exhausted
 *
 * Isolation guarantees:
 *   - Separate storageState file per project (via saveSession/loadSession)
 *   - Separate context.tracing namespace per executionId
 *   - frameRegistry and sfFieldMapRegistry are keyed by executionId in the worker
 *
 * Compatibility with existing code:
 *   - `acquire()` returns { browser, context, page } matching existing variable names
 *   - `release(executionId)` replaces the existing browserContext.close() + browser.close()
 *   - Session state (storageState) is still written via browserContext.storageState()
 *     — unchanged from the existing saveSession() function
 */
import { chromium, Browser, BrowserContext, Page, LaunchOptions } from '@playwright/test'
import { createModuleLogger } from '../logger/index.js'

const log = createModuleLogger('browser-pool')

// ─── Pool configuration ───────────────────────────────────────────────────────

const MAX_BROWSERS       = parseInt(process.env.BROWSER_POOL_MAX_BROWSERS ?? '3', 10)
const MAX_CONTEXTS_PER   = parseInt(process.env.BROWSER_POOL_MAX_CONTEXTS  ?? '3', 10)
const IDLE_TIMEOUT_MS    = parseInt(process.env.BROWSER_POOL_IDLE_MS       ?? '300000', 10)  // 5 min

// ─── Types ────────────────────────────────────────────────────────────────────

interface PooledBrowser {
  browser:    Browser
  contexts:   Set<string>   // executionIds using this browser
  createdAt:  number
  lastUsedAt: number
  headless:   boolean
}

interface PooledContext {
  context:    BrowserContext
  browserId:  string
  createdAt:  number
}

export interface AcquireResult {
  browser:    Browser
  context:    BrowserContext
  page:       Page
  fromPool:   boolean
}

// ─── Pool class ───────────────────────────────────────────────────────────────

export class BrowserPool {
  private browsers  = new Map<string, PooledBrowser>()
  private contexts  = new Map<string, PooledContext>()
  private idleTimer: ReturnType<typeof setInterval> | null = null

  constructor() {
    // Start idle cleanup timer
    this.idleTimer = setInterval(() => this.cleanupIdle(), 60_000)
  }

  /**
   * Acquire a browser + context + page for an execution.
   *
   * Interactive executions (headed) always get a fresh, dedicated browser.
   * Headless executions reuse existing warm browsers where possible.
   *
   * @param executionId  Unique ID for the execution (used as registry key)
   * @param options      Playwright launch options
   * @param headless     Whether the browser should be headless
   * @param storageState Path to session state file (loaded into the context)
   * @param tracePath    Directory for Playwright tracing
   */
  async acquire(
    executionId:   string,
    options:       Omit<LaunchOptions, 'headless'>,
    headless:      boolean,
    storageState?: string,
    tracePath?:    string,
  ): Promise<AcquireResult> {

    // Interactive mode: always fresh browser (headed, cannot share)
    if (!headless) {
      log.info(`[POOL] Interactive mode — launching dedicated browser for ${executionId}`)
      return this.launchFresh(executionId, { ...options, headless: false }, storageState, tracePath)
    }

    // Try to find an existing headless browser with capacity
    const existingBrowser = this.findAvailableBrowser(headless)
    if (existingBrowser) {
      return this.attachToExisting(executionId, existingBrowser, storageState, tracePath)
    }

    // Pool has capacity for a new browser
    if (this.browsers.size < MAX_BROWSERS) {
      log.info(`[POOL] Launching new pooled browser (pool size: ${this.browsers.size}/${MAX_BROWSERS})`)
      return this.launchAndPool(executionId, { ...options, headless: true }, storageState, tracePath)
    }

    // Pool exhausted — launch a transient browser (not added to pool)
    log.warn(`[POOL] Pool exhausted (${this.browsers.size}/${MAX_BROWSERS}) — launching transient browser`)
    return this.launchFresh(executionId, { ...options, headless: true }, storageState, tracePath)
  }

  /**
   * Release all resources for an execution.
   * Closes the BrowserContext but keeps the Browser alive if pooled.
   */
  async release(executionId: string): Promise<void> {
    const pooledCtx = this.contexts.get(executionId)
    if (!pooledCtx) {
      log.warn(`[POOL] release() called for unknown executionId: ${executionId}`)
      return
    }

    // Close the context (releases cookies, storage, frames)
    try {
      await pooledCtx.context.close()
    } catch (err) {
      log.warn({ err }, `[POOL] Error closing context for ${executionId} (non-fatal)`)
    }

    this.contexts.delete(executionId)

    // Update the parent browser's context count
    const pooledBrowser = this.browsers.get(pooledCtx.browserId)
    if (pooledBrowser) {
      pooledBrowser.contexts.delete(executionId)
      pooledBrowser.lastUsedAt = Date.now()
    }

    log.info(`[POOL] Released context for ${executionId}`)
  }

  /**
   * Close all browsers and clean up the pool.
   * Called on worker shutdown.
   */
  async releaseAll(): Promise<void> {
    log.info(`[POOL] Releasing all ${this.browsers.size} browsers`)
    if (this.idleTimer) clearInterval(this.idleTimer)

    for (const [id, pb] of this.browsers) {
      try {
        await pb.browser.close()
        log.info(`[POOL] Closed browser ${id}`)
      } catch (err) {
        log.warn({ err }, `[POOL] Error closing browser ${id} (non-fatal)`)
      }
    }

    this.browsers.clear()
    this.contexts.clear()
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private findAvailableBrowser(headless: boolean): [string, PooledBrowser] | null {
    for (const [id, pb] of this.browsers) {
      if (pb.headless === headless && pb.contexts.size < MAX_CONTEXTS_PER && pb.browser.isConnected()) {
        return [id, pb]
      }
    }
    return null
  }

  private async attachToExisting(
    executionId:   string,
    [browserId, pb]: [string, PooledBrowser],
    storageState?: string,
    tracePath?:    string,
  ): Promise<AcquireResult> {
    const context = await this.createContext(pb.browser, storageState, tracePath)
    const page    = await context.newPage()
    pb.contexts.add(executionId)
    pb.lastUsedAt = Date.now()
    this.contexts.set(executionId, { context, browserId, createdAt: Date.now() })
    log.info(`[POOL] ♻️ Reusing browser ${browserId.slice(0, 8)} for ${executionId}`)
    return { browser: pb.browser, context, page, fromPool: true }
  }

  private async launchAndPool(
    executionId:   string,
    options:       LaunchOptions,
    storageState?: string,
    tracePath?:    string,
  ): Promise<AcquireResult> {
    const browser  = await chromium.launch(options)
    const browserId = `pool-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const context  = await this.createContext(browser, storageState, tracePath)
    const page     = await context.newPage()

    this.browsers.set(browserId, {
      browser,
      contexts:   new Set([executionId]),
      createdAt:  Date.now(),
      lastUsedAt: Date.now(),
      headless:   options.headless !== false,
    })
    this.contexts.set(executionId, { context, browserId, createdAt: Date.now() })

    log.info(`[POOL] 🚀 Launched and pooled browser ${browserId.slice(0, 8)} for ${executionId}`)
    return { browser, context, page, fromPool: true }
  }

  private async launchFresh(
    executionId:   string,
    options:       LaunchOptions,
    storageState?: string,
    tracePath?:    string,
  ): Promise<AcquireResult> {
    const browser  = await chromium.launch(options)
    const browserId = `transient-${Date.now()}`
    const context  = await this.createContext(browser, storageState, tracePath)
    const page     = await context.newPage()

    // Transient browsers are tracked so release() can still close them
    this.browsers.set(browserId, {
      browser,
      contexts:   new Set([executionId]),
      createdAt:  Date.now(),
      lastUsedAt: Date.now(),
      headless:   options.headless !== false,
    })
    this.contexts.set(executionId, { context, browserId, createdAt: Date.now() })

    log.info(`[POOL] 🆕 Launched fresh (non-pooled) browser for ${executionId}`)
    return { browser, context, page, fromPool: false }
  }

  private async createContext(
    browser:       Browser,
    storageState?: string,
    tracePath?:    string,
  ): Promise<BrowserContext> {
    const context = await browser.newContext({
      viewport:          { width: 1280, height: 800 },
      deviceScaleFactor: 1,   // Prevent Retina/HiDPI 2× zoom on macOS
      ignoreHTTPSErrors: true, // Bypass SSL errors (e.g. ERR_SSL_PROTOCOL_ERROR, self-signed certs)
      ...(storageState ? { storageState } : {}),
    })

    await context.addInitScript('window.__name = (fn) => fn;');

    if (tracePath) {
      await context.tracing.start({ screenshots: true, snapshots: true }).catch(() => {})
    }

    return context
  }

  /** Remove idle browsers from the pool */
  private async cleanupIdle(): Promise<void> {
    const now = Date.now()
    for (const [id, pb] of this.browsers) {
      if (pb.contexts.size === 0 && (now - pb.lastUsedAt) > IDLE_TIMEOUT_MS) {
        log.info(`[POOL] Removing idle browser ${id.slice(0, 8)} (idle ${Math.round((now - pb.lastUsedAt) / 60000)}m)`)
        try { await pb.browser.close() } catch { /* ignore */ }
        this.browsers.delete(id)
      }
    }
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const browserPool = new BrowserPool()
