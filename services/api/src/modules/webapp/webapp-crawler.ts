/**
 * Web App Crawler / Metadata Service
 *
 * Hybrid extraction pipeline:
 * 1. Discover pages using `sitemap.xml` (default & fastest).
 * 2. Fallback or extend using a smart Playwright UI Crawler.
 *
 * Incremental / paginated crawl:
 * - Each run processes at most `perRunLimit` pages (default 50).
 * - Newly discovered links are added to `pendingUrls` in the CrawlState.
 * - The worker auto-re-enqueues a new BullMQ job if pendingUrls remain.
 * - Self-healing: pages with thin metadata (< THIN_METADATA_THRESHOLD
 *   interactive elements) are re-queued for re-crawl.
 *
 * Stores results in `metadata_raw_store` (metadata_type='webpage')
 */

import { createModuleLogger } from '../../shared/logger/index.js'
import type { CrawlState } from '../../shared/queue/job-types.js'

const log = createModuleLogger('webapp-crawler')

/** Pages with fewer than this many interactive elements are considered "thin" */
const THIN_METADATA_THRESHOLD = 3

// ─── Data Structures ──────────────────────────────────────────────────────────

export interface ElementInfo {
  role: string
  name: string
  tag: string
  locator_type: string
  locator: string
  required: boolean
  /** Valid option labels for <select> / combobox elements */
  options?: string[]
}

/** A field extracted from inside a Shadow DOM component */
export interface ShadowDomField {
  label: string
  tag: string
  type: string
  placeholder: string
  ariaLabel: string
  name: string
  id: string
  required: boolean
  isSelect: boolean
  options: string[]
}

/** A navigation menu item extracted from <nav> / sidebar / [role="navigation"] */
export interface NavItemInfo {
  text:       string
  role:       'link' | 'menuitem' | 'button' | 'tab' | 'treeitem' | 'unknown'
  href?:      string
  ariaLabel?: string
  /** Ready-to-use Playwright locator string — e.g. "role=link, name=Users" */
  locator:    string
}

export interface PageMetadata {
  url: string
  path: string
  title: string
  headings: string[]
  buttons: ElementInfo[]
  links: ElementInfo[]
  inputs: ElementInfo[]
  selects: ElementInfo[]
  testids: string[]
  /** Navigation menu items extracted from <nav>/sidebar containers */
  navigation_items: NavItemInfo[]
  source?: 'sitemap' | 'playwright' | 'modal' | 'popup'
  crawl_depth?: number
  /** True if this page was detected as a login redirect and the actual content could not be crawled */
  redirected_to_login?: boolean
  /** For modal pages: the button label that triggered this dialog (e.g. "Create Booking") */
  modal_trigger_button?: string
  /** For modal pages: the URL of the parent page where the button was clicked */
  modal_parent_url?: string
  /** Explicit boolean flag: true for dialog/drawer/popup synthetic pages */
  is_modal?: boolean
  /** Nesting depth: 0=regular page, 1=first-level dialog, 2=nested dialog */
  modal_depth?: number
  /** For drawer/side-panel pages: the button label that opened the drawer */
  drawer_trigger_button?: string
}

export interface WebAppCrawlResult {
  base_url: string
  pages: PageMetadata[]
  stats?: {
    sitemap_discovered: number
    playwright_crawled: number
  }
  // ── Incremental state ─────────────────────────────────────────────
  /** Updated crawl state after this run — persist to DB */
  crawlState: CrawlState
  /** True if there are still pendingUrls after this run */
  hasMorePages: boolean
  /** Human-readable progress message for the UI */
  progressMessage: string
}

/**
 * Per-project stabilization tuning for slow-rendering SPAs.
 * All timeouts are in milliseconds. Defaults are chosen for
 * moderate SPAs (Vue/React with async data fetches).
 */
export interface StabilizationConfig {
  /** Max time to wait for networkidle (default 15000) */
  networkIdleTimeout?: number
  /** Max time to wait for any interactive element to appear (default 10000) */
  firstElementTimeout?: number
  /** Min number of buttons/interactive elements to wait for (default 5) */
  minButtonThreshold?: number
  /** Max time to wait for minButtonThreshold elements (default 8000) */
  buttonThresholdTimeout?: number
  /** Final micro-settle after all stages (default 800) */
  microSettleMs?: number
  /** Hard per-page timeout — abort stabilization if exceeded (default 15000) */
  hardPageTimeout?: number
}

/** Sensible defaults — works for 95%+ of SPAs */
const DEFAULT_STABILIZATION: Required<StabilizationConfig> = {
  networkIdleTimeout:      15_000,
  firstElementTimeout:     10_000,
  minButtonThreshold:      5,
  buttonThresholdTimeout:  8_000,
  microSettleMs:           800,
  hardPageTimeout:         15_000,
}

