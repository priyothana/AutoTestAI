/**
 * crawl-missing-forms.ts
 *
 * Fix 2: Targeted authenticated crawl of all missing entity form pages.
 *
 * The CRM uses /entity/new (NOT /entity/create) for its actual form pages.
 * This script visits every /entity/new URL, extracts:
 *   - inputs (text, date, number, textarea)
 *   - custom dropdowns ([role="combobox"], [role="listbox"])
 *   - required field detection (label asterisk OR aria-required)
 *   - submit/action buttons (excluding nav)
 *
 * Then merges the results into metadata_raw_store and re-runs Stages 2-3.5.
 *
 * Run: npx tsx src/scripts/crawl-missing-forms.ts [projectId]
 */
import 'dotenv/config'
import { chromium } from 'playwright'
import prisma from '../shared/db/prisma.js'
import { fernetDecrypt } from '../shared/encryption/fernet.js'
import { createModuleLogger } from '../shared/logger/index.js'

const log = createModuleLogger('crawl-missing-forms')

// ─── Entity definition ───────────────────────────────────────────────────────

interface EntityDef {
  name:      string
  listPath:  string
  formPath:  string
}

const CRM_ENTITIES: EntityDef[] = [
  { name: 'Lead',        listPath: '/leads',         formPath: '/leads/new' },
  { name: 'Account',     listPath: '/accounts',      formPath: '/accounts/new' },
  { name: 'Contact',     listPath: '/contacts',      formPath: '/contacts/new' },
  { name: 'Opportunity', listPath: '/opportunities', formPath: '/opportunities/new' },
  { name: 'Campaign',    listPath: '/campaigns',     formPath: '/campaigns/new' },
  { name: 'Contract',    listPath: '/contracts',     formPath: '/contracts/new' },
  { name: 'Order',       listPath: '/orders',        formPath: '/orders/new' },
  { name: 'Invoice',     listPath: '/invoices',      formPath: '/invoices/new' },
  { name: 'Quote',       listPath: '/quotes',        formPath: '/quotes/new' },
  { name: 'Product',     listPath: '/products',      formPath: '/products/new' },
]

// ─── Types ────────────────────────────────────────────────────────────────────

interface FieldInfo {
  name:         string
  tag:          string     // 'input' | 'textarea' | 'select' | 'combobox'
  type:         string     // input type or 'text'
  required:     boolean
  locator_type: string
  locator:      string
  options?:     string[]   // for select/combobox
}

interface ButtonInfo {
  name:         string
  locator_type: string
  locator:      string
}

interface PageSnapshot {
  url:      string
  path:     string
  title:    string
  headings: string[]
  inputs:   FieldInfo[]
  selects:  FieldInfo[]
  buttons:  ButtonInfo[]
  testids:  string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function attemptLogin(
  page: import('playwright').Page,
  baseUrl: string,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})

    for (const sel of ['input[type="email"]', 'input[name="username"]', 'input[type="text"]']) {
      const f = page.locator(sel).first()
      if (await f.isVisible({ timeout: 1000 }).catch(() => false)) { await f.fill(username); break }
    }
    await page.locator('input[type="password"]').first().fill(password)

    for (const name of ['Log In', 'Login', 'Sign In', 'Submit']) {
      const btn = page.getByRole('button', { name, exact: false })
      if (await btn.count() > 0) { await btn.first().click(); break }
    }

    await page.waitForTimeout(3000)
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})

    const isLogin = await page.locator('input[type="password"]').count() > 0
    if (isLogin) { log.error('[CRAWL-FORMS] Login FAILED'); return false }
    log.info(`[CRAWL-FORMS] ✅ Login OK → ${page.url()}`)
    return true
  } catch (err) {
    log.error({ err }, '[CRAWL-FORMS] Login error')
    return false
  }
}

