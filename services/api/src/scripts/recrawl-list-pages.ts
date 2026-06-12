/**
 * recrawl-list-pages.ts
 *
 * Universal fix: Recrawl ALL entity list pages with authenticated session,
 * extract actual "+New X" action buttons, and update metadata_canonical
 * with correct open_button values for every entity.
 *
 * Key insight: The CRM uses multi-line button innerText.
 *   e.g.  text="+"  fullText="+\nNew Lead"
 *   We must use fullText (joined), not just the first line.
 *
 * Run: npx tsx src/scripts/recrawl-list-pages.ts [projectId]
 *
 * If no projectId is supplied it processes ALL web_app projects.
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import prisma from '../shared/db/prisma.js'
import { fernetDecrypt } from '../shared/encryption/fernet.js'
import { createModuleLogger } from '../shared/logger/index.js'

const log = createModuleLogger('recrawl-list-pages')

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawButton {
  singleLine: string   // first line of innerText
  fullText:   string   // full innerText (all lines joined with space)
  ariaLabel:  string
  tag:        string
  className:  string
}

interface PageScanResult {
  path:             string
  url:              string
  entityName:       string
  openButton:       string | null   // "+New Lead" — to click on list page
  submitButton:     string | null   // "Create Lead" — to click inside form
  allRawButtons:    RawButton[]
}

// ─── Helper: normalise button display text ───────────────────────────────────

/**
 * Given a raw button's singleLine + fullText, returns the best human-readable label.
 * For multi-line buttons like "+\nNew Lead", returns "+ New Lead".
 */
function normaliseBtnText(btn: RawButton): string {
  const full = btn.fullText.trim()
  const aria  = btn.ariaLabel.trim()

  // Prefer aria-label if present and meaningful
  if (aria.length > 0 && aria.length < 60) return aria

  // Collapse newlines into spaces and clean up whitespace
  const collapsed = full.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
  return collapsed.slice(0, 80)
}

// ─── Helper: classify a normalised button name ────────────────────────────────

function classifyBtn(
  normName: string,
  entityName: string,
): 'open' | 'submit' | 'nav' | 'other' {
  const n     = normName.toLowerCase()
  const eName = entityName.toLowerCase()

  // Skip pure nav sidebar items by class name check (handled elsewhere)
  if (n.length > 60) return 'nav'

  // "Open form" patterns — check collapsed multi-line text
  // "+ New Lead", "+New Lead", "New Lead", "Add Lead"
  const isOpenPattern = /^\+?\s*new\s+\S/i.test(normName) ||
                        /^\+\s*\S/i.test(normName) ||  // starts with + followed by anything
                        /^add\s+\S/i.test(normName)

  if (isOpenPattern) {
    // If it mentions the entity → definite open button
    if (n.includes(eName) || eName.includes(n.replace(/[^a-z]/g, ''))) return 'open'
    // Generic "+/New/Add" without entity word — still likely open
    return 'open'
  }

  // "Submit form" patterns
  if (/\b(create|save|submit)\b/i.test(normName) && !/^\+/.test(normName.trim())) return 'submit'

  return 'other'
}

// ─── Helper: check if button is a sidebar nav item ───────────────────────────

function isNavButton(btn: RawButton): boolean {
  const cls = btn.className.toLowerCase()
  return cls.includes('nav-item') || cls.includes('nav-subitem') || cls.includes('nav-accordion')
}

// ─── Core: scan a single page ────────────────────────────────────────────────

async function scanPage(
  page: import('playwright').Page,
  url: string,
  entityName: string,
): Promise<PageScanResult | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => {})
    await page.waitForTimeout(1500)
  } catch {
    log.warn(`[RECRAWL] Navigation failed for ${url}`)
    return null
  }

  const currentUrl = page.url()
  const path = new URL(currentUrl).pathname

  // Detect login redirect
  if (await page.locator('input[type="password"]').count() > 0) {
    log.warn(`[RECRAWL] ⚠ Login redirect at ${url}`)
    return null
  }

  // Extract all visible buttons with FULL multi-line text
  const rawButtons: RawButton[] = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll(
        'button, [role="button"], a[role="button"], input[type="submit"], input[type="button"]'
      ) as NodeListOf<HTMLElement>
    ).filter(el => el.offsetParent !== null)

    return els.slice(0, 80).map(el => ({
      singleLine: ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '').split('\n')[0].trim(),
      fullText:   ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '').trim(),
      ariaLabel:  el.getAttribute('aria-label') || '',
      tag:        el.tagName,
      className:  (el.className || '').toString().slice(0, 120),
    }))
  }) as RawButton[]

  // Filter out nav buttons
  const actionBtns = rawButtons.filter(b => !isNavButton(b))

  let openButton:   string | null = null
  let submitButton: string | null = null

  for (const btn of actionBtns) {
    const normName = normaliseBtnText(btn)
    if (!normName) continue

    const cls = classifyBtn(normName, entityName)
    if (cls === 'open' && !openButton) {
      openButton = normName
    } else if (cls === 'submit' && !submitButton) {
      submitButton = normName
    }
  }

  log.info(
    `[RECRAWL] ${path} → entity="${entityName}" open="${openButton}" submit="${submitButton}" ` +
    `buttons=${rawButtons.length} (non-nav: ${actionBtns.length})`,
  )

  // Debug: log the non-nav button texts so we can see what was found
  const nonNavNames = actionBtns.slice(0, 15).map(b => normaliseBtnText(b)).filter(Boolean)
  log.info(`[RECRAWL] Non-nav buttons: ${JSON.stringify(nonNavNames)}`)

  return { path, url: currentUrl, entityName, openButton, submitButton, allRawButtons: rawButtons }
}