export interface CrawlOptions {
  /** Max pages per single BullMQ run (default 50) */
  maxPages?: number
  /** Alias for maxPages — per-run page limit */
  perRunLimit?: number
  authSessionPath?: string
  credentials?: { username: string; password: string }
  sitemapUrl?: string
  keyRoutes?: string[]
  enableDeepCrawl?: boolean
  /**
   * Login strategy for the app:
   *   'form'       — standard HTML form login (default)
   *   'basic_auth' — HTTP Basic Authentication (sends credentials via browser context httpCredentials)
   *   'keycloak'   — Keycloak SSO (token injected into sessionStorage)
   */
  loginStrategy?: string
  /**
   * Restored CrawlState from DB — passed on continuation runs.
   * If undefined, this is the first run and state is seeded fresh.
   */
  initialState?: CrawlState
  /**
   * Per-project stabilization config for slow-rendering SPAs.
   * Merged with DEFAULT_STABILIZATION — only override what you need.
   */
  stabilizationConfig?: StabilizationConfig
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(url: string, baseUrl: string): string | null {
  try {
    const baseParsed = new URL(baseUrl)
    const parsed = new URL(url, baseUrl)

    if (parsed.origin !== baseParsed.origin) return null
    if (!['http:', 'https:'].includes(parsed.protocol)) return null

    // Strip accessibility-only hash anchors that are NOT real SPA routes.
    // e.g. #main-content, #content, #skip-nav — these are skip-links that
    // double the page count without adding any new content.
    // Keep SPA routes like #/leads, #/accounts (hash-router pattern).
    const rawHash = parsed.hash  // e.g. '#main-content' or '#/leads'
    const isAccessibilityAnchor = /^#(main-content|content|skip|skip-nav|skip-to|top|page-top)$/i.test(rawHash)
    const hash = isAccessibilityAnchor ? '' : rawHash

    return parsed.origin + parsed.pathname + hash
  } catch {
    return null
  }
}

/**
 * Derive route slugs from navigation item text labels.
 * Used as a fallback for SPAs where nav buttons have single-word text
 * (no multi-line description) — e.g. a sidebar item "Leads" → /leads.
 * Skips generic words, short strings, numbers, and record IDs.
 */
function deriveRoutesFromNavItems(
  navItems: Array<{ text?: string; href?: string }>,
  baseUrl: string,
): string[] {
  const SKIP_WORDS = new Set([
    'home', 'back', 'next', 'cancel', 'close', 'ok', 'yes', 'no',
    'save', 'submit', 'delete', 'edit', 'add', 'new', 'create',
    'search', 'filter', 'export', 'import', 'upload', 'download',
    'logout', 'login', 'profile', 'help', 'more',
    'menu', 'user', 'users',
    // Note: 'dashboard', 'overview', 'admin' intentionally NOT skipped—they are valid CRM module routes
  ])

  const candidates: string[] = []

  for (const item of navItems) {
    // If the nav item already has a real href with a path/hash, use that directly
    if (item.href && item.href.length > 0) {
      const norm = normalizeUrl(item.href, baseUrl)
      if (norm && norm !== normalizeUrl(baseUrl, baseUrl)) {
        candidates.push(norm)
        continue
      }
    }

    // Fall back: derive a slug from the label text
    const rawText = (item.text ?? '').trim().split('\n')[0].trim()
    if (!rawText || rawText.length < 3 || rawText.length > 30) continue
    if (/\d/.test(rawText)) continue                      // skip record IDs
    if (/^[A-Z]{2,5}[-\s]?\d/.test(rawText)) continue    // skip codes like ENQ-001
    if (rawText.split(/\s+/).length > 3) continue         // skip long phrases

    const slug = rawText.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-')
    if (!slug || slug.length < 3 || SKIP_WORDS.has(slug)) continue

    const candidateUrl = normalizeUrl(`/${slug}`, baseUrl)
    if (candidateUrl) candidates.push(candidateUrl)
  }

  return [...new Set(candidates)]
}

/**
 * Deep-route expansion: for a successfully crawled module list page (e.g. /leads),
 * generate create-form and detail-page variants to be queued for crawling.
 *
 * Produces:
 *   - /{module}/create  and  /{module}/new   (create form routes)
 *   - /{module}/{uuid}  (one representative detail page, scanned from page links)
 *
 * Only fires for simple one-segment paths that look like CRM entity lists.
 * Skips detail pages themselves (two-segment paths) to avoid infinite expansion.
 */
function deriveDetailRoutes(
  pageMeta: { url: string; links: Array<{ locator?: string }> },
  baseUrl: string,
): string[] {
  const candidates: string[] = []

  try {
    const urlPath = new URL(pageMeta.url).pathname
    const segments = urlPath.split('/').filter(Boolean)

    // Only expand top-level module paths like /leads, /accounts (one segment)
    if (segments.length !== 1) return []

    const module = segments[0]

    // Skip if the segment looks like a UUID, numeric ID, or generic word
    if (/^[0-9a-f-]{8,}$/i.test(module)) return []
    if (/^\d+$/.test(module)) return []
    if (['login', 'logout', 'auth', 'callback', 'home', 'index', 'organization'].includes(module)) return []

    // ── Create / New routes ──────────────────────────────────────────────────
    for (const suffix of ['create', 'new']) {
      const u = normalizeUrl(`/${module}/${suffix}`, baseUrl)
      if (u) candidates.push(u)
    }

    // ── Detail page: scan links for one representative /{module}/{uuid} URL ──
    const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const NUM_ID_RE = /^\d{1,15}$/

    for (const link of pageMeta.links) {
      if (!link.locator?.startsWith('http')) continue
      try {
        const parsed = new URL(link.locator)
        const lSegs  = parsed.pathname.split('/').filter(Boolean)
        if (lSegs.length === 2 && lSegs[0] === module) {
          const id = lSegs[1]
          if (UUID_RE.test(id) || NUM_ID_RE.test(id)) {
            candidates.push(link.locator)  // one representative detail page per entity
            break
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return [...new Set(candidates)]
}



/**
 * Derive navigable route paths from button labels on a crawled page.
 * Only matches buttons that look like SPA sidebar navigation items:
 * - Must have a multi-line format: "Label\nDescription" (the description confirms it's a nav item)
 * - Must NOT be generic action buttons, record IDs, or user profile labels
 *
 * Example match:   "Enquiries\nManage freight enquiries" → /enquiries
 * Example reject:  "Add Item", "Create Opportunity", "AGS2", "ENQ-0002"
 */
function deriveRoutesFromButtons(buttons: ElementInfo[], baseUrl: string): string[] {

  const candidates: string[] = []

  for (const btn of buttons) {
    const rawName = (btn.name ?? '').trim()
    if (!rawName) continue

    const lines = rawName.split('\n').map(l => l.trim()).filter(Boolean)

    // STRICT: require at least 2 lines — nav items always have a label + description
    // (e.g. "Enquiries\n\nManage freight enquiries")
    if (lines.length < 2) continue

    const firstLine = lines[0]
    const description = lines.slice(1).join(' ').toLowerCase()

    // Description must contain navigation verbs to confirm this is a nav menu item
    const NAV_DESCRIPTION_KEYWORDS = [
      'manage', 'view', 'create', 'track', 'handle', 'monitor',
      'browse', 'list', 'access', 'process', 'submit',
    ]
    const hasNavDescription = NAV_DESCRIPTION_KEYWORDS.some(k => description.includes(k))
    if (!hasNavDescription) continue

    // First line must be a reasonable module name (3-25 chars, no numbers or special chars)
    if (firstLine.length < 3 || firstLine.length > 25) continue
    // Skip labels with record-ID patterns: "ENQ-0002", "AGS2", "DTA1"
    if (/^[A-Z]{2,5}[-\s]?\d/.test(firstLine)) continue
    // Skip labels with numbers (like user shorthand "AGS2", "DTA1")
    if (/\d/.test(firstLine)) continue
    // Must be a single clean word or two words ("Account Management" OK, "Back to List" not)
    const wordCount = firstLine.split(/\s+/).length
    if (wordCount > 3) continue

    const slug = firstLine
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')

    if (slug && slug.length >= 3 && slug.length <= 25) {
      const candidateUrl = normalizeUrl(`/${slug}`, baseUrl)
      if (candidateUrl) candidates.push(candidateUrl)
    }
  }

  return [...new Set(candidates)]
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

export class WebMetadataService {
  
  /**
   * Fetch and parse an XML sitemap into a list of URLs.
   * Recursively handles sitemap index files up to depth 2.
   */
  static async detectAndFetchSitemap(
    baseUrl: string,
    customSitemapUrl?: string,
    depth = 0,
    credentials?: { username: string; password: string },
  ): Promise<string[]> {
    if (depth > 2) return []

    const targetUrl = customSitemapUrl || baseUrl.replace(/\/$/, '') + '/sitemap.xml'
    log.info(`[CRAWLER] Checking sitemap at ${targetUrl} (depth ${depth})`)

    const headers: Record<string, string> = {}
    if (credentials) {
      // Include Basic Auth header so password-protected sitemaps are accessible
      headers['Authorization'] = 'Basic ' +
        Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
    }

    try {
      const response = await fetch(targetUrl, { signal: AbortSignal.timeout(10000), headers })
      if (!response.ok) return []

      const xmlText = await response.text()
      const locRegex = /<loc>(.*?)<\/loc>/g
      const matches = [...xmlText.matchAll(locRegex)]
      
      const results: string[] = []
      
      for (const match of matches) {
        const loc = match[1].trim()
        if (loc.endsWith('.xml') && depth < 2) {
          // It's a sitemap index
          const childUrls = await WebMetadataService.detectAndFetchSitemap(baseUrl, loc, depth + 1, credentials)
          results.push(...childUrls)
        } else {
          const norm = normalizeUrl(loc, baseUrl)
          if (norm && !results.includes(norm)) {
            results.push(norm)
          }
        }
      }
      return results
    } catch (err) {
      log.debug({ err, targetUrl }, '[CRAWLER] Sitemap fetch failed')
      return []
    }
  }

  /**
   * Incremental crawl: processes at most `perRunLimit` pages from the queue.
   *
   * First run:  seeds pendingUrls from sitemap + base URL + keyRoutes.
   * Continuation: restores pendingUrls/visitedUrls from `options.initialState`.
   *
   * Returns the crawled pages for THIS run plus updated CrawlState for persistence.
   */
  static async crawl(baseUrl: string, options: CrawlOptions = {}): Promise<WebAppCrawlResult> {
    const {
      maxPages,
      perRunLimit,
      authSessionPath,
      credentials,
      sitemapUrl,
      keyRoutes = [],
      enableDeepCrawl = false,
      loginStrategy = 'form',
      initialState,
      stabilizationConfig,
    } = options

    const isBasicAuth = loginStrategy === 'basic_auth'
    const runLimit = perRunLimit ?? maxPages ?? 50

    // ── Restore or initialise crawl state ───────────────────────────────────
    let visitedUrls: Set<string>
    let pendingUrls: string[]
    let runCount: number

    const isContinuation = !!initialState

    if (isContinuation && initialState) {
      visitedUrls  = new Set(initialState.visitedUrls)
      pendingUrls  = [...initialState.pendingUrls]
      runCount     = initialState.runCount
      log.info(
        `[CRAWLER] Continuation run #${runCount + 1} — ` +
        `${visitedUrls.size} visited, ${pendingUrls.length} pending`
      )
    } else {
      visitedUrls = new Set<string>()
      pendingUrls = []
      runCount    = 0
      log.info('[CRAWLER] First run — seeding from sitemap + base URL')

      // 1. Sitemap discovery (with credentials for protected sitemaps)
      const sitemapUrls = await WebMetadataService.detectAndFetchSitemap(baseUrl, sitemapUrl, 0, credentials)
      if (sitemapUrls.length > 0) {
        log.info(`[CRAWLER] Discovered ${sitemapUrls.length} routes from sitemap`)
        for (const url of sitemapUrls) {
          const norm = normalizeUrl(url, baseUrl)
          if (norm && !visitedUrls.has(norm) && !pendingUrls.includes(norm)) {
            pendingUrls.push(norm)
          }
        }
      }

      // 2. Base URL + key routes
      const pathsToAdd = ['/', ...keyRoutes.map(r => r.startsWith('/') ? r : `/${r}`)]
      for (const p of pathsToAdd) {
        const url = baseUrl.replace(/\/$/, '') + p
        const norm = normalizeUrl(url, baseUrl)
        if (norm && !visitedUrls.has(norm) && !pendingUrls.includes(norm)) {
          pendingUrls.unshift(norm) // priority: add to front
        }
      }
    }

    // ── Take up to runLimit URLs to crawl this run ───────────────────────────
    const toVisitThisRun = pendingUrls.splice(0, runLimit)
    // remaining pendingUrls will be preserved in state for the next run

    const result: WebAppCrawlResult = {
      base_url: baseUrl.replace(/\/$/, ''),
      pages:    [],
      stats:    { sitemap_discovered: 0, playwright_crawled: 0 },
      crawlState: {
        visitedUrls:         [],
        pendingUrls:         [],
        totalDiscoveredPages: 0,
        lastRunAt:           new Date().toISOString(),
        runCount:            runCount + 1,
      },
      hasMorePages:    false,
      progressMessage: '',
    }

    let statsSitemap    = 0
    let statsPlaywright = 0

    // Track thin-metadata pages that need re-crawl
    const thinRequeue: string[] = []

    let browser: import('playwright').Browser | null = null

    try {
      const { chromium } = await import('playwright')
      browser = await chromium.launch({ headless: true })

      // ── Build Playwright browser context ─────────────────────────────────
      // Always start with a CLEAN context (no httpCredentials).
      // httpCredentials inject an `Authorization: Basic` header on EVERY request,
      // which corrupts cookie-based sessions on apps that use form login but are
      // configured with login_strategy='basic_auth'.
      // We'll only add httpCredentials if the site actually needs HTTP 401 auth
      // (no form login page detected during pre-warm).
      let context: import('playwright').BrowserContext
      let page: import('playwright').Page

      const initBypass = async (ctx: import('playwright').BrowserContext) => {
        await ctx.addInitScript('window.__name = (fn) => fn;');
      };

      if (authSessionPath) {
        try {
          context = await browser.newContext({ storageState: authSessionPath })
          log.info(`[CRAWLER] Loaded auth session from ${authSessionPath}`)
        } catch {
          log.warn('[CRAWLER] Failed to load auth session — starting fresh context')
          context = await browser.newContext()
        }
      } else {
        context = await browser.newContext()
      }
      await initBypass(context)

      page = await context.newPage()
      page.setDefaultTimeout(20_000)
      page.setDefaultNavigationTimeout(30_000)

      // ── Pre-warm login session ───────────────────────────────────────────
      // Navigate to the base URL first to establish session.
      // On continuation runs, restore the saved session cookies to skip re-login.
      // For basic_auth: test if the site uses form login or true HTTP 401.
      //   - Form login detected  → use form login (no httpCredentials)
      //   - No form login        → recreate context WITH httpCredentials
      if (isContinuation && initialState?.sessionStorage) {
        // Restore saved cookies from previous run — no re-login needed
        try {
          await context.addCookies(initialState.sessionStorage.cookies ?? [])
          log.info(`[CRAWLER] ✅ Restored session from crawl_state (${initialState.sessionStorage.cookies?.length ?? 0} cookies) — skipping pre-warm`)
        } catch (restoreErr) {
          log.warn({ err: restoreErr }, '[CRAWLER] Session restore failed — will re-login')
        }
      } else if (credentials) {
        try {
          log.info(`[CRAWLER] 🔐 Pre-warming login session on ${baseUrl}`)
          await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 })
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
          const preCheck = await WebMetadataService._isLoginPage(page)
          if (preCheck.isLogin) {
            // Site has a form-based login page — use form login, NOT httpCredentials
            log.info(`[CRAWLER] Form login page detected (reason: ${preCheck.reason}) — using form login`)
            const loginResult = await WebMetadataService._attemptLogin(page, credentials)
            if (loginResult.success) {
              log.info(`[CRAWLER] ✅ Pre-warm form login succeeded — session established`)
              await page.waitForTimeout(1_500)
              // Persist session cookies for continuation runs
              try {
                const cookies = await context.cookies()
                result.crawlState.sessionStorage = { cookies }
                log.info(`[CRAWLER] 💾 Saved ${cookies.length} session cookies for continuation`)
              } catch (saveErr) {
                log.warn({ err: saveErr }, '[CRAWLER] Failed to save session cookies (non-critical)')
              }
            } else {
              log.warn(`[CRAWLER] ⚠ Pre-warm form login FAILED — crawl may produce fewer pages`)
            }
          } else if (isBasicAuth) {
            // No form login page AND basic_auth configured → true HTTP Basic Auth site
            // Recreate context with httpCredentials for the 401 challenge protocol
            log.info(`[CRAWLER] No form login page — switching to HTTP Basic Auth credentials`)
            await page.close()
            await context.close()
            context = await browser.newContext({
              httpCredentials: {
                username: credentials.username,
                password: credentials.password,
              },
            })
            await initBypass(context)
            page = await context.newPage()
            page.setDefaultTimeout(20_000)
            page.setDefaultNavigationTimeout(30_000)
          } else {
            log.info(`[CRAWLER] Pre-warm: base URL is not a login page — session already active`)
            // Save cookies even if no login was needed
            try {
              const cookies = await context.cookies()
              if (cookies.length > 0) {
                result.crawlState.sessionStorage = { cookies }
              }
            } catch { /* non-critical */ }
          }
        } catch (preErr) {
          log.warn({ err: preErr }, '[CRAWLER] Pre-warm login error — continuing anyway')
        }
      }

      let pagesCrawled = 0
      let consecutiveLoginFailures = 0

      // Run-level fingerprint set for modal deduplication.
      // Shared across ALL pages in this crawl run so the same modal form
      // (e.g. "Create Lead" triggered from both /leads and the dashboard)
      // is stored only once.
      const runModalFingerprints = new Set<string>()
      // Increased from 3 → 10: some apps have isolated pages that require a
      // fresh token challenge even within the same browser session. A higher
      // limit prevents premature abort while still catching real auth failures.
      const MAX_LOGIN_FAILURES = 10

      for (const url of toVisitThisRun) {
        if (visitedUrls.has(url)) {
          log.debug(`[CRAWLER] Skipping already-visited: ${url}`)
          continue
        }

        // ── Abort early if too many consecutive auth failures ────────────
        if (consecutiveLoginFailures >= MAX_LOGIN_FAILURES) {
          log.error(
            `[CRAWLER] ❌ Aborting crawl: ${consecutiveLoginFailures} consecutive pages ` +
            `redirected to login — authentication is failing. Check credentials.`
          )
          break
        }

        try {
          const source: 'sitemap' | 'playwright' = 'playwright'
          // Always pass credentials to _visitPage — for basic_auth apps that use
          // Keycloak/form-based login, the browser context httpCredentials handles
          // HTTP 401 challenges while the form-login fallback handles SSO redirect pages.
          const pageMeta = await WebMetadataService._visitPage(
            page, url, baseUrl, credentials, stabilizationConfig,
          )

          if (pageMeta) {
            // ── Filter login-redirect pages ───────────────────────────────────────────────
            // If the page was detected as a login redirect AND re-login also failed,
            // count it as a failure. If re-login succeeded, the page just needed a
            // fresh challenge — don't penalise that as a failure.
            if (pageMeta.redirected_to_login) {
              consecutiveLoginFailures++
              visitedUrls.add(url)
              log.warn(
                `[CRAWLER] ⚠ Skipping login-redirect page: ${url} ` +
                `(consecutive failures: ${consecutiveLoginFailures}/${MAX_LOGIN_FAILURES})`
              )
              continue
            }

            // Reset consecutive failure counter on any successfully crawled page
            consecutiveLoginFailures = 0

            // ── Filter 404 / error pages ─────────────────────────────────────────────────
            // Do not store pages that returned a 404 / not-found response.
            // These are bad routes from key_routes that don't exist in this app.
            const is404 = (
              pageMeta.title?.toLowerCase().includes('404') ||
              pageMeta.title?.toLowerCase().includes('not found') ||
              pageMeta.title?.toLowerCase().includes('could not be found') ||
              pageMeta.title?.toLowerCase().includes('page not found')
            )
            if (is404) {
              visitedUrls.add(url) // mark visited so we don't retry
              log.debug(`[CRAWLER] Skipped 404 page: ${url} ("${pageMeta.title}")`)
              continue
            }
            pageMeta.source = source
            pageMeta.crawl_depth = 0
            result.pages.push(pageMeta)
            visitedUrls.add(url)
            pagesCrawled++
            statsPlaywright++

            log.info(
              `[CRAWLER] ✓ Crawled (${pagesCrawled}/${toVisitThisRun.length}): ${url}`
            )

            // ── Self-healing: re-queue thin-metadata pages ─────────────────
            const interactiveCount = pageMeta.inputs.length + pageMeta.buttons.length + pageMeta.selects.length
            if (interactiveCount < THIN_METADATA_THRESHOLD) {
              log.debug(`[CRAWLER] Thin metadata on ${url} (${interactiveCount} elements) → flagging for re-crawl`)
              thinRequeue.push(url)
            }

            // ── Link collection: discover new internal links ────────────────
            // Note: normalizeUrl now preserves hash fragments, so hash-routed
            // SPAs (e.g. /#/leads) generate distinct entries in pendingUrls.
            if (enableDeepCrawl || true) { // always collect links for incremental discovery
              for (const link of pageMeta.links) {
                if (link.locator && link.locator.startsWith('http')) {
                  const candidate = normalizeUrl(link.locator, baseUrl)
                  if (
                    candidate &&
                    !visitedUrls.has(candidate) &&
                    !pendingUrls.includes(candidate) &&
                    !toVisitThisRun.includes(candidate)
                  ) {
                    pendingUrls.push(candidate)
                  }
                }
              }
            }

            // ── Navigation item route discovery ──────────────────────────────
            // Uses the extracted <nav>/sidebar items which are more reliable
            // than body links for SPAs. Covers both href-based and text-derived
            // routes, and handles hash-routing (#/leads) via the updated normalizeUrl.
            const navRoutes = deriveRoutesFromNavItems(pageMeta.navigation_items, baseUrl)
            let navRoutesAdded = 0
            for (const candidate of navRoutes) {
              if (
                !visitedUrls.has(candidate) &&
                !pendingUrls.includes(candidate) &&
                !toVisitThisRun.includes(candidate)
              ) {
                pendingUrls.push(candidate)
                navRoutesAdded++
              }
            }
            if (navRoutesAdded > 0) {
              log.info(
                `[CRAWLER] Nav-item discovery: found ${navRoutesAdded} new routes from navigation items on ${url}`
              )
            }

            // ── Button-based route discovery (strict multi-line format) ───────
            // SPA apps often use <button> elements for navigation (not <a> tags).
            // Derive candidate URLs from button labels and add to pending queue.
            const buttonRoutes = deriveRoutesFromButtons(pageMeta.buttons, baseUrl)
            let buttonRoutesAdded = 0
            for (const candidate of buttonRoutes) {
              if (
                !visitedUrls.has(candidate) &&
                !pendingUrls.includes(candidate) &&
                !toVisitThisRun.includes(candidate)
              ) {
                pendingUrls.push(candidate)
                buttonRoutesAdded++
              }
            }
            if (buttonRoutesAdded > 0) {
              log.info(
                `[CRAWLER] Button-route discovery: found ${buttonRoutesAdded} new candidate routes from buttons on ${url}`
              )
            }

            // ── Deep-route expansion: create/detail routes per entity ─────────────
            // For each top-level list page (e.g. /leads) derive:
            //   /leads/create, /leads/new     ← create form
            //   /leads/{first-uuid-found}     ← one representative detail page
            const deepRoutes = deriveDetailRoutes(pageMeta, baseUrl)
            let deepRoutesAdded = 0
            for (const candidate of deepRoutes) {
              if (
                !visitedUrls.has(candidate) &&
                !pendingUrls.includes(candidate) &&
                !toVisitThisRun.includes(candidate)
              ) {
                pendingUrls.push(candidate)
                deepRoutesAdded++
              }
            }
            if (deepRoutesAdded > 0) {
              log.info(
                `[CRAWLER] Deep-route expansion: added ${deepRoutesAdded} create/detail routes from ${url}`
              )
            }

            // ── Modal/Dialog form discovery ───────────────────────────────────────
            // Run on ALL entity-type pages — NOT gated on pageMeta.buttons.length.
            //
            // WHY: SPA list pages (e.g. /bookings, /enquiries, /quotations) render
            // their "New Booking" / "Create Enquiry" action buttons ASYNCHRONOUSLY
            // after the static DOM snapshot, so pageMeta.buttons is empty even though
            // the buttons exist in the live DOM. _discoverModalForms has a live DOM
            // rescan that finds these async-loaded buttons — but only if we invoke it.
            //
            // SKIP: UUID detail pages (e.g. /bookings/737b1b37-...) — they have 50+
            // buttons but they are record-level actions, not create-form triggers.
            // Also skip pages that are already modal synthetic pages (/__modal__/).
            const UUID_PATH_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/i
            const isEntityPage = !pageMeta.is_modal
              && !pageMeta.url.includes('/__modal__/')
              && !UUID_PATH_RE.test(new URL(pageMeta.url).pathname)
            if (isEntityPage) {
              try {
                const modalForms = await WebMetadataService._discoverModalForms(
                  page, pageMeta, url, baseUrl,
                  0,                   // depth=0 (page-level, not nested)
                  runModalFingerprints, // run-level dedup set — shared across all pages
                )
                for (const mf of modalForms) {
                  // Deduplicate by synthetic URL (avoids double-storing same modal)
                  if (!visitedUrls.has(mf.url) && !result.pages.some(p => p.url === mf.url)) {
                    result.pages.push(mf)
                    visitedUrls.add(mf.url)  // synthetic URL — won't be re-crawled as a real page
                    // NOTE: pagesCrawled and statsPlaywright are NOT incremented here
                    // so popup/modal pages don't count against perRunLimit
                  }
                }
                if (modalForms.length > 0) {
                  log.info(
                    `[CRAWLER] 🗂 ${modalForms.length} modal/popup form(s) discovered on ${url}`
                  )
                }
              } catch (modalErr) {
                log.debug({ modalErr }, '[CRAWLER] Modal discovery failed (non-fatal) — continuing')
              }
            }
          } else {
            // Navigation failed — keep in visited to avoid infinite retries
            visitedUrls.add(url)
          }
        } catch (err) {
          log.warn({ err }, `[CRAWLER] Failed to crawl ${url}`)
          visitedUrls.add(url) // mark visited to avoid retrying a broken page
        }
      }

      await context.close()
    } catch (err) {
      log.error({ err }, '[CRAWLER] Fatal crawl error')
    } finally {
      if (browser) await browser.close().catch(() => {})
    }

    // ── Re-add thin pages to front of pending (self-healing) ────────────────
    if (thinRequeue.length > 0) {
      // Remove from visitedUrls so they can be re-crawled
      for (const u of thinRequeue) {
        visitedUrls.delete(u)
      }
      // Prepend to pendingUrls so they get priority next run
      pendingUrls.unshift(...thinRequeue)
      log.info(`[CRAWLER] Self-healing: requeueing ${thinRequeue.length} thin-metadata pages`)
    }

    result.stats!.sitemap_discovered = statsSitemap
    result.stats!.playwright_crawled = statsPlaywright

    // ── Build final CrawlState ───────────────────────────────────────────────
    const totalDiscoveredPages = visitedUrls.size + pendingUrls.length

    result.crawlState = {
      visitedUrls:          Array.from(visitedUrls),
      pendingUrls,
      totalDiscoveredPages,
      lastRunAt:            new Date().toISOString(),
      runCount:             runCount + 1,
    }

    result.hasMorePages = pendingUrls.length > 0

    const crawledSoFar = visitedUrls.size
    result.progressMessage = result.hasMorePages
      ? `Crawled ${crawledSoFar} of ${totalDiscoveredPages} pages — continuing automatically…`
      : `Crawl complete — ${crawledSoFar} pages discovered and extracted`

    log.info(
      `[CRAWLER] Run #${runCount + 1} done. ` +
      `This run: ${result.pages.length} pages. ` +
      `Total visited: ${visitedUrls.size}, pending: ${pendingUrls.length}. ` +
      `hasMorePages=${result.hasMorePages}`
    )

    return result
  }

  // ── Login Page Detection ───────────────────────────────────────────────────
  // Detects if the current page is a login/auth page by checking URL, DOM,
  // and visible form elements. Used universally on every page visit.

  static async _isLoginPage(
    page: import('playwright').Page,
  ): Promise<{ isLogin: boolean; reason: string }> {
    const currentUrl = page.url().toLowerCase()

    // Check 1: URL path contains auth-related segments (including Keycloak SSO patterns)
    const authPathPattern = /\/(login|signin|sign-in|sign_in|auth|authenticate|sso|oauth|cas|saml|realms|openid-connect|kc|idp)\b/i
    const urlIsAuth = authPathPattern.test(currentUrl)

    // Check 2: Visible password field present
    let hasVisiblePassword = false
    try {
      const pwdField = page.locator('input[type="password"]')
      const pwdCount = await pwdField.count()
      hasVisiblePassword = pwdCount > 0 && await pwdField.first().isVisible({ timeout: 1_000 }).catch(() => false)
    } catch { /* non-critical */ }

    // Check 3: Button text matches login keywords
    let hasLoginButton = false
    try {
      for (const name of ['Log In', 'Login', 'Sign In', 'Sign in', 'Submit', 'Enter']) {
        const btn = page.getByRole('button', { name, exact: false })
        if (await btn.count() > 0 && await btn.first().isVisible({ timeout: 500 }).catch(() => false)) {
          hasLoginButton = true
          break
        }
      }
    } catch { /* non-critical */ }

    // Decision: login page if URL is auth-related AND has password field,
    // OR if URL is auth-related AND has login button,
    // OR if password field + login button (even without auth URL — handles redirects)
    if (urlIsAuth && hasVisiblePassword) {
      return { isLogin: true, reason: `URL contains auth path and has password field` }
    }
    if (urlIsAuth && hasLoginButton) {
      return { isLogin: true, reason: `URL contains auth path and has login button` }
    }
    if (hasVisiblePassword && hasLoginButton) {
      return { isLogin: true, reason: `Has password field and login button (likely auth redirect)` }
    }

    return { isLogin: false, reason: '' }
  }

  // ── Reusable Login Handler ────────────────────────────────────────────────
  // Attempts to log in on the current page using provided credentials.
  // Returns whether login succeeded (verified by checking the URL changed
  // away from the login page).

  static async _attemptLogin(
    page: import('playwright').Page,
    credentials: { username: string; password: string },
  ): Promise<{ success: boolean; finalUrl: string }> {
    const urlBeforeLogin = page.url()
    log.info(`[CRAWLER] 🔐 Attempting auto-login on ${urlBeforeLogin}`)

    try {
      // Fill username
      for (const sel of [
        'input[type="email"]', 'input[name="username"]', 'input[name="email"]',
        'input[name="user"]', 'input[name="login"]', 'input[id="username"]',
        'input[id="email"]', 'input[type="text"]',
      ]) {
        try {
          const f = page.locator(sel).first()
          if (await f.isVisible({ timeout: 1_000 }).catch(() => false)) {
            await f.fill(credentials.username)
            break
          }
        } catch { /* try next */ }
      }

      // Fill password
      const pwdField = page.locator('input[type="password"]')
      if (await pwdField.count() > 0) {
        await pwdField.first().fill(credentials.password)
      }

      // Click login button
      for (const name of ['Log In', 'Login', 'Sign In', 'Submit', 'Sign in', 'Enter']) {
        try {
          const btn = page.getByRole('button', { name, exact: false })
          if (await btn.count() > 0) {
            await btn.first().click({ timeout: 5_000 })
            break
          }
        } catch { /* try next */ }
      }

      // Wait for navigation to settle
      await page.waitForTimeout(2_500)
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})

      // Verify login success: URL should have changed away from the login page
      const finalUrl = page.url()
      const loginCheck = await WebMetadataService._isLoginPage(page)
      if (loginCheck.isLogin) {
        log.warn(`[CRAWLER] ❌ Login FAILED — still on login page: ${finalUrl}`)
        return { success: false, finalUrl }
      }

      log.info(`[CRAWLER] ✅ Login succeeded — navigated to: ${finalUrl}`)
      return { success: true, finalUrl }
    } catch (loginErr) {
      log.warn({ loginErr }, '[CRAWLER] Login attempt error')
      return { success: false, finalUrl: page.url() }
    }
  }

  // ── Extract Page Content (no navigation, no auth check) ──────────────────
  // Extracts metadata from the CURRENTLY LOADED page.
  // Used after interactive clicks (e.g. "Edit Lead") that navigate away to a
  // real page — we want the content of that landing page without re-navigating.

  static async _extractPageContent(
    page: import('playwright').Page,
    baseUrl: string,
  ): Promise<PageMetadata | null> {
    try {
      const parsedUrl = new URL(page.url())
      const path = parsedUrl.pathname || '/'

      const meta: PageMetadata = {
        url: page.url(),
        path,
        title: '',
        headings: [],
        buttons: [],
        links: [],
        inputs: [],
        selects: [],
        testids: [],
        navigation_items: [],
      }

      try { meta.title = (await page.title()) || '' } catch { /* ignore */ }

      // Extract headings
      try {
        meta.headings = await page.evaluate(() =>
          Array.from(document.querySelectorAll('h1, h2, h3'))
            .map(h => (h as HTMLElement).innerText?.trim())
            .filter(Boolean).slice(0, 8)
        ) as string[]
      } catch { /* ignore */ }

      // Extract inputs (reuse same logic as _visitPage)
      try {
        const inputsRaw = await page.evaluate(() => {
          return Array.from(document.querySelectorAll(
            'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea'
          ) as NodeListOf<HTMLInputElement>)
            .filter(el => el.offsetParent !== null)
            .slice(0, 25)
            .map(el => {
              let label = ''
              let labelHasAsterisk = false
              if (el.id) {
                const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
                if (lbl) { label = lbl.innerText?.trim() || ''; labelHasAsterisk = lbl.textContent?.includes('*') || false }
              }
              if (!label) label = el.getAttribute('aria-label') || ''
              if (!label) label = el.getAttribute('placeholder') || ''
              if (!label) label = el.getAttribute('name') || ''
              const isRequired = el.required || el.hasAttribute('required')
                || el.getAttribute('aria-required') === 'true' || labelHasAsterisk
              return { tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || 'text',
                label, placeholder: el.getAttribute('placeholder') || '',
                ariaLabel: el.getAttribute('aria-label') || '', name: el.getAttribute('name') || '',
                testid: el.getAttribute('data-testid') || '', id: el.id || '', required: isRequired }
            })
        }) as Array<{ tag: string; type: string; label: string; placeholder: string; ariaLabel: string; name: string; testid: string; id: string; required: boolean }>

        for (const raw of inputsRaw) {
          const displayLabel = (raw.label || raw.ariaLabel || raw.placeholder || raw.name || '').slice(0, 80)
          if (!displayLabel) continue
          let locatorType = 'label', locator = displayLabel
          if (raw.label)            { locatorType = 'label';       locator = raw.label.slice(0, 80) }
          else if (raw.ariaLabel)   { locatorType = 'label';       locator = raw.ariaLabel.slice(0, 80) }
          else if (raw.placeholder) { locatorType = 'placeholder'; locator = raw.placeholder.slice(0, 80) }
          else if (raw.testid)      { locatorType = 'testid';      locator = raw.testid }
          else if (raw.id)          { locatorType = 'css';         locator = `#${raw.id}` }
          else                      { locatorType = 'css';         locator = `input[name='${raw.name}']` }
          meta.inputs.push({ role: 'textbox', name: displayLabel, tag: raw.tag,
            locator_type: locatorType, locator, required: Boolean(raw.required) })
        }
      } catch { /* ignore */ }

      // Extract selects
      try {
        const selRaw = await page.evaluate(() =>
          Array.from(document.querySelectorAll('select, [role="combobox"], [role="listbox"]') as NodeListOf<HTMLElement>)
            .filter(el => el.offsetParent !== null).slice(0, 10)
            .map(el => {
              let label = el.getAttribute('aria-label') || el.getAttribute('name') || ''
              let labelHasAsterisk = false
              if (!label && el.id) {
                const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
                if (lbl) { label = lbl.innerText?.trim() || ''; labelHasAsterisk = lbl.textContent?.includes('*') || false }
              }
              const isRequired = (el as HTMLSelectElement).required || el.hasAttribute('required')
                || el.getAttribute('aria-required') === 'true' || labelHasAsterisk
              const options = Array.from(el.querySelectorAll('option') as NodeListOf<HTMLOptionElement>)
                .map(o => o.innerText?.trim()).filter(Boolean).slice(0, 8)
              return { label, options, tag: el.tagName.toLowerCase(), required: isRequired }
            })
        ) as Array<{ label: string; options: string[]; tag: string; required: boolean }>
        for (const raw of selRaw) {
          const locator = (raw.label || '').slice(0, 80)
          if (!locator) continue
          meta.selects.push({ role: 'combobox', name: locator, tag: raw.tag,
            locator_type: 'label', locator, required: Boolean(raw.required),
            options: raw.options.length > 0 ? raw.options : undefined })
        }
      } catch { /* ignore */ }

      // Extract visible buttons
      try {
        const btnsRaw = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]') as NodeListOf<HTMLElement>)
            .filter(el => el.offsetParent !== null).slice(0, 20)
            .map(el => ({
              tag: el.tagName.toLowerCase(),
              text: ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '')
                .replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim(),
              ariaLabel: el.getAttribute('aria-label') || '',
            }))
        ) as Array<{ tag: string; text: string; ariaLabel: string }>
        for (const raw of btnsRaw) {
          const name = (raw.ariaLabel || raw.text || '').slice(0, 80)
          if (!name) continue
          meta.buttons.push({ role: 'button', name, tag: raw.tag,
            locator_type: 'role', locator: `role=button, name=${name}`, required: false })
        }
      } catch { /* ignore */ }

      return meta
    } catch (err) {
      log.debug({ err }, '[CRAWLER] _extractPageContent failed (non-fatal)')
      return null
    }
  }