async function snapshotPage(
  page: import('playwright').Page,
  url: string,
): Promise<PageSnapshot | null> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 })
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
    await page.waitForTimeout(1500)
  } catch {
    log.warn(`[CRAWL-FORMS] Navigation failed: ${url}`)
    return null
  }

  const currentUrl = page.url()
  const pathname   = new URL(currentUrl).pathname

  // Auth redirect check
  if (await page.locator('input[type="password"]').count() > 0) {
    log.warn(`[CRAWL-FORMS] ⚠ Login redirect at ${url}`)
    return null
  }

  const title    = await page.title().catch(() => '')
  const headings = await page.evaluate(() =>
    Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(h => (h as HTMLElement).innerText?.trim())
      .filter(Boolean).slice(0, 8)
  ) as string[]

  // ── Inputs (text / email / tel / number / date / textarea) ─────────────────
  const inputs: FieldInfo[] = await page.evaluate(() => {
    const els = Array.from(
      document.querySelectorAll(
        'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea'
      ) as NodeListOf<HTMLInputElement>
    ).filter(el => el.offsetParent !== null).slice(0, 40)

    return els.map(el => {
      let label = ''
      let labelHasAsterisk = false
      if (el.id) {
        const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
        if (lbl) {
          label = lbl.innerText?.trim().replace(/\s*\*\s*$/, '').trim() || ''
          labelHasAsterisk = lbl.textContent?.includes('*') || false
        }
      }
      if (!label) label = el.getAttribute('aria-label') || ''
      if (!label) label = el.getAttribute('placeholder') || ''
      if (!label) label = el.getAttribute('name') || ''

      const required = el.required
        || el.hasAttribute('required')
        || el.getAttribute('aria-required') === 'true'
        || labelHasAsterisk

      let locatorType = 'css'
      let locator = label

      if (label && el.id) { locatorType = 'label'; locator = label }
      else if (label) { locatorType = 'label'; locator = label }
      else if (el.getAttribute('placeholder')) { locatorType = 'placeholder'; locator = el.getAttribute('placeholder')! }
      else if (el.getAttribute('name')) { locatorType = 'css'; locator = `[name="${el.getAttribute('name')}"]` }

      // Display label with asterisk for required
      const displayLabel = required && label && !label.endsWith('*') ? `${label} *` : label

      return {
        name:         displayLabel || label,
        tag:          el.tagName.toLowerCase(),
        type:         el.getAttribute('type') || 'text',
        required:     Boolean(required),
        locator_type: locatorType,
        locator,
        options:      [],
      }
    }).filter(f => f.name)
  }) as FieldInfo[]

  // ── Selects including custom comboboxes ────────────────────────────────────
  const selects: FieldInfo[] = await page.evaluate(() => {
    // Native selects
    const natives = Array.from(
      document.querySelectorAll('select') as NodeListOf<HTMLSelectElement>
    ).filter(el => el.offsetParent !== null).slice(0, 20)

    // Custom comboboxes ([role="combobox"], [role="listbox"] triggers)
    const combos = Array.from(
      document.querySelectorAll('[role="combobox"], [role="listbox"]') as NodeListOf<HTMLElement>
    ).filter(el => el.offsetParent !== null).slice(0, 20)

    const results: Array<{
      name: string; tag: string; type: string; required: boolean
      locator_type: string; locator: string; options: string[]
    }> = []

    for (const el of natives) {
      let label = ''
      if (el.id) {
        const lbl = document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`)
        if (lbl) label = lbl.innerText?.trim().replace(/\s*\*\s*$/, '') || ''
      }
      if (!label) label = el.getAttribute('aria-label') || el.getAttribute('name') || ''

      const opts = Array.from(el.options).map(o => o.text.trim()).filter(Boolean)
      const required = el.required || el.getAttribute('aria-required') === 'true'

      results.push({
        name:         label,
        tag:          'select',
        type:         'select',
        required:     Boolean(required),
        locator_type: label ? 'label' : 'css',
        locator:      label || `select[name="${el.name}"]`,
        options:      opts.slice(0, 20),
      })
    }

    for (const el of combos) {
      const label = el.getAttribute('aria-label')
        || el.getAttribute('placeholder')
        || (el as HTMLElement).innerText?.trim().slice(0, 60)
        || ''
      const required = el.getAttribute('aria-required') === 'true'
        || el.closest('[required]') !== null

      // Try to get options from adjacent listbox
      const listbox = document.querySelector<HTMLElement>(`[role="option"]`)
      const opts = listbox
        ? Array.from(document.querySelectorAll('[role="option"]')).map(o => (o as HTMLElement).innerText?.trim()).filter(Boolean).slice(0, 20)
        : []

      if (label) {
        results.push({
          name:         label,
          tag:          'combobox',
          type:         'select',
          required:     Boolean(required),
          locator_type: 'label',
          locator:      label,
          options:      opts,
        })
      }
    }

    return results.filter(r => r.name)
  }) as FieldInfo[]

  // ── Buttons (non-nav) ──────────────────────────────────────────────────────
  const buttons: ButtonInfo[] = await page.evaluate(() => {
    const NAV_CLASSES = ['nav-item', 'nav-subitem', 'nav-accordion', 'footer-btn', 'sidebar']

    const els = Array.from(
      document.querySelectorAll('button, [role="button"], input[type="submit"]') as NodeListOf<HTMLElement>
    ).filter(el => {
      if (!el.offsetParent) return false
      const cls = (el.className || '').toString()
      return !NAV_CLASSES.some(c => cls.includes(c))
    }).slice(0, 20)

    return els.map(el => {
      const rawText = ((el as HTMLButtonElement).innerText || (el as HTMLInputElement).value || '')
        .replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
      const aria = el.getAttribute('aria-label') || ''
      const name = (aria || rawText).slice(0, 80)
      return {
        name,
        locator_type: 'role',
        locator: `role=button, name=${name}`,
      }
    }).filter(b => b.name && b.name.length > 0 && b.name.length < 60)
  }) as ButtonInfo[]

  log.info(
    `[CRAWL-FORMS] ${pathname} → inputs=${inputs.length} selects=${selects.length} buttons=${buttons.length}`,
  )
  if (inputs.length > 0) {
    log.info(`[CRAWL-FORMS]   Required: ${inputs.filter(i => i.required).map(i => i.name).join(', ')}`)
    log.info(`[CRAWL-FORMS]   Optional: ${inputs.filter(i => !i.required).map(i => i.name).slice(0, 6).join(', ')}`)
  }
  if (selects.length > 0) {
    log.info(`[CRAWL-FORMS]   Selects: ${selects.map(s => s.name).join(', ')}`)
  }

  return {
    url:      currentUrl,
    path:     pathname,
    title,
    headings,
    inputs,
    selects,
    buttons,
    testids:  [],
  }
}

// ─── Main crawl ───────────────────────────────────────────────────────────────

async function crawlMissingForms(projectId: string): Promise<void> {
  log.info(`[CRAWL-FORMS] ▶ Starting for project ${projectId}`)

  const integration = await prisma.project_integrations.findFirst({
    where: { project_id: projectId, category: 'web_app' },
  })
  if (!integration?.base_url) throw new Error('No web_app integration found')

  const baseUrl = integration.base_url.replace(/\/$/, '')
  let username = integration.username ?? ''
  let password = integration.password ?? ''
  try { username = fernetDecrypt(username) } catch { /* plaintext */ }
  try { password = fernetDecrypt(password) } catch { /* plaintext */ }

  // Load existing raw data to merge into
  const existing = await prisma.metadata_raw_store.findFirst({
    where: { project_id: projectId, metadata_type: 'webpage' },
  })
  const existingData = (existing?.raw_json ?? { base_url: baseUrl, pages: [] }) as unknown as { base_url: string; pages: PageSnapshot[] }
  const existingPages: PageSnapshot[] = existingData.pages ?? []

  // Build a map of path → page for dedup
  const pageMap = new Map<string, PageSnapshot>()
  for (const p of existingPages) pageMap.set(p.path, p)

  // ── Launch Playwright ─────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true })
  const ctx     = await browser.newContext()
  const page    = await ctx.newPage()
  page.setDefaultTimeout(20_000)
  page.setDefaultNavigationTimeout(30_000)

  try {
    if (username && password) {
      const ok = await attemptLogin(page, baseUrl, username, password)
      if (!ok) throw new Error('Login failed — cannot crawl authenticated pages')
    }

    let newPages = 0
    let updatedPages = 0

    for (const entity of CRM_ENTITIES) {
      // Crawl form page (/entity/new)
      const formUrl  = `${baseUrl}${entity.formPath}`
      const formSnap = await snapshotPage(page, formUrl)

      if (formSnap) {
        const existing = pageMap.get(formSnap.path)
        const isRicher = !existing
          || (formSnap.inputs.length + formSnap.selects.length) >
             (existing.inputs.length + existing.selects.length)

        if (isRicher) {
          pageMap.set(formSnap.path, formSnap)
          if (existing) { updatedPages++; log.info(`[CRAWL-FORMS] ↑ Updated ${formSnap.path}`) }
          else          { newPages++;    log.info(`[CRAWL-FORMS] + Added   ${formSnap.path}`) }
        } else {
          log.info(`[CRAWL-FORMS] = Kept existing ${formSnap.path} (same/richer)`)
        }
      }

      // Crawl list page (/entity) — for open_button capture
      const listUrl  = `${baseUrl}${entity.listPath}`
      const listSnap = await snapshotPage(page, listUrl)
      if (listSnap && !pageMap.has(listSnap.path)) {
        pageMap.set(listSnap.path, listSnap)
        newPages++
        log.info(`[CRAWL-FORMS] + Added list page ${listSnap.path}`)
      }
    }

    // ── Save merged data back to metadata_raw_store ───────────────────────
    const mergedPages = Array.from(pageMap.values())
    const merged = { base_url: baseUrl, pages: mergedPages, stats: { total: mergedPages.length } }

    if (existing) {
      await prisma.metadata_raw_store.update({
        where: { id: existing.id },
        data:  { raw_json: merged as object },
      })
    } else {
      await prisma.metadata_raw_store.create({
        data: {
          project_id:    projectId,
          metadata_type: 'webpage',
          api_name:      baseUrl,
          raw_json:      merged as object,
        },
      })
    }

    log.info(
      `[CRAWL-FORMS] ✅ Done: ${newPages} new + ${updatedPages} updated pages. ` +
      `Total in DB: ${mergedPages.length}`,
    )

  } finally {
    await ctx.close()
    await browser.close()
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const projectId = process.argv[2]

  if (projectId) {
    await crawlMissingForms(projectId)
  } else {
    const rows = await prisma.project_integrations.findMany({
      where: { category: 'web_app' }, select: { project_id: true },
    })
    log.info(`[CRAWL-FORMS] ${rows.length} web_app project(s)`)
    for (const { project_id } of rows) await crawlMissingForms(project_id)
  }

  log.info('[CRAWL-FORMS] All done')
  await prisma.$disconnect()
  process.exit(0)
}

main().catch(err => { console.error(err); process.exit(1) })
