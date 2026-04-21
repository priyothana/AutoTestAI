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
  source?: 'sitemap' | 'playwright'
  crawl_depth?: number
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
   * Restored CrawlState from DB — passed on continuation runs.
   * If undefined, this is the first run and state is seeded fresh.
   */
  initialState?: CrawlState
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function normalizeUrl(url: string, baseUrl: string): string | null {
  try {
    const baseParsed = new URL(baseUrl)
    const parsed = new URL(url, baseUrl)

    if (parsed.origin !== baseParsed.origin) return null
    if (!['http:', 'https:'].includes(parsed.protocol)) return null

    return parsed.origin + parsed.pathname
  } catch {
    return null
  }
}

// ─── Crawler ──────────────────────────────────────────────────────────────────

export class WebMetadataService {
  
  /**
   * Fetch and parse an XML sitemap into a list of URLs.
   * Recursively handles sitemap index files up to depth 2.
   */
  static async detectAndFetchSitemap(baseUrl: string, customSitemapUrl?: string, depth = 0): Promise<string[]> {
    if (depth > 2) return []

    const targetUrl = customSitemapUrl || baseUrl.replace(/\/$/, '') + '/sitemap.xml'
    log.info(`[CRAWLER] Checking sitemap at ${targetUrl} (depth ${depth})`)

    try {
      const response = await fetch(targetUrl, { signal: AbortSignal.timeout(10000) })
      if (!response.ok) return []

      const xmlText = await response.text()
      const locRegex = /<loc>(.*?)<\/loc>/g
      const matches = [...xmlText.matchAll(locRegex)]
      
      const results: string[] = []
      
      for (const match of matches) {
        const loc = match[1].trim()
        if (loc.endsWith('.xml') && depth < 2) {
          // It's a sitemap index
          const childUrls = await WebMetadataService.detectAndFetchSitemap(baseUrl, loc, depth + 1)
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
      initialState,
    } = options

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

      // 1. Sitemap discovery
      const sitemapUrls = await WebMetadataService.detectAndFetchSitemap(baseUrl, sitemapUrl)
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

      const context = authSessionPath
        ? await (async () => {
            try {
              const ctx = await browser!.newContext({ storageState: authSessionPath })
              log.info(`[CRAWLER] Loaded auth session from ${authSessionPath}`)
              return ctx
            } catch {
              log.warn('[CRAWLER] Failed to load auth session — starting fresh context')
              return browser!.newContext()
            }
          })()
        : await browser.newContext()

      const page = await context.newPage()
      page.setDefaultTimeout(20_000)
      page.setDefaultNavigationTimeout(30_000)

      let pagesCrawled = 0
      const isFirstRun = !isContinuation

      for (const url of toVisitThisRun) {
        if (visitedUrls.has(url)) {
          log.debug(`[CRAWLER] Skipping already-visited: ${url}`)
          continue
        }

        try {
          const source: 'sitemap' | 'playwright' = 'playwright'
          const pageMeta = await WebMetadataService._visitPage(
            page, url, baseUrl, credentials,
            pagesCrawled === 0 && isFirstRun  // only attempt login on very first page
          )

          if (pageMeta) {
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

  static async _visitPage(
    page: import('playwright').Page,
    url: string,
    baseUrl: string,
    credentials?: { username: string; password: string },
    isFirstPage = false,
  ): Promise<PageMetadata | null> {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
    } catch (err) {
      log.warn({ err }, `[CRAWLER] Navigation failed for ${url}`)
      return null
    }

    if (isFirstPage && credentials) {
      try {
        const pwdField = page.locator('input[type="password"]')
        const pwdCount = await pwdField.count()
        if (pwdCount > 0 && await pwdField.first().isVisible()) {
          log.info('[CRAWLER] Login page detected — performing auto-login')

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

          await pwdField.first().fill(credentials.password)

          for (const name of ['Log In', 'Login', 'Sign In', 'Submit', 'Sign in']) {
            try {
              const btn = page.getByRole('button', { name, exact: false })
              if (await btn.count() > 0) {
                await btn.first().click({ timeout: 5_000 })
                break
              }
            } catch { /* try next */ }
          }

          await page.waitForTimeout(2_000)
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
        }
      } catch (loginErr) {
        log.debug({ loginErr }, '[CRAWLER] Login check error (non-fatal)')
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

    try {
      const buttonsRaw = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]') as NodeListOf<HTMLElement>)
          .filter((el) => el.offsetParent !== null)
          .slice(0, 25)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            text: ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || el.getAttribute('aria-label') || '').trim(),
            ariaLabel: el.getAttribute('aria-label') || '',
            testid: el.getAttribute('data-testid') || '',
          }))
      ) as Array<{ tag: string; text: string; ariaLabel: string; testid: string }>

      for (const raw of buttonsRaw) {
        const name = (raw.ariaLabel || raw.text || '').slice(0, 80)
        if (!name) continue
        meta.buttons.push({
          role: 'button', name, tag: raw.tag,
          locator_type: 'role', locator: `role=button, name=${name}`, required: false,
        })
        if (raw.testid) meta.testids.push(raw.testid)
      }
    } catch (err) { log.debug({ err }, '[CRAWLER] Button extraction failed') }

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

    return meta
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