  // ── Multi-Stage Page Stabilization ─────────────────────────────────────────
  // Ensures all interactive elements (buttons, menus, inputs) are rendered
  // before we extract metadata. Critical for JS-heavy SPAs where:
  //   1. DOMContentLoaded fires before framework mounts
  //   2. networkidle fires before data-fetch completes
  //   3. Buttons/tables render 2–5s after networkidle
  //
  // Pipeline:
  //   Stage 1: Wait for network to settle (API calls done)
  //   Stage 2: Wait for ANY interactive element to appear
  //   Stage 3: Wait until a minimum number of buttons/elements are present
  //   Stage 4: Final micro-settle for stragglers
  //
  // The entire pipeline is guarded by a hard per-page timeout to prevent
  // infinite waits on broken or empty pages.

  static async _waitForPageStabilization(
    page: import('playwright').Page,
    config: Required<StabilizationConfig>,
    pageUrl: string,
  ): Promise<{ stageReached: number; elementCount: number }> {
    const deadline = Date.now() + config.hardPageTimeout
    let stageReached = 0
    let elementCount = 0

    // Broader interactive selector — catches inputs too so forms show up reliably
    const INTERACTIVE_SELECTOR =
      'button, [role="button"], [role="menuitem"], [role="option"], ' +
      'input[type="submit"], input[type="button"], a[role="button"], ' +
      'input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea'

    // Stage 1: Network idle — all XHR/fetch calls should be done
    try {
      const t1 = Math.min(config.networkIdleTimeout, deadline - Date.now())
      if (t1 > 0) {
        await page.waitForLoadState('networkidle', { timeout: t1 })
      }
      stageReached = 1
    } catch {
      log.debug(`[STABILIZE] Stage 1 (networkidle) timed out for ${pageUrl} — continuing`)
    }

    // Stage 2: Wait for ANY interactive element (button OR input) to appear
    const FIRST_ELEMENT_SELECTOR =
      'button, [role="button"], input, select'
    try {
      const t2 = Math.min(config.firstElementTimeout, deadline - Date.now())
      if (t2 > 0) {
        await page.waitForSelector(FIRST_ELEMENT_SELECTOR, { timeout: t2 })
      }
      stageReached = 2
    } catch {
      log.debug(`[STABILIZE] Stage 2 (first element) timed out for ${pageUrl} — continuing`)
    }

    // Stage 3: Wait until a minimum number of buttons/inputs are visible.
    // waitForFunction() polls the browser — more reliable than repeated locator.count().
    try {
      const t3 = Math.min(config.buttonThresholdTimeout, deadline - Date.now())
      if (t3 > 0 && config.minButtonThreshold > 0) {
        const threshold = config.minButtonThreshold
        await page.waitForFunction(
          (args: { sel: string; min: number }) => {
            const els = document.querySelectorAll(args.sel)
            const visible = Array.from(els).filter(
              el => (el as HTMLElement).offsetParent !== null,
            )
            return visible.length >= args.min
          },
          { sel: INTERACTIVE_SELECTOR, min: threshold },
          { timeout: t3 },
        )
        stageReached = 3
      }
    } catch {
      log.debug(`[STABILIZE] Stage 3 (threshold ≥${config.minButtonThreshold}) timed out for ${pageUrl} — continuing`)
    }

    // Stage 4: Final micro-settle — random jitter 800–1200 ms so async batches
    // that fire ~1 second after networkidle are reliably captured.
    const microSettleActual = config.microSettleMs + Math.floor(Math.random() * 400)
    const t4 = Math.min(microSettleActual, Math.max(0, deadline - Date.now()))
    if (t4 > 0) {
      await page.waitForTimeout(t4)
    }
    stageReached = Math.max(stageReached, 4)

    // Count final interactive elements for logging
    try {
      elementCount = await page.evaluate((sel: string) => {
        return Array.from(document.querySelectorAll(sel))
          .filter(el => (el as HTMLElement).offsetParent !== null).length
      }, INTERACTIVE_SELECTOR)
    } catch { /* non-critical */ }

    return { stageReached, elementCount }
  }