// ─── Core: attempt login ─────────────────────────────────────────────────────

async function attemptLogin(
  page: import('playwright').Page,
  baseUrl: string,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})

    for (const sel of ['input[type="email"]', 'input[name="username"]', 'input[name="email"]', 'input[type="text"]']) {
      const f = page.locator(sel).first()
      if (await f.isVisible({ timeout: 1_000 }).catch(() => false)) {
        await f.fill(username)
        break
      }
    }
    await page.locator('input[type="password"]').first().fill(password)

    for (const name of ['Log In', 'Login', 'Sign In', 'Submit']) {
      const btn = page.getByRole('button', { name, exact: false })
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 5_000 })
        break
      }
    }

    await page.waitForTimeout(3_000)
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})

    if (await page.locator('input[type="password"]').count() > 0) {
      log.error('[RECRAWL] ❌ Login FAILED — still on login page')
      return false
    }

    log.info(`[RECRAWL] ✅ Login succeeded — now at ${page.url()}`)
    return true
  } catch (err) {
    log.error({ err }, '[RECRAWL] Login error')
    return false
  }
}

// ─── Core: update canonical record ───────────────────────────────────────────

async function updateCanonicalButtons(
  projectId:    string,
  entityName:   string,
  openButton:   string | null,
  submitButton: string | null,
): Promise<void> {
  try {
    const existing = await prisma.metadata_canonical.findFirst({
      where: {
        project_id:  projectId,
        entity_name: { equals: entityName, mode: 'insensitive' },
      },
      select: { id: true, learned_rules: true, all_buttons: true },
    })

    if (!existing) {
      log.warn(`[RECRAWL] No canonical record for "${entityName}" — skipping`)
      return
    }

    const existingRules = (existing.learned_rules ?? {}) as Record<string, unknown>
    const updatedRules: Record<string, unknown> = { ...existingRules }

    if (openButton) {
      updatedRules.open_button = openButton
    } else if (!updatedRules.open_button) {
      // Synthesise fallback if nothing was found
      updatedRules.open_button = `+New ${entityName}`
    }

    await (prisma as any).$executeRaw`
      UPDATE metadata_canonical
      SET
        learned_rules  = ${JSON.stringify(updatedRules)}::jsonb,
        last_synced_at = now()
      WHERE id = ${existing.id}::uuid
    `

    log.info(
      `[RECRAWL] ✓ "${entityName}": open_button = "${updatedRules.open_button}"`,
    )
  } catch (err) {
    log.warn({ err }, `[RECRAWL] Failed to update "${entityName}"`)
  }
}

// ─── Main: per-project recrawl ────────────────────────────────────────────────