  // ── Visit Page (with auth redirect detection + re-login + retry) ──────────

  static async _visitPage(
    page: import('playwright').Page,
    url: string,
    baseUrl: string,
    credentials?: { username: string; password: string },
    stabilization?: StabilizationConfig,
  ): Promise<PageMetadata | null> {
    const stConfig = { ...DEFAULT_STABILIZATION, ...(stabilization ?? {}) }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })

       // ── Multi-stage stabilization ───────────────────────────────────────
      const { stageReached, elementCount } = await WebMetadataService._waitForPageStabilization(
        page, stConfig, url,
      )
      // ── DIAGNOSTIC: trace what happens during real sync ──
      const postUrl = page.url()
      let postBtnCount = 0
      let postBtnSample: string[] = []
      try {
        postBtnCount = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(el => (el as HTMLElement).offsetParent !== null).length
        )
        postBtnSample = await page.evaluate(() =>
          Array.from(document.querySelectorAll('button, [role="button"]'))
            .filter(el => (el as HTMLElement).offsetParent !== null)
            .slice(0, 3)
            .map(el => ((el as HTMLElement).innerText || '').replace(/\n/g, ' ').trim().slice(0, 30))
        )
      } catch { /* ignore */ }
      log.info(
        `[CRAWLER] ⚡ VISIT-TRACE ${url} → postUrl=${postUrl}, ` +
        `stage=${stageReached}, elements=${elementCount}, ` +
        `buttons=${postBtnCount}, sample=[${postBtnSample.join(' | ')}]`
      )
    } catch (err) {
      log.warn({ err }, `[CRAWLER] Navigation failed for ${url}`)
      return null
    }

    // ── Auth redirect detection ──────────────────────────────────────────────
    // Check if the page we landed on is actually a login page (redirect).
    // If so, attempt login and retry navigating to the original target URL.
    const loginCheck = await WebMetadataService._isLoginPage(page)
    if (loginCheck.isLogin && credentials) {
      log.info(`[CRAWLER] 🔄 Auth redirect detected for ${url}: ${loginCheck.reason}`)

      const loginResult = await WebMetadataService._attemptLogin(page, credentials)
      if (!loginResult.success) {
        // Login failed — mark as redirected and return a stub page
        log.warn(`[CRAWLER] Cannot authenticate — marking ${url} as login-redirect`)
        return {
          url, path: new URL(url).pathname || '/',
          title: '', headings: [], buttons: [], links: [],
          inputs: [], selects: [], testids: [], navigation_items: [],
          redirected_to_login: true,
        }
      }

      // Login succeeded — navigate back to the original target URL
      try {
        log.info(`[CRAWLER] Re-navigating to original target after login: ${url}`)
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})

        // Final check: are we STILL on a login page after retry?
        const retryCheck = await WebMetadataService._isLoginPage(page)
        if (retryCheck.isLogin) {
          log.warn(`[CRAWLER] Still on login page after re-navigation — marking ${url} as login-redirect`)
          return {
            url, path: new URL(url).pathname || '/',
            title: '', headings: [], buttons: [], links: [],
            inputs: [], selects: [], testids: [], navigation_items: [],
            redirected_to_login: true,
          }
        }
      } catch (retryErr) {
        log.warn({ retryErr }, `[CRAWLER] Re-navigation failed for ${url}`)
        return null
      }
    } else if (loginCheck.isLogin && !credentials) {
      // No credentials available — mark as login redirect
      log.warn(`[CRAWLER] Login page detected but no credentials available for ${url}`)
      return {
        url, path: new URL(url).pathname || '/',
        title: '', headings: [], buttons: [], links: [],
        inputs: [], selects: [], testids: [], navigation_items: [],
        redirected_to_login: true,
      }
    }

    const parsedUrl = new URL(page.url())
    const path = parsedUrl.pathname || '/'

    const meta: PageMetadata = {
      url: page.url(),
      path,
      title: '',
      headings: [],
      buttons: [],
      links: [],
      inputs: [],
      selects: [],
      testids: [],
      navigation_items: [],
    }

    try { meta.title = (await page.title()) || '' } catch { /* ignore */ }

    try {
      meta.headings = await page.evaluate(() =>
        Array.from(document.querySelectorAll('h1, h2, h3'))
          .map((h) => (h as HTMLElement).innerText?.trim())
          .filter(Boolean)
          .slice(0, 8)
      ) as string[]
    } catch { /* ignore */ }

    // ── Enhanced Button & Interactive Element Extraction ──────────────────────
    // Four-tier extraction prioritised by action-relevance.
    //
    //   Tier 1: Action buttons (Add, New, Create, Edit, …) — highest value
    //   Tier 2a: Clickable table rows / cards that open drawers
    //   Tier 2b: Standard ARIA buttons/menu items (non-action)
    //   Tier 3:  Custom component framework fallback (v-btn, mat-button, …)
    //   Tier 2c: Sidebar nav items (for route discovery)
    //
    // Rich-text toolbar buttons (.ql-toolbar, .tox-toolbar, etc.) are
    // aggressively excluded — they produce noise with zero test value.
    // Total cap raised to 120 for complex SPA dashboards.
    try {
      const buttonsRaw = await page.evaluate(() => {
        // ── Comprehensive interactive element selector ──
        const INTERACTIVE_SEL =
          'button, [role="button"], input[type="submit"], input[type="button"], ' +
          'a[role="button"], [role="menuitem"], [role="option"]'

        // ── Aggressive rich-text toolbar exclusion ──
        // Quill, TinyMCE, ProseMirror, CKEditor, Draft.js and generic editor bars
        const RICHTEXT_TOOLBAR_SEL =
          '.ql-toolbar, .ql-snow, .ql-container, ' +
          '.tox-toolbar, .tox-editor-header, .tox-toolbar__primary, .tox-toolbar__overflow, ' +
          '.ProseMirror-menubar, .ProseMirror-menu, ' +
          '.ck-toolbar, .ck-editor__top, ' +
          '.rdw-editor-toolbar, .DraftEditor-root .public-DraftStyleDefault-block, ' +
          '.editor-toolbar, [class*="ql-"], [class*="tox-"], [class*="editor-toolbar"]'

        function isRichTextToolbarChild(el: Element): boolean {
          return el.closest(RICHTEXT_TOOLBAR_SEL) !== null
        }

        const all = Array.from(
          document.querySelectorAll(INTERACTIVE_SEL) as NodeListOf<HTMLElement>
        ).filter(el =>
          el.offsetParent !== null && !isRichTextToolbarChild(el),
        )

        // ── Utility: extract rich info from an element ──
        // Wrapped in array to prevent esbuild __name() helper injection
        const helpers = [
          (el: HTMLElement) => {
            const rawText = ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '')
              .replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()

            const parentContainer = el.closest(
              '[class*="toolbar"], [class*="header"], [class*="sidebar"], [class*="footer"], ' +
              '[class*="dialog"], [class*="modal"], [class*="drawer"], [class*="panel"], ' +
              '[class*="table"], [role="toolbar"], [role="dialog"], [role="navigation"], nav, header, main, aside'
            )
            const containerHint = parentContainer
              ? (parentContainer.getAttribute('role') || parentContainer.tagName.toLowerCase())
              : 'page'

            return {
              tag:       el.tagName.toLowerCase(),
              text:      rawText,
              ariaLabel: el.getAttribute('aria-label') || '',
              testid:    el.getAttribute('data-testid') || '',
              disabled:  el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
              container: containerHint,
            }
          }
        ]

        // ── Tier 1: High-value action/CTA buttons ──
        const ACTION_RE = /^(?:[+\-\s•●▶]*)?(?:new|add|create|edit|book|generate|invite|upload|import|export|open|convert|start|schedule|raise|submit|record|log|send|assign|clone|duplicate|sync|register|process|issue|approve|reject|dispatch|ship|quote|enquire|order|purchase|receive|manage|configure|refresh)\b/i
        const actionBtns = all
          .filter(el => {
            const txt = ((el as HTMLButtonElement).innerText || el.getAttribute('aria-label') || '').trim()
            return ACTION_RE.test(txt)
          })
          .map(helpers[0])

        // ── Tier 2a: Clickable table rows / cards that may open drawers ──
        const clickableRows = Array.from(document.querySelectorAll(
          'tr[data-id], tr[data-row-key], [role="row"][tabindex], ' +
          '[class*="clickable-row"], [data-clickable="true"], ' +
          'tr[class*="cursor-pointer"], tr[class*="hover"]'
        ) as NodeListOf<HTMLElement>)
          .filter(el => el.offsetParent !== null)
          .slice(0, 5)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.getAttribute('aria-label') || el.querySelector('td')?.innerText || '')
              .replace(/\s+/g, ' ').trim().slice(0, 60),
            ariaLabel: el.getAttribute('aria-label') || '',
            testid: el.getAttribute('data-testid') || '',
            disabled: false,
            container: 'table',
          }))
          .filter(r => r.text.length > 0)

        // ── Tier 2b: Remaining standard buttons (non-action) ──
        // Increased slice to 80 (was 60) to capture dense SPA toolbars
        const seenActionTexts = new Set(actionBtns.map(b => b.text.toLowerCase()))
        const restBtns = all
          .filter(el => {
            const txt = ((el as HTMLButtonElement).innerText || el.getAttribute('aria-label') || '').trim()
            return !ACTION_RE.test(txt) && !seenActionTexts.has(txt.toLowerCase())
          })
          .slice(0, 80)
          .map(helpers[0])

        // ── Tier 3: Class-name heuristic for custom component frameworks ──
        const seenTexts = new Set([...actionBtns, ...restBtns].map(b => b.text.toLowerCase()))
        const customBtns = Array.from(document.querySelectorAll(
          '[class*="btn"]:not(svg):not(script), [class*="button"]:not(svg):not(script), ' +
          '[class*="action"]:not(svg):not(script), [class*="cta"]:not(svg):not(script), ' +
          'v-btn, mat-button, mwc-button, app-button, ds-button'
        ) as NodeListOf<HTMLElement>)
          .filter(el => {
            if (el.offsetParent === null || isRichTextToolbarChild(el)) return false
            const txt = (el.innerText || el.getAttribute('aria-label') || '').trim()
            return txt.length > 0 && txt.length <= 60 && !seenTexts.has(txt.toLowerCase())
          })
          .slice(0, 25)
          .map(helpers[0])

        const customActionBtns = customBtns.filter(b => ACTION_RE.test(b.text))
        const customRestBtns   = customBtns.filter(b => !ACTION_RE.test(b.text))

        // ── Tier 2c: Sidebar navigation items (for route discovery) ──
        const navItems = Array.from(document.querySelectorAll(
          'nav a, [role="navigation"] a, [class*="sidebar"] a, [class*="sidenav"] a, ' +
          'nav button, [role="navigation"] button'
        ) as NodeListOf<HTMLElement>)
          .filter(el => {
            if (el.offsetParent === null) return false
            const txt = (el.innerText || '').trim()
            return txt.length > 0 && txt.length <= 40 && !seenTexts.has(txt.toLowerCase())
          })
          .slice(0, 20)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || '').replace(/\s+/g, ' ').trim(),
            ariaLabel: el.getAttribute('aria-label') || '',
            testid: el.getAttribute('data-testid') || '',
            disabled: false,
            container: 'navigation',
          }))

        // Merge all tiers: action first → clickable rows → rest → custom → nav
        // Total cap raised to 120 for complex SPA dashboards
        return [
          ...actionBtns, ...customActionBtns,
          ...clickableRows,
          ...restBtns, ...customRestBtns,
          ...navItems,
        ].slice(0, 120)
      }) as Array<{
        tag: string; text: string; ariaLabel: string; testid: string
        disabled: boolean; container: string
      }>

      for (const raw of buttonsRaw) {
        const name = (raw.ariaLabel || raw.text || '').slice(0, 80)
        if (!name) continue
        meta.buttons.push({
          role: 'button', name, tag: raw.tag,
          locator_type: 'role', locator: `role=button, name=${name}`,
          required: false,
          disabled: raw.disabled,
          container: raw.container,
        } as any)  // 'disabled' and 'container' are extra enrichment fields
        if (raw.testid) meta.testids.push(raw.testid)
      }

      log.debug(`[CRAWLER] Extracted ${meta.buttons.length} buttons from ${url}`)
    } catch (err) { log.warn({ err }, '[CRAWLER] Button extraction failed') }

    try {
      const linksRaw = await page.evaluate((bu) =>
        Array.from(document.querySelectorAll('a[href]') as NodeListOf<HTMLAnchorElement>)
          .filter((a) => a.offsetParent !== null && (a.href.startsWith(bu) || a.href.startsWith('/')))
          .slice(0, 30) // increased cap for better discovery
          .map((a) => ({
            text: ((a as HTMLElement).innerText || a.getAttribute('aria-label') || '').trim(),
            href: a.href,
            ariaLabel: a.getAttribute('aria-label') || '',
          }))
      , baseUrl) as Array<{ text: string; href: string; ariaLabel: string }>

      for (const raw of linksRaw) {
        const name = (raw.ariaLabel || raw.text || '').slice(0, 80)
        if (!name) continue
        meta.links.push({
          role: 'link', name, tag: 'a',
          locator_type: 'role', locator: raw.href, required: false,
        })
      }
    } catch (err) { log.debug({ err }, '[CRAWLER] Link extraction failed') }

    try {
      const inputsRaw = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea'
        ) as NodeListOf<HTMLInputElement>)
          .filter((el) => el.offsetParent !== null)
          .slice(0, 25)
          .map((el) => {
            let label = ''
            let labelHasAsterisk = false
            if (el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) {
                label = lbl.innerText?.trim() || ''
                labelHasAsterisk = lbl.textContent?.includes('*') || false
              }
            }
            if (!label) label = el.getAttribute('aria-label') || ''
            if (!label) label = el.getAttribute('placeholder') || ''
            if (!label) label = el.getAttribute('name') || ''

            const isRequired = el.required
              || el.hasAttribute('required')
              || el.getAttribute('aria-required') === 'true'
              || labelHasAsterisk

            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || 'text',
              label,
              placeholder: el.getAttribute('placeholder') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              name: el.getAttribute('name') || '',
              testid: el.getAttribute('data-testid') || '',
              id: el.id || '',
              required: isRequired,
            }
          })
      }) as Array<{
        tag: string; type: string; label: string; placeholder: string
        ariaLabel: string; name: string; testid: string; id: string; required: boolean
      }>

      for (const raw of inputsRaw) {
        const displayLabel = (raw.label || raw.ariaLabel || raw.placeholder || raw.name || '').slice(0, 80)
        if (!displayLabel) continue

        let locatorType = 'css'
        let locator = displayLabel

        if (raw.label)            { locatorType = 'label';       locator = raw.label.slice(0, 80) }
        else if (raw.ariaLabel)   { locatorType = 'label';       locator = raw.ariaLabel.slice(0, 80) }
        else if (raw.placeholder) { locatorType = 'placeholder'; locator = raw.placeholder.slice(0, 80) }
        else if (raw.testid)      { locatorType = 'testid';      locator = raw.testid }
        else if (raw.id)          { locatorType = 'css';         locator = `#${raw.id}` }
        else                      { locatorType = 'css';         locator = `input[name='${raw.name}']` }

        meta.inputs.push({
          role: 'textbox', name: displayLabel, tag: raw.tag,
          locator_type: locatorType, locator,
          required: Boolean(raw.required),
        })
        if (raw.testid) meta.testids.push(raw.testid)
      }
    } catch (err) { log.debug({ err }, '[CRAWLER] Input extraction failed') }

    try {
      const cbRaw = await page.evaluate(() =>
        Array.from(document.querySelectorAll('input[type=checkbox], input[type=radio]') as NodeListOf<HTMLInputElement>)
          .filter((el) => el.offsetParent !== null)
          .slice(0, 10)
          .map((el) => {
            let label = el.getAttribute('aria-label') || ''
            if (!label && el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) label = lbl.innerText?.trim() || ''
            }
            return { label, type: el.getAttribute('type') }
          })
      ) as Array<{ label: string; type: string | null }>

      for (const raw of cbRaw) {
        const name = (raw.label || '').slice(0, 80)
        if (!name) continue
        meta.inputs.push({
          role: raw.type === 'checkbox' ? 'checkbox' : 'radio',
          name, tag: 'input', locator_type: 'label', locator: name, required: false,
        })
      }
    } catch { /* ignore */ }

    try {
      const selRaw = await page.evaluate(() =>
        Array.from(document.querySelectorAll('select, [role="combobox"], [role="listbox"]') as NodeListOf<HTMLElement>)
          .filter((el) => el.offsetParent !== null)
          .slice(0, 10)
          .map((el) => {
            let label = el.getAttribute('aria-label') || el.getAttribute('name') || ''
            let labelHasAsterisk = false
            if (!label && el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) {
                label = lbl.innerText?.trim() || ''
                labelHasAsterisk = lbl.textContent?.includes('*') || false
              }
            }
            const isRequired = (el as HTMLSelectElement).required
              || el.hasAttribute('required')
              || el.getAttribute('aria-required') === 'true'
              || labelHasAsterisk
            const options = Array.from(el.querySelectorAll('option') as NodeListOf<HTMLOptionElement>)
              .map((o) => o.innerText?.trim()).filter(Boolean).slice(0, 5)
            return { label, options, tag: el.tagName.toLowerCase(), required: isRequired }
          })
      ) as Array<{ label: string; options: string[]; tag: string; required: boolean }>

      for (const raw of selRaw) {
        const locator = (raw.label || '').slice(0, 80)
        if (!locator) continue
        meta.selects.push({
          role: 'combobox', name: locator, tag: raw.tag,
          locator_type: 'label', locator,
          required: Boolean(raw.required),
          // Store valid options as a structured array so the LLM can see real pick values
          options: raw.options.length > 0 ? raw.options : undefined,
        })
      }
    } catch (err) { log.debug({ err }, '[CRAWLER] Select extraction failed') }

    try {
      const testids = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid]') as NodeListOf<HTMLElement>)
          .map((el) => el.getAttribute('data-testid'))
          .filter(Boolean)
          .slice(0, 20)
      ) as string[]
      for (const tid of testids) {
        if (!meta.testids.includes(tid)) meta.testids.push(tid)
      }
    } catch { /* ignore */ }

    // ── Navigation Menu Item Extraction ──────────────────────────────────────
    // Scan dedicated nav containers for sidebar/topnav items.
    // These are stored separately from generic links so the LLM can generate
    // reliable role=link locators instead of fragile text= selectors.
    try {
      const navRaw = await page.evaluate(() => {
        const NAV_SELECTORS = [
          'nav', '[role="navigation"]', '[role="menubar"]',
          '[class*="sidebar"]', '[class*="side-bar"]',
          '[class*="sidenav"]', '[class*="side-nav"]',
          '[class*="nav-menu"]', '[class*="navmenu"]',
          '[id*="sidebar"]', '[id*="side-nav"]', '[id*="nav-menu"]',
        ]

        // Collect all nav container elements (deduplicated)
        const containers: Element[] = []
        for (const sel of NAV_SELECTORS) {
          for (const el of Array.from(document.querySelectorAll(sel))) {
            if (!containers.includes(el)) containers.push(el)
          }
        }

        const items: Array<{
          text: string; role: string; href: string; ariaLabel: string; tag: string
        }> = []
        const seen = new Set<string>()

        for (const container of containers) {
          // Only process visible containers
          if ((container as HTMLElement).offsetParent === null) continue

          // Query clickable nav children: links, menuitem elements, buttons
          const candidates = Array.from(container.querySelectorAll(
            'a[href], [role="menuitem"], [role="treeitem"], [role="tab"], button'
          ) as NodeListOf<HTMLElement>)

          for (const el of candidates) {
            if (el.offsetParent === null) continue  // skip hidden items

            // Extract text — prefer innerText, fall back to aria-label / title
            const rawText = (el.innerText ?? '').trim().split('\n')[0].trim()
            const ariaLabel = el.getAttribute('aria-label') ?? ''
            const text = (rawText || ariaLabel).slice(0, 60)
            if (!text || text.length < 2) continue

            // Deduplicate by text
            const key = text.toLowerCase()
            if (seen.has(key)) continue
            seen.add(key)

            const tag = el.tagName.toLowerCase()
            const href = (el as HTMLAnchorElement).href ?? ''
            const role = el.getAttribute('role') ?? (tag === 'a' ? 'link' : tag === 'button' ? 'button' : '')

            items.push({ text, role, href, ariaLabel, tag })
          }
        }

        return items.slice(0, 30)
      }) as Array<{ text: string; role: string; href: string; ariaLabel: string; tag: string }>

      for (const raw of navRaw) {
        // Determine canonical ARIA role
        let role: NavItemInfo['role'] = 'unknown'
        if (raw.role === 'link' || raw.tag === 'a')       role = 'link'
        else if (raw.role === 'menuitem')                  role = 'menuitem'
        else if (raw.role === 'button' || raw.tag === 'button') role = 'button'
        else if (raw.role === 'treeitem')                  role = 'treeitem'
        else if (raw.role === 'tab')                       role = 'tab'

        // Build a recommended Playwright locator
        // Prefer role=link (most reliable), fallback to role=button or getByText
        let locator = ''
        if (role === 'link')      locator = `role=link, name=${raw.text}`
        else if (role === 'menuitem') locator = `role=menuitem, name=${raw.text}`
        else if (role === 'tab')   locator = `role=tab, name=${raw.text}`
        else if (role === 'button') locator = `role=button, name=${raw.text}`
        else                       locator = `text=${raw.text}`

        const item: NavItemInfo = {
          text:       raw.text,
          role,
          locator,
          href:       raw.href || undefined,
          ariaLabel:  raw.ariaLabel || undefined,
        }
        meta.navigation_items.push(item)
      }

      if (meta.navigation_items.length > 0) {
        log.info(
          `[CRAWLER] Extracted ${meta.navigation_items.length} navigation item(s) from nav/sidebar on ${url}`
        )
      }
    } catch (navErr) { log.debug({ navErr }, '[CRAWLER] Navigation item extraction failed (non-fatal)') }

    return meta
  }

  // ─── Shadow DOM Extraction ────────────────────────────────────────────────────

  /**
   * Recursively traverse all shadow roots on the page (or within a scoped element)
   * and collect form fields inside web components (e.g., Salesforce LWC, Polymer).
   *
   * Uses page.evaluate() to execute a recursive shadow-piercing traversal entirely
   * in the browser context — no Playwright locator limitations apply here.
   *
   * @param page   — Active Playwright page
   * @param rootSelector — Optional CSS selector to scope the traversal (defaults to document)
   * @returns Array of ShadowDomField objects for all found form elements
   */
  static async _extractShadowDomElements(
    page: import('playwright').Page,
    rootSelector?: string,
  ): Promise<ShadowDomField[]> {
    try {
      return await page.evaluate((opts: { rootSel: string | undefined }) => {
        const MAX_DEPTH = 3
        const fields: Array<{
          label: string; tag: string; type: string; placeholder: string;
          ariaLabel: string; name: string; id: string; required: boolean;
          isSelect: boolean; options: string[];
        }> = []

        // Wrap helpers in an array to prevent esbuild name-preservation wrapping inside Chromium
        const helpers: any[] = [
          // Index 0: getLabelFor
          (el: HTMLElement, root: Document | ShadowRoot): string => {
            if (el.id) {
              const lbl = root.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) return lbl.innerText?.trim() || ''
            }
            // Check aria-labelledby
            const labelledBy = el.getAttribute('aria-labelledby')
            if (labelledBy) {
              const lbl = root.getElementById(labelledBy)
              if (lbl) return (lbl as HTMLElement).innerText?.trim() || ''
            }
            return ''
          },
          // Index 1: extractFromRoot (recursive)
          (root: Document | ShadowRoot, depth: number, selfRef: any): void => {
            if (depth > MAX_DEPTH) return

            // Extract form inputs
            const inputs = Array.from(root.querySelectorAll(
              'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea'
            ) as NodeListOf<HTMLInputElement>)
              .filter(el => el.offsetParent !== null)
              .slice(0, 20)

            for (const el of inputs) {
              let label = selfRef[0](el, root)
              if (!label) label = el.getAttribute('aria-label') || ''
              if (!label) label = el.getAttribute('placeholder') || ''
              if (!label) label = el.getAttribute('name') || ''
              if (!label) continue

              const isRequired = el.required
                || el.hasAttribute('required')
                || el.getAttribute('aria-required') === 'true'

              fields.push({
                label: label.trim().slice(0, 80),
                tag: el.tagName.toLowerCase(),
                type: el.getAttribute('type') || 'text',
                placeholder: el.getAttribute('placeholder') || '',
                ariaLabel: el.getAttribute('aria-label') || '',
                name: el.getAttribute('name') || '',
                id: el.id || '',
                required: isRequired,
                isSelect: false,
                options: [],
              })
            }

            // Extract select / combobox elements
            const selects = Array.from(root.querySelectorAll(
              'select, [role="combobox"], [role="listbox"]'
            ) as NodeListOf<HTMLElement>)
              .filter(el => el.offsetParent !== null)
              .slice(0, 10)

            for (const el of selects) {
              let label = el.getAttribute('aria-label') || el.getAttribute('name') || ''
              if (!label) label = selfRef[0](el, root)
              if (!label) continue

              const isRequired = (el as HTMLSelectElement).required
                || el.hasAttribute('required')
                || el.getAttribute('aria-required') === 'true'

              const options = Array.from(el.querySelectorAll('option') as NodeListOf<HTMLOptionElement>)
                .map(o => o.innerText?.trim()).filter(Boolean).slice(0, 8)

              fields.push({
                label: label.trim().slice(0, 80),
                tag: el.tagName.toLowerCase(),
                type: 'select',
                placeholder: '',
                ariaLabel: el.getAttribute('aria-label') || '',
                name: el.getAttribute('name') || '',
                id: el.id || '',
                required: isRequired,
                isSelect: true,
                options,
              })
            }

            // Recurse into shadow roots of all elements
            const allElements = Array.from(root.querySelectorAll('*'))
            for (const el of allElements) {
              if ((el as HTMLElement).shadowRoot) {
                selfRef[1]((el as HTMLElement).shadowRoot as ShadowRoot, depth + 1, selfRef)
              }
            }
          }
        ]

        const scopeEl = opts.rootSel
          ? document.querySelector(opts.rootSel)
          : null
        helpers[1](scopeEl?.shadowRoot ?? document, 0, helpers)
        return fields
      }, { rootSel: rootSelector })
    } catch (err) {
      log.warn({ err }, '[CRAWLER] Shadow DOM extraction failed (non-fatal)')
      return []
    }
  }

  // ─── Overlay Detection ────────────────────────────────────────────────────────

  /**
   * Unified overlay detector: checks 12+ selectors for modals, dialogs, drawers,
   * and side-panels across all major component libraries.
   *
   * Priority order:
   *   1. ARIA-based (most reliable)
   *   2. Salesforce Lightning / SLDS
   *   3. Bootstrap 4/5
   *   4. Material UI / Ant Design
   *   5. Generic class-name patterns
   *
   * Returns the first visible overlay container found, or null.
   */
  static async _detectAndExtractOverlay(
    page: import('playwright').Page,
  ): Promise<{ found: boolean; element: import('playwright').Locator | null; overlayType: 'dialog' | 'drawer' | 'none' }> {
    const DIALOG_SELECTORS = [
      // ARIA (highest priority)
      '[role="dialog"]:visible',
      '[role="alertdialog"]:visible',
      '[aria-modal="true"]:visible',
      // Bootstrap modals
      '.modal.show .modal-dialog:visible',
      '.modal-dialog:visible',
      // Salesforce Lightning
      '.slds-modal:visible',
      '.slds-modal__container:visible',
      // Material UI
      '.MuiDialog-paper:visible',
      // Ant Design
      '.ant-modal-content:visible',
      // Generic
      '.dialog:visible',
      '.popup-content:visible',
      '[class*="modal-content"]:visible',
    ]

    const DRAWER_SELECTORS = [
      // Salesforce side panels / drawers
      '.slds-panel--docked:visible',
      '.slds-panel_docked:visible',
      '.slds-split-view__update-indicator:visible',
      // Bootstrap 5 offcanvas
      '.offcanvas.show:visible',
      // Material UI Drawer
      '.MuiDrawer-paper:visible',
      // Ant Design Drawer
      '.ant-drawer-open .ant-drawer-content:visible',
      // Generic class patterns
      '[class*="drawer"]:visible',
      '[class*="side-panel"]:visible',
      '[class*="slide-panel"]:visible',
      '[class*="sidepanel"]:visible',
    ]

    // Check dialog selectors first
    for (const sel of DIALOG_SELECTORS) {
      try {
        const loc = page.locator(sel).first()
        const count = await loc.count().catch(() => 0)
        if (count > 0 && await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          return { found: true, element: loc, overlayType: 'dialog' }
        }
      } catch { /* try next */ }
    }

    // Then check drawer selectors
    for (const sel of DRAWER_SELECTORS) {
      try {
        const loc = page.locator(sel).first()
        const count = await loc.count().catch(() => 0)
        if (count > 0 && await loc.isVisible({ timeout: 500 }).catch(() => false)) {
          return { found: true, element: loc, overlayType: 'drawer' }
        }
      } catch { /* try next */ }
    }

    return { found: false, element: null, overlayType: 'none' }
  }

  // ─── Overlay Metadata Extraction ──────────────────────────────────────────────

  /**
   * Extract all form fields from a detected overlay element.
   * Combines standard DOM extraction with Shadow DOM piercing for web components.
   *
   * @param overlayEl  — The Playwright Locator pointing to the overlay container
   * @param page       — The active page (for shadow DOM traversal)
   * @returns Extracted inputs, selects, buttons, and headings
   */
  static async _extractOverlayMetadata(
    overlayEl: import('playwright').Locator,
    page: import('playwright').Page,
  ): Promise<{
    inputs: ElementInfo[]
    selects: ElementInfo[]
    buttons: ElementInfo[]
    headings: string[]
  }> {
    const inputs: ElementInfo[] = []
    const selects: ElementInfo[] = []
    const buttons: ElementInfo[] = []
    const headings: string[] = []

    // ── Headings inside overlay ───────────────────────────────────────────
    try {
      const rawHeadings = await overlayEl.evaluate((el) =>
        Array.from(el.querySelectorAll('h1, h2, h3, h4, [class*="title"], [class*="header"]'))
          .map(h => (h as HTMLElement).innerText?.trim())
          .filter(Boolean)
          .slice(0, 5)
      ) as string[]
      headings.push(...rawHeadings)
    } catch { /* non-fatal */ }

    // ── Standard DOM inputs ───────────────────────────────────────────────
    try {
      const rawInputs = await overlayEl.evaluate((dialog) => {
        return Array.from(dialog.querySelectorAll(
          'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea'
        ) as NodeListOf<HTMLInputElement>)
          .filter(el => el.offsetParent !== null)
          .slice(0, 30)
          .map(el => {
            let label = ''
            let labelHasAsterisk = false
            if (el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) {
                label = lbl.innerText?.trim() || ''
                labelHasAsterisk = lbl.textContent?.includes('*') || false
              }
            }
            if (!label) {
              const ariaLabelledBy = el.getAttribute('aria-labelledby')
              if (ariaLabelledBy) {
                const lbl = document.getElementById(ariaLabelledBy)
                if (lbl) label = (lbl as HTMLElement).innerText?.trim() || ''
              }
            }
            if (!label) label = el.getAttribute('aria-label') || ''
            if (!label) label = el.getAttribute('placeholder') || ''
            if (!label) label = el.getAttribute('name') || ''
            const isRequired = el.required
              || el.hasAttribute('required')
              || el.getAttribute('aria-required') === 'true'
              || labelHasAsterisk
            return {
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type') || 'text',
              label,
              placeholder: el.getAttribute('placeholder') || '',
              ariaLabel: el.getAttribute('aria-label') || '',
              name: el.getAttribute('name') || '',
              testid: el.getAttribute('data-testid') || '',
              id: el.id || '',
              required: isRequired,
            }
          })
      })

      for (const raw of rawInputs) {
        const displayLabel = (raw.label || raw.ariaLabel || raw.placeholder || raw.name || '').slice(0, 80)
        if (!displayLabel) continue
        let locatorType = 'label'
        let locator = displayLabel
        if (raw.label)            { locatorType = 'label';       locator = raw.label.slice(0, 80) }
        else if (raw.ariaLabel)   { locatorType = 'label';       locator = raw.ariaLabel.slice(0, 80) }
        else if (raw.placeholder) { locatorType = 'placeholder'; locator = raw.placeholder.slice(0, 80) }
        else if (raw.testid)      { locatorType = 'testid';      locator = raw.testid }
        else if (raw.id)          { locatorType = 'css';         locator = `#${raw.id}` }
        else                      { locatorType = 'css';         locator = `input[name='${raw.name}']` }
        inputs.push({
          role: 'textbox', name: displayLabel, tag: raw.tag,
          locator_type: locatorType, locator,
          required: Boolean(raw.required),
        })
      }
    } catch { /* non-fatal */ }

    // ── Checkbox / radio inside overlay ──────────────────────────────────
    try {
      const cbRaw = await overlayEl.evaluate((dialog) =>
        Array.from(dialog.querySelectorAll('input[type=checkbox], input[type=radio]') as NodeListOf<HTMLInputElement>)
          .filter(el => el.offsetParent !== null)
          .slice(0, 10)
          .map(el => {
            let label = el.getAttribute('aria-label') || ''
            if (!label && el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) label = lbl.innerText?.trim() || ''
            }
            return { label, type: el.getAttribute('type') }
          })
      ) as Array<{ label: string; type: string | null }>

      for (const raw of cbRaw) {
        const name = (raw.label || '').slice(0, 80)
        if (!name) continue
        inputs.push({
          role: raw.type === 'checkbox' ? 'checkbox' : 'radio',
          name, tag: 'input', locator_type: 'label', locator: name, required: false,
        })
      }
    } catch { /* non-fatal */ }

    // ── Selects inside overlay ────────────────────────────────────────────
    try {
      const rawSelects = await overlayEl.evaluate((dialog) => {
        return Array.from(dialog.querySelectorAll(
          'select, [role="combobox"], [role="listbox"]'
        ) as NodeListOf<HTMLElement>)
          .filter(el => el.offsetParent !== null)
          .slice(0, 15)
          .map(el => {
            let label = el.getAttribute('aria-label') || el.getAttribute('name') || ''
            let labelHasAsterisk = false
            if (!label && el.id) {
              const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
              if (lbl) {
                label = lbl.innerText?.trim() || ''
                labelHasAsterisk = lbl.textContent?.includes('*') || false
              }
            }
            if (!label) {
              const ariaLabelledBy = el.getAttribute('aria-labelledby')
              if (ariaLabelledBy) {
                const lbl = document.getElementById(ariaLabelledBy)
                if (lbl) label = (lbl as HTMLElement).innerText?.trim() || ''
              }
            }
            const isRequired = (el as HTMLSelectElement).required
              || el.hasAttribute('required')
              || el.getAttribute('aria-required') === 'true'
              || labelHasAsterisk
            const options = Array.from(el.querySelectorAll('option') as NodeListOf<HTMLOptionElement>)
              .map(o => o.innerText?.trim()).filter(Boolean).slice(0, 8)
            return { label, options, tag: el.tagName.toLowerCase(), required: isRequired }
          })
      })

      for (const raw of rawSelects) {
        const locator = (raw.label || '').slice(0, 80)
        if (!locator) continue
        selects.push({
          role: 'combobox', name: locator, tag: raw.tag,
          locator_type: 'label', locator,
          required: Boolean(raw.required),
          options: raw.options.length > 0 ? raw.options : undefined,
        })
      }
    } catch { /* non-fatal */ }

    // ── Merge Shadow DOM fields (for web components like Salesforce LWC) ──
    // Only merge if the standard DOM extraction found < 3 fields (indicating
    // the form is likely inside shadow roots)
    if (inputs.length + selects.length < 3) {
      try {
        const overlayHandle = await overlayEl.elementHandle()
        if (overlayHandle) {
          const shadowFields = await page.evaluate((el) => {
            const MAX_DEPTH = 3
            const fields: Array<{
              label: string; tag: string; isSelect: boolean; required: boolean; options: string[]
            }> = []

            // Wrap in helpers array to prevent esbuild name-preservation wrapping inside Chromium
            const helpers: any[] = [
              (root: Element | ShadowRoot, depth: number, selfRef: any) => {
                if (depth > MAX_DEPTH) return
                const formEls = Array.from(root.querySelectorAll(
                  'input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select, [role="combobox"]'
                ) as NodeListOf<HTMLElement>)

                for (const fEl of formEls) {
                  if ((fEl as HTMLElement).offsetParent === null) continue
                  let label = (fEl as HTMLElement).getAttribute('aria-label')
                    || (fEl as HTMLElement).getAttribute('placeholder')
                    || (fEl as HTMLElement).getAttribute('name') || ''

                  const ariaLabelledBy = (fEl as HTMLElement).getAttribute('aria-labelledby')
                  if (!label && ariaLabelledBy) {
                    const lbl = ((root as unknown) as Document).getElementById?.(ariaLabelledBy)
                      ?? ((root as unknown) as Element).querySelector?.(`#${ariaLabelledBy}`)
                    if (lbl) label = (lbl as HTMLElement).innerText?.trim() || ''
                  }

                  if (!label) continue
                  const isSelect = fEl.tagName.toLowerCase() === 'select'
                    || fEl.getAttribute('role') === 'combobox'
                  const options = isSelect
                    ? Array.from(fEl.querySelectorAll('option') as NodeListOf<HTMLOptionElement>)
                        .map(o => o.innerText?.trim()).filter(Boolean).slice(0, 8)
                    : []

                  fields.push({
                    label: label.trim().slice(0, 80),
                    tag: fEl.tagName.toLowerCase(),
                    isSelect,
                    required: (fEl as HTMLInputElement).required
                      || fEl.hasAttribute('required')
                      || fEl.getAttribute('aria-required') === 'true',
                    options,
                  })
                }

                const children = Array.from(root.querySelectorAll('*'))
                for (const child of children) {
                  if ((child as HTMLElement).shadowRoot) {
                    selfRef[0]((child as HTMLElement).shadowRoot as ShadowRoot, depth + 1, selfRef)
                  }
                }
              }
            ]

            helpers[0](el as Element, 0, helpers)
            return fields
          }, overlayHandle)

          for (const sf of shadowFields) {
            const alreadyHas = inputs.some(i => i.name.toLowerCase() === sf.label.toLowerCase())
              || selects.some(s => s.name.toLowerCase() === sf.label.toLowerCase())
            if (alreadyHas) continue

            if (sf.isSelect) {
              selects.push({
                role: 'combobox', name: sf.label, tag: sf.tag,
                locator_type: 'label', locator: sf.label,
                required: sf.required,
                options: sf.options.length > 0 ? sf.options : undefined,
              })
            } else {
              inputs.push({
                role: 'textbox', name: sf.label, tag: sf.tag,
                locator_type: 'label', locator: sf.label,
                required: sf.required,
              })
            }
          }

          await overlayHandle.dispose()
        }
      } catch (shadowErr) {
        log.warn({ shadowErr }, '[CRAWLER] Shadow DOM merge in overlay failed (non-fatal)')
      }
    }

    // ── Buttons inside overlay ────────────────────────────────────────────
    try {
      const rawBtns = await overlayEl.evaluate((dialog) => {
        const elements = Array.from(dialog.querySelectorAll(
          'button, [role="button"], input[type="submit"], a[role="button"], [class*="btn"]:not(svg):not(script), [class*="button"]:not(svg):not(script)'
        ) as NodeListOf<HTMLElement>);
        return elements
          .filter(el => {
            if (el.offsetParent === null) return false;
            // Exclude rich-text editor toolbar items (e.g. Quill/TinyMCE buttons)
            if (el.closest('.ql-toolbar, .ql-snow, .tox-toolbar, .tox-editor-header, .editor-toolbar, [class*="ql-"], [class*="tox-"]')) {
              return false;
            }
            return true;
          })
          .slice(0, 100)
          .map(el => {
            let text = el.innerText || '';
            if (!text && el.tagName.toLowerCase() === 'input') {
              text = (el as HTMLInputElement).value || '';
            }
            return {
              text: text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim(),
              ariaLabel: el.getAttribute('aria-label') || '',
            };
          });
      }) as Array<{ text: string; ariaLabel: string }>

      for (const raw of rawBtns) {
        const name = (raw.ariaLabel || raw.text || '').slice(0, 80)
        if (!name) continue
        buttons.push({
          role: 'button', name, tag: 'button',
          locator_type: 'role', locator: `role=button, name=${name}`, required: false,
        })
      }
    } catch (btnErr) {
      log.warn({ btnErr }, '[CRAWLER] Overlay button extraction failed (non-fatal)')
    }

    return { inputs, selects, buttons, headings }
  }

  // ─── Popup Window Handler ─────────────────────────────────────────────────────

  /**
   * Handle a newly-opened popup window (new browser tab) triggered by a button click.
   * Crawls the popup page and returns its metadata as a synthetic 'popup' source page.
   *
   * @param popup     — The newly-opened Playwright Page (popup window)
   * @param parentUrl — URL of the parent page that triggered the popup
   * @param baseUrl   — App base URL for path normalization
   * @returns PageMetadata for the popup page, or null if crawl fails
   */
  static async _handlePopupWindow(
    popup: import('playwright').Page,
    parentUrl: string,
    baseUrl: string,
  ): Promise<PageMetadata | null> {
    try {
      await popup.waitForLoadState('domcontentloaded', { timeout: 15_000 })
      await popup.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
      await popup.waitForTimeout(1_000)

      const popupUrl = popup.url()
      log.info(`[CRAWLER] 🪟 Popup window detected: ${popupUrl}`)

      // Extract metadata from the popup using the same extraction logic
      const popupMeta = await WebMetadataService._visitPage(popup, popupUrl, baseUrl)
      if (popupMeta) {
        popupMeta.source = 'popup'
        popupMeta.is_modal = true
        popupMeta.modal_parent_url = parentUrl
        popupMeta.modal_depth = 1
        log.info(`[CRAWLER] ✅ Popup crawled: ${popupUrl} — ${popupMeta.inputs.length} inputs, ${popupMeta.buttons.length} buttons`)
      }

      // Close the popup window
      await popup.close().catch(() => {})
      return popupMeta
    } catch (err) {
      log.debug({ err }, '[CRAWLER] Popup window crawl failed (non-fatal)')
      await popup.close().catch(() => {})
      return null
    }
  }

  // ─── Modal Fingerprinting ─────────────────────────────────────────────────────

  /**
   * Compute a stable fingerprint for a modal form to avoid storing duplicates.
   * Two modals with the same trigger button label and same field labels are considered
   * duplicates even if triggered from different parent pages.
   *
   * @param triggerBtn — The button label that opened the modal
   * @param fields     — Sorted list of field label names inside the modal
   * @returns A short hash string for deduplication
   */
  static _computeModalFingerprint(triggerBtn: string, fields: string[]): string {
    const key = [triggerBtn.toLowerCase(), ...fields.sort()].join('|')
    // Simple djb2 hash for fingerprinting
    let hash = 5381
    for (let i = 0; i < key.length; i++) {
      hash = ((hash << 5) + hash) + key.charCodeAt(i)
      hash = hash & hash  // convert to 32-bit int
    }
    return Math.abs(hash).toString(36)
  }

  // ── Modal / Dialog / Drawer Form Discovery ────────────────────────────────────
  /**
   * Interactive crawl: after loading a page, click action buttons and detect
   * if they open modals, drawers, side panels, or popup windows.
   *
   * Key improvements over the original implementation:
   *   - Broader trigger pattern: Create/Add/New/Edit/Open/Manage/View/Upload
   *   - Clickable table row / card support
   *   - Popup window (new tab) handling via waitForPopup
   *   - Unified overlay detection (12+ selectors: dialog, drawer, side-panel)
   *   - Shadow DOM extraction for web components (Salesforce LWC, Polymer)
   *   - Progressive retry: wait 500ms, then 2000ms if no overlay found
   *   - Max depth guard: nested modal clicks limited to depth ≤ 2
   *   - Hash-based deduplication: same modal from multiple parent pages stored once
   *
   * @param page        — The active Playwright page (already on `parentUrl`)
   * @param parentMeta  — Metadata of the current page (its buttons are the candidates)
   * @param parentUrl   — The URL to re-navigate to after each button click
   * @param baseUrl     — App base URL (for path normalisation)
   * @param depth       — Current interaction depth (0=page-level, max 2)
   * @param seenFingerprints — Set of modal fingerprints already stored (deduplication)
   * @returns Array of synthetic PageMetadata records (one per discovered modal/drawer/popup)
   */
  static async _discoverModalForms(
    page: import('playwright').Page,
    parentMeta: PageMetadata,
    parentUrl: string,
    baseUrl: string,
    depth = 0,
    seenFingerprints = new Set<string>(),
  ): Promise<PageMetadata[]> {
    const MAX_MODAL_CLICKS   = 15   // cap per page — increased from 8 to capture more entity create-forms
    const MAX_DEPTH          = 2    // max nested modal levels
    const INITIAL_WAIT_MS    = 1_200 // initial wait after click — slightly longer for async SPAs
    const RETRY_WAIT_MS      = 2_000 // retry wait if no overlay found on first check
    const POST_DISMISS_MS    = 600
    const PER_PAGE_BUDGET_MS = 60_000 // increased from 45s → 60s to handle async-heavy SPAs

    if (depth > MAX_DEPTH) return []

    // ── Broad trigger pattern ────────────────────────────────────────────────
    // Matches ANY short button that starts with a common action verb or is a
    // well-known CRM entity-creation label. This is deliberately permissive —
    // false positives just fail silently without storing anything.
    // Broad trigger pattern — matches ANY button that starts with a common action verb.
    // Deliberately permissive — false positives just fail silently.
    // Includes logistics/CRM-specific verbs: convert, raise, generate, etc.
    const TRIGGER_RE = /^(?:[+\-\s•●▶]*)?(?:create|add|new|edit|open|manage|configure|upload|view\s+details?|convert(?:\s+to)?|start|book|schedule|generate|invite|raise|submit|record|log|send|assign|clone|duplicate|refresh|sync|register|process|issue|approve|reject|dispatch|ship|quote|enquire|order|purchase|receive)\b/i

    // Also match short generic single-word action verbs (standalone)
    // Extended with logistics domain verbs
    const GENERIC_TRIGGER_RE = /^(?:new|create|add|upload|import|book|edit|schedule|invite|log|quote|order|raise|issue|approve|dispatch|ship|receive|enquire|register|process)$/i

    // Words that look like entity names but aren't worth clicking
    const SKIP_ENTITY = new Set([
      'record', 'item', 'entry', 'another', 'new', 'more', 'here',
      'all', 'this', 'that', 'it', 'me', 'us',
    ])

    const modalPages: PageMetadata[] = []
    const triedButtons = new Set<string>()
    const pageStartMs = Date.now()

    // ── Proactive live-DOM re-scan of action buttons ────────────────────────
    // Re-query the DOM directly so we catch any buttons that loaded
    // asynchronously AFTER the initial page metadata was extracted.
    // This is more reliable than relying solely on parentMeta.buttons.
    let liveCandidateNames: string[] = []
    try {
      liveCandidateNames = await page.evaluate(
        (args: { triggerPattern: string; genericPattern: string }) => {
          const trigRe   = new RegExp(args.triggerPattern,  'i')
          const genericRe = new RegExp(args.genericPattern, 'i')

          // Restrict query root to active overlay (modal/dialog/drawer) if visible in DOM
          const NATIVE_OVERLAY_SELS = [
            '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
            '.modal.show', '.slds-modal', '.MuiDialog-paper',
            '.ant-modal-content', '[class*="modal-content"]',
            '[class*="drawer"]', '[class*="side-panel"]', '.offcanvas.show'
          ]
          let root: ParentNode = document
          for (const sel of NATIVE_OVERLAY_SELS) {
            const overlay = document.querySelector(sel) as HTMLElement | null
            if (overlay && (overlay.offsetWidth > 0 || overlay.offsetHeight > 0)) {
              root = overlay
              break
            }
          }

          const els = Array.from(
            root.querySelectorAll('button, [role="button"], input[type="submit"]') as NodeListOf<HTMLElement>
          ).filter(el => {
            if (el.offsetParent === null) return false
            // Exclude rich-text toolbar items
            if (el.closest('.ql-toolbar, .ql-snow, .tox-toolbar, .tox-editor-header, .editor-toolbar, [class*="ql-"], [class*="tox-"]')) return false
            const txt = ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim()
            return txt.length > 0 && txt.length <= 60 && (trigRe.test(txt) || genericRe.test(txt))
          })
          return els
            .slice(0, 12)
            .map(el => ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
        },
        { triggerPattern: TRIGGER_RE.source, genericPattern: GENERIC_TRIGGER_RE.source },
      ) as string[]
      if (liveCandidateNames.length > 0) {
        log.info(`[CRAWLER] 🔎 Live DOM scan found ${liveCandidateNames.length} action button(s) on ${parentUrl}: [${liveCandidateNames.slice(0, 5).join(' | ')}]`)
      }
    } catch (scanErr) {
      log.debug({ scanErr }, '[CRAWLER] Live DOM button scan failed (non-fatal)')
    }

    // ── Merge candidates: live DOM names + parentMeta buttons ───────────────
    // Build a deduplicated name list: live DOM takes priority (freshest),
    // followed by names from the already-captured parentMeta.buttons.
    const seenCandidateNames = new Set<string>()
    const candidateNames: string[] = []
    for (const name of [
      ...liveCandidateNames,
      ...parentMeta.buttons.filter(b => TRIGGER_RE.test(b.name ?? '') || GENERIC_TRIGGER_RE.test(b.name ?? '')).map(b => b.name ?? ''),
    ]) {
      const key = name.trim().toLowerCase()
      if (key && !seenCandidateNames.has(key)) {
        seenCandidateNames.add(key)
        candidateNames.push(name.trim())
      }
    }

    // Also include clickable row labels for drawer/detail-panel discovery
    const rowCandidates = parentMeta.buttons
      .filter(b => {
        const tag = (b.tag ?? '').toLowerCase()
        return (tag === 'tr' || tag.includes('row')) && !seenCandidateNames.has((b.name ?? '').toLowerCase())
      })
      .slice(0, 2)

    const allCandidates: string[] = [
      ...candidateNames.slice(0, MAX_MODAL_CLICKS),
      ...rowCandidates.map(b => b.name ?? ''),
    ]

    log.info(
      `[CRAWLER] 🔍 Modal discovery: ${allCandidates.length} candidate button(s) on ${parentUrl} ` +
      `(depth=${depth}, parentMeta.buttons=${parentMeta.buttons.length})`
    )

    if (allCandidates.length === 0) {
      log.info(`[CRAWLER] No modal-trigger buttons found on ${parentUrl} — skipping interactive crawl`)
      return []
    }

    for (const btnName of allCandidates) {
      // Check page-level time budget
      if (Date.now() - pageStartMs > PER_PAGE_BUDGET_MS) {
        log.debug(`[CRAWLER] Modal time budget exhausted on ${parentUrl} — stopping`)
        break
      }

      const cleanName = (btnName ?? '').trim()
      if (!cleanName || triedButtons.has(cleanName.toLowerCase())) continue
      triedButtons.add(cleanName.toLowerCase())

      // Derive entity name from the button label for synthetic URL building.
      // For broad matches, use the full button text as the entity slug.
      const entityMatch = cleanName.match(TRIGGER_RE)
      const entityName = entityMatch
        ? (entityMatch[1]?.trim() || cleanName)
        : (GENERIC_TRIGGER_RE.test(cleanName) ? cleanName : cleanName)
      if (!entityName || entityName.length < 2) continue
      // Skip known non-entity single words
      if (SKIP_ENTITY.has(entityName.toLowerCase())) continue

      log.info(`[CRAWLER] 🖱 Interactive attempt: clicking "${cleanName}" on ${parentUrl} (depth=${depth})`)

      let popupDetected = false
      let popupPage: import('playwright').Page | null = null

      try {
        // ── Click the button, racing against a popup window ──────────────
        const clickPromise = page.getByRole('button', { name: cleanName, exact: false })
          .first()
          .click({ timeout: 5_000 })
          .catch(() => {
            // Fallback 1: try clicking by exact text match
            return page.locator(`text="${cleanName}"`).first().click({ timeout: 3_000 }).catch(() => {
              // Fallback 2: partial text match inside any clickable element
              return page.locator(`button:has-text("${cleanName}"), [role="button"]:has-text("${cleanName}")`).
                first().click({ timeout: 3_000 }).catch(() => {})
            })
          })

        const popupPromise = page.waitForEvent('popup', { timeout: 3_000 })
          .then(p => { popupPage = p; popupDetected = true; return p })
          .catch(() => null)

        await Promise.all([clickPromise, Promise.race([popupPromise, page.waitForTimeout(3_000)])])

        // ── Handle popup window (new tab opened) ─────────────────────────
        if (popupDetected && popupPage) {
          log.info(`[CRAWLER] 🪟 Popup opened by "${btnName}" on ${parentUrl}`)
          const popupMeta = await WebMetadataService._handlePopupWindow(popupPage, parentUrl, baseUrl)
          if (popupMeta) {
            popupMeta.modal_trigger_button = btnName
            const fingerprint = WebMetadataService._computeModalFingerprint(
              btnName,
              [...popupMeta.inputs, ...popupMeta.selects].map(f => f.name),
            )
            if (!seenFingerprints.has(fingerprint)) {
              seenFingerprints.add(fingerprint)
              modalPages.push(popupMeta)
            }
          }
          // After popup handling, restore main page state
          await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
          continue
        }

        // ── Wait for overlay (progressive retry with waitForFunction) ─────
        // Stage 1: Short initial wait then check
        await page.waitForTimeout(INITIAL_WAIT_MS)
        let overlayResult = await WebMetadataService._detectAndExtractOverlay(page)

        // Stage 2: If no overlay yet, use waitForFunction to poll until ANY
        // dialog/modal/drawer selector appears, then do a final settle wait.
        if (!overlayResult.found) {
          try {
            await page.waitForFunction(
              () => {
                const OVERLAY_SELS = [
                  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
                  '.modal.show', '.slds-modal', '.MuiDialog-paper',
                  '.ant-modal-content', '[class*="modal-content"]',
                  '[class*="drawer"]', '[class*="side-panel"]', '.offcanvas.show',
                ]
                for (const sel of OVERLAY_SELS) {
                  const el = document.querySelector(sel) as HTMLElement | null
                  if (el && el.offsetParent !== null) return true
                }
                return false
              },
              { timeout: RETRY_WAIT_MS },
            )
            // Found! Give it an extra micro-settle before extracting
            await page.waitForTimeout(500)
          } catch {
            // Overlay still not found — keep going, the subsequent check handles it
          }
          overlayResult = await WebMetadataService._detectAndExtractOverlay(page)
        }

        // Stage 3: If overlay is found, wait for it to render meaningful content
        if (overlayResult.found) {
          try {
            await page.waitForFunction(
              () => {
                const OVERLAY_SELS = [
                  '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
                  '.modal.show .modal-dialog', '.slds-modal', '.MuiDialog-paper',
                  '.ant-modal-content', '[class*="modal-content"]',
                  '[class*="drawer"]', '[class*="side-panel"]',
                ]
                for (const sel of OVERLAY_SELS) {
                  const overlay = document.querySelector(sel) as HTMLElement | null
                  if (!overlay || overlay.offsetParent === null) continue
                  // Count interactive elements inside the overlay
                  const fields = overlay.querySelectorAll(
                    'input:not([type=hidden]):not([type=submit]):not([type=button]), ' +
                    'textarea, select, [role="combobox"], button, [role="button"]'
                  )
                  const visible = Array.from(fields).filter(el => (el as HTMLElement).offsetParent !== null)
                  if (visible.length >= 1) return true
                }
                return false
              },
              { timeout: 5_000 },
            )
            log.debug(`[CRAWLER] Overlay content stabilized for "${cleanName}" on ${parentUrl}`)
          } catch {
            log.debug(`[CRAWLER] Overlay content stabilization timed out for "${cleanName}" — extracting anyway`)
          }
        }

        if (!overlayResult.found || !overlayResult.element) {  // eslint-disable-line
          // Check if button caused a full-page navigation (URL changed)
          const currentUrl = page.url()
          const navigatedAway = !currentUrl.replace(/[?#].*$/, '').endsWith(
            new URL(parentUrl).pathname.replace(/\/+$/, '')
          ) && currentUrl !== parentUrl

          if (navigatedAway) {
            // ── "Edit X" navigated to a real page: store BOTH the nav page AND
            // any dialog that may be open on that new page before going back. ──
            log.info(`[CRAWLER] "${btnName}" navigated to ${currentUrl} — extracting that page + checking for overlay`)

            try {
              // Step A: Wait for the navigated page to stabilise
              await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {})
              await page.waitForTimeout(800)

              // Step B: Extract metadata from the navigated page and add it to results
              const navPageMeta = await WebMetadataService._extractPageContent(page, baseUrl)
              if (navPageMeta) {
                navPageMeta.source = 'playwright'
                navPageMeta.modal_trigger_button = btnName   // record what opened it
                navPageMeta.modal_parent_url = parentUrl
                // Only store if not already visited
                if (!seenFingerprints.has(`nav:${currentUrl}`) &&
                    !modalPages.some(p => p.url === navPageMeta.url)) {
                  seenFingerprints.add(`nav:${currentUrl}`)
                  modalPages.push(navPageMeta)
                  log.info(`[CRAWLER] ✅ Nav-page stored from "${btnName}": ${currentUrl} (${navPageMeta.inputs.length} inputs)`)
                }

                // Step C: Check if that navigated page ALSO has an open dialog
                const navOverlay = await WebMetadataService._detectAndExtractOverlay(page)
                if (navOverlay.found && navOverlay.element) {
                  log.info(`[CRAWLER] 🗂 Dialog found on navigated page ${currentUrl} — extracting overlay`)
                  const navExtracted = await WebMetadataService._extractOverlayMetadata(navOverlay.element, page)
                  const { inputs: ni, selects: ns, buttons: nb, headings: nh } = navExtracted

                  if (ni.length > 0 || ns.length > 0) {
                    const navPath = new URL(currentUrl).pathname.replace(/\/+$/, '') || '/'
                    const entitySlug = entityName.toLowerCase().replace(/\s+/g, '-')
                    const syntheticPath = `${navPath}/__modal__/${entitySlug}`
                    const syntheticUrl  = baseUrl.replace(/\/+$/, '') + syntheticPath
                    const fp = WebMetadataService._computeModalFingerprint(btnName, [...ni, ...ns].map(f => f.name))
                    if (!seenFingerprints.has(fp)) {
                      seenFingerprints.add(fp)
                      const headingText = nh.length > 0 ? nh[0] : entityName
                      modalPages.push({
                        url: syntheticUrl, path: syntheticPath,
                        title: `${headingText} (Modal Form — from ${navPath})`,
                        headings: nh.length > 0 ? nh : [entityName],
                        buttons: nb, links: [], inputs: ni, selects: ns,
                        testids: [], navigation_items: [],
                        source: 'modal', is_modal: true, modal_depth: depth + 1,
                        modal_trigger_button: btnName, modal_parent_url: currentUrl,
                      })
                      log.info(`[CRAWLER] ✅ Overlay on nav-page stored: "${entityName}" (${ni.length} inputs)`)
                    }
                  }
                }
              }
            } catch (navErr) {
              log.debug({ navErr }, `[CRAWLER] Nav-page extraction failed for "${btnName}" (non-fatal)`)
            }
          } else {
            log.debug(`[CRAWLER] No overlay appeared after clicking "${btnName}" — skipping`)
          }

          // Re-navigate back to restore crawl state
          await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
          continue
        }

        const overlayType = overlayResult.overlayType
        log.info(
          `[CRAWLER] 🗂 ${overlayType === 'drawer' ? 'Drawer' : 'Dialog'} detected ` +
          `after clicking "${cleanName}" on ${parentUrl} — extracting metadata`
        )

        // ── Extract all form fields from the overlay ──────────────────────
        const extracted = await WebMetadataService._extractOverlayMetadata(
          overlayResult.element,
          page,
        )

        const { inputs: modalInputs, selects: modalSelects, buttons: modalButtons, headings: modalHeadings } = extracted

        // ── Compute fingerprint for deduplication ─────────────────────────
        const allFieldNames = [...modalInputs, ...modalSelects].map(f => f.name)
        if (allFieldNames.length > 0) {
          const fingerprint = WebMetadataService._computeModalFingerprint(cleanName, allFieldNames)
          if (seenFingerprints.has(fingerprint)) {
            log.debug(`[CRAWLER] Duplicate modal fingerprint for "${cleanName}" — skipping`)
            await page.keyboard.press('Escape').catch(() => {})
            await page.waitForTimeout(POST_DISMISS_MS)
            await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
            await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
            continue
          }
          seenFingerprints.add(fingerprint)
        }

        // ── Store if the overlay has meaningful content ───────────────────
        if (modalInputs.length > 0 || modalSelects.length > 0) {
          const parentPath = new URL(parentUrl).pathname.replace(/\/+$/, '') || '/'
          const entitySlug = entityName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
          const syntheticPath = `${parentPath}/__modal__/${entitySlug || 'form'}`
          const syntheticUrl  = baseUrl.replace(/\/+$/, '') + syntheticPath

          const headingText = modalHeadings.length > 0 ? modalHeadings[0] : entityName

          const modalPage: PageMetadata = {
            url:                  syntheticUrl,
            path:                 syntheticPath,
            title:                `${headingText} (${overlayType === 'drawer' ? 'Drawer' : 'Modal'} Form)`,
            headings:             modalHeadings.length > 0 ? modalHeadings : [entityName],
            buttons:              modalButtons,
            links:                [],
            inputs:               modalInputs,
            selects:              modalSelects,
            testids:              [],
            navigation_items:     [],
            source:               'modal',
            is_modal:             true,
            modal_depth:          depth + 1,
            modal_trigger_button: cleanName,
            modal_parent_url:     parentUrl,
            ...(overlayType === 'drawer' ? { drawer_trigger_button: cleanName } : {}),
          }
          modalPages.push(modalPage)
          log.info(
            `[CRAWLER] ✅ ${overlayType === 'drawer' ? 'Drawer' : 'Modal'} form saved: "${entityName}" — ` +
            `${modalInputs.length} inputs, ${modalSelects.length} selects, ` +
            `${modalButtons.length} buttons (depth=${depth + 1}) — triggered by "${cleanName}" on ${parentUrl}`
          )

          // ── Nested modal discovery (depth-limited) ────────────────────
          // If this modal has buttons that could open nested dialogs,
          // attempt nested modal discovery (only if depth < MAX_DEPTH).
          if (depth < MAX_DEPTH - 1 && modalButtons.length > 0) {
            const nestedMeta: PageMetadata = { ...modalPage, buttons: modalButtons }
            const nestedModals = await WebMetadataService._discoverModalForms(
              page, nestedMeta, syntheticUrl, baseUrl, depth + 1, seenFingerprints
            ).catch(() => [])
            modalPages.push(...nestedModals)
          }
        } else {
          log.debug(`[CRAWLER] Overlay opened but no form fields found for "${cleanName}"`)
        }
      } catch (err) {
        log.debug({ err, btnName: cleanName }, '[CRAWLER] Interactive attempt failed (non-fatal)')
      } finally {
        // ALWAYS restore page state: dismiss overlay + return to parent URL
        try {
          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(POST_DISMISS_MS)
          // Click any visible close button as a backup (some modals ignore Escape)
          await page.locator('[aria-label="Close"], [aria-label="close"], button:has-text("Cancel"), button:has-text("Close")').first().click({ timeout: 1_500 }).catch(() => {})
          await page.waitForTimeout(300)
          const currentUrl = page.url()
          const isSamePage = currentUrl.replace(/[?#].*$/, '') === parentUrl.replace(/[?#].*$/, '')
            || currentUrl.startsWith(parentUrl)
          if (!isSamePage) {
            log.debug(`[CRAWLER] Re-navigating from ${currentUrl} back to ${parentUrl}`)
          }
          await page.goto(parentUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
          await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
          // Re-stabilize: wait for action buttons to re-appear before next click attempt
          await page.waitForFunction(
            () => {
              const btns = document.querySelectorAll('button, [role="button"]')
              return Array.from(btns).filter(el => (el as HTMLElement).offsetParent !== null).length >= 3
            },
            { timeout: 6_000 },
          ).catch(() => {})
        } catch { /* non-fatal */ }
      }
    }

    return modalPages
  }

  // ── Public helper aliases ────────────────────────────────────────────────────

  /**
   * Convenience alias: stabilise a page that has already been navigated to.
   * Calls _waitForPageStabilization with sensible merged config.
   */
  static async stabilizePage(
    page: import('playwright').Page,
    pageUrl: string,
    config?: StabilizationConfig,
  ): Promise<{ stageReached: number; elementCount: number }> {
    const merged: Required<StabilizationConfig> = {
      ...DEFAULT_STABILIZATION,
      ...(config ?? {}),
    }
    return WebMetadataService._waitForPageStabilization(page, merged, pageUrl)
  }

  /**
   * Convenience alias: discover modals/drawers triggered by action buttons on
   * a page that has already been crawled (`parentMeta` must be populated).
   *
   * Uses a fresh run-level fingerprint set — pass your own Set to share dedup
   * state across multiple invocations on the same crawl run.
   */
  static async extractModals(
    page: import('playwright').Page,
    parentMeta: PageMetadata,
    parentUrl: string,
    baseUrl: string,
    seenFingerprints?: Set<string>,
  ): Promise<PageMetadata[]> {
    return WebMetadataService._discoverModalForms(
      page,
      parentMeta,
      parentUrl,
      baseUrl,
      0,
      seenFingerprints ?? new Set<string>(),
    )
  }

  static buildContextString(result: { base_url: string; pages: PageMetadata[] }): string {
    if (result.pages.length === 0) return '(No pages crawled)'

    const lines: string[] = [
      `=== WEB APP METADATA (crawled from ${result.base_url}) ===`,
      `Total pages crawled: ${result.pages.length}`,
      '',
    ]

    for (const pm of result.pages) {
      lines.push(`--- PAGE: ${pm.path || pm.url} ---`)
      if (pm.title)    lines.push(`  Title: ${pm.title}`)
      if (pm.headings.length) lines.push(`  Headings: ${pm.headings.slice(0, 5).join(', ')}`)

      if (pm.buttons.length) {
        // Find submit buttons to highlight them for the post-processor and LLM
        const submitBtns = pm.buttons.filter(b => {
          const n = String(b.name || b.locator || '').toLowerCase()
          return n.includes('create') || n.includes('save') || n.includes('submit') || n.includes('add')
        })

        if (submitBtns.length > 0) {
          lines.push('  Submit Buttons (use for CLICK step after filling all fields):')
          for (const btn of submitBtns.slice(0, 3)) {
            const btnName = String(btn.name || btn.locator || '').replace(/role=button,\s*name=/i, '').trim()
            if (btnName) {
              lines.push(`    ⚡ BUTTON NAME: "${btnName}"  →  Use this EXACT name as target for the CLICK step  (locator_type: "role")`)
            }
          }
        }

        lines.push('  All Buttons (use locator_type=\'role\'):')
        for (const btn of pm.buttons.slice(0, 15)) lines.push(`    • ${btn.locator}  [${btn.name}]`)
      }

      // ── Navigation Menu Items ─────────────────────────────────────────────
      // These are the sidebar/topnav items extracted from <nav> / [role="navigation"].
      // ALWAYS use the locator shown here (role=link/menuitem) for CLICK navigation steps.
      // NEVER use text= for these items — it matches inner <span> elements that are not clickable.
      if (pm.navigation_items && pm.navigation_items.length > 0) {
        lines.push('  🧭 NAVIGATION MENU ITEMS (sidebar/topnav — use the locator shown EXACTLY):')
        for (const ni of pm.navigation_items.slice(0, 20)) {
          const href = ni.href ? `  [href: ${new URL(ni.href).pathname}]` : ''
          lines.push(`    → "${ni.text}"  locator: "${ni.locator}"  locator_type: "role"${href}`)
        }
        lines.push('    ⚠️ RULE: For CLICK steps targeting any item above, set locator_type: "role" and copy the locator EXACTLY.')
      }

      const reqInputs = pm.inputs.filter((i) => i.required)
      const optInputs = pm.inputs.filter((i) => !i.required)
      if (reqInputs.length) {
        lines.push('  ⚠ MANDATORY Form Fields (MUST fill these when creating a record):')
        for (const inp of reqInputs.slice(0, 20)) lines.push(`    • [REQUIRED] [${inp.locator_type}] ${inp.locator}  (tag=${inp.tag})`)
      }
      if (optInputs.length) {
        lines.push('  Optional Form Fields:')
        for (const inp of optInputs.slice(0, 15)) lines.push(`    • [${inp.locator_type}] ${inp.locator}  (tag=${inp.tag})`)
      }

      if (pm.selects.length) {
        lines.push('  Dropdowns/Selects:')
        for (const sel of pm.selects.slice(0, 10)) lines.push(`    • [${sel.locator_type}] ${sel.locator}`)
      }

      if (pm.testids.length) lines.push(`  data-testid values: ${pm.testids.slice(0, 10).join(', ')}`)
      lines.push('')
    }

    lines.push('=== END OF WEB APP METADATA ===')
    return lines.join('\n')
  }
}