async function recrawlProject(projectId: string): Promise<void> {
  log.info(`[RECRAWL] ▶ Starting for project ${projectId}`)

  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'web_app' },
  })
  if (!integration) {
    log.warn(`[RECRAWL] No web_app integration for ${projectId}`)
    return
  }

  const baseUrl = (integration.base_url ?? '').replace(/\/$/, '')
  if (!baseUrl) { log.warn('[RECRAWL] No base_url'); return }

  let username = integration.username ?? ''
  let password = integration.password ?? ''
  try { username = fernetDecrypt(username) } catch { /* plaintext */ }
  try { password = fernetDecrypt(password) } catch { /* plaintext */ }

  // ── Load canonical entities ───────────────────────────────────────────────
  const canonicalEntities = await prisma.metadata_canonical.findMany({
    where:  { project_id: projectId },
    select: { entity_name: true, page_url: true },
  })

  if (canonicalEntities.length === 0) {
    log.warn(`[RECRAWL] No canonical records — run metadata sync first`)
    return
  }

  // ── Build pages to scan ───────────────────────────────────────────────────
  // Always include common CRM list pages — these are where "+New X" buttons live
  const COMMON_ENTITY_SLUGS: Array<{ entity: string; slug: string }> = [
    { entity: 'Lead',        slug: 'leads' },
    { entity: 'Account',     slug: 'accounts' },
    { entity: 'Contact',     slug: 'contacts' },
    { entity: 'Opportunity', slug: 'opportunities' },
    { entity: 'Campaign',    slug: 'campaigns' },
    { entity: 'Contract',    slug: 'contracts' },
    { entity: 'Order',       slug: 'orders' },
    { entity: 'Invoice',     slug: 'invoices' },
    { entity: 'Quote',       slug: 'quotes' },
    { entity: 'Product',     slug: 'products' },
  ]

  const pagesToScan: Array<{ url: string; entity: string; pageType: 'list' | 'form' }> = []
  const seenUrls = new Set<string>()

  for (const { entity, slug } of COMMON_ENTITY_SLUGS) {
    const listUrl = `${baseUrl}/${slug}`
    const formUrl = `${baseUrl}/${slug}/create`
    if (!seenUrls.has(listUrl)) { pagesToScan.push({ url: listUrl, entity, pageType: 'list' }); seenUrls.add(listUrl) }
    if (!seenUrls.has(formUrl)) { pagesToScan.push({ url: formUrl, entity, pageType: 'form' }); seenUrls.add(formUrl) }
  }

  // Also add any canonical entities not in the common list
  for (const ent of canonicalEntities) {
    const eName = ent.entity_name
    if (!eName || eName.toLowerCase() === 'home') continue
    if (COMMON_ENTITY_SLUGS.some(e => e.entity.toLowerCase() === eName.toLowerCase())) continue

    const slug    = eName.toLowerCase().replace(/\s+/g, '-') + 's'
    const listUrl = `${baseUrl}/${slug}`
    if (!seenUrls.has(listUrl)) {
      pagesToScan.push({ url: listUrl, entity: eName, pageType: 'list' })
      seenUrls.add(listUrl)
    }
    if (ent.page_url) {
      const formUrl = `${baseUrl}${ent.page_url.startsWith('/') ? ent.page_url : `/${ent.page_url}`}`
      if (!seenUrls.has(formUrl)) {
        pagesToScan.push({ url: formUrl, entity: eName, pageType: 'form' })
        seenUrls.add(formUrl)
      }
    }
  }

  log.info(`[RECRAWL] Scanning ${pagesToScan.length} pages`)

  // ── Launch Playwright ─────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true })
  const ctx     = await browser.newContext()
  const page    = await ctx.newPage()
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)

  try {
    if (username && password) {
      const ok = await attemptLogin(page, baseUrl, username, password)
      if (!ok) { log.error('[RECRAWL] Cannot proceed without auth'); return }
    }

    // entity → { openButton, submitButton }
    const results = new Map<string, { openButton: string | null; submitButton: string | null }>()

    for (const { url, entity, pageType } of pagesToScan) {
      const result = await scanPage(page, url, entity)
      if (!result) continue

      const curr = results.get(entity) ?? { openButton: null, submitButton: null }

      if (pageType === 'list') {
        if (result.openButton && !curr.openButton) curr.openButton = result.openButton
        // Some CRMs show the open button only on list pages; also check submit presence for debugging
      } else {
        if (result.submitButton && !curr.submitButton) curr.submitButton = result.submitButton
        if (result.openButton && !curr.openButton)    curr.openButton   = result.openButton
      }

      results.set(entity, curr)
    }

    // ── Print summary ──────────────────────────────────────────────────────
    log.info('\n[RECRAWL] ═══ RESULTS ═══')
    for (const [entity, r] of results) {
      log.info(`  ${entity}: open="${r.openButton ?? '(synthesised)'}" submit="${r.submitButton}"`)
    }

    // ── Write to DB ────────────────────────────────────────────────────────
    for (const [entity, r] of results) {
      await updateCanonicalButtons(projectId, entity, r.openButton, r.submitButton)
    }

    log.info(`[RECRAWL] ✅ Done — ${results.size} entities updated`)

  } finally {
    await ctx.close()
    await browser.close()
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const projectId = process.argv[2]

  if (projectId) {
    await recrawlProject(projectId)
  } else {
    const integrations = await prisma.project_integrations.findMany({
      where:  { category: 'web_app' },
      select: { project_id: true },
    })
    log.info(`[RECRAWL] ${integrations.length} web_app project(s) found`)
    for (const { project_id } of integrations) {
      await recrawlProject(project_id)
    }
  }

  log.info('[RECRAWL] All done')
  await prisma.$disconnect()
  process.exit(0)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
