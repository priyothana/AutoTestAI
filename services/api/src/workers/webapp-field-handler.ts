/**
 * Web App Field Handler — Microservice
 *
 * Provides robust, multi-strategy field interaction for non-Salesforce web apps.
 * Mirrors the SF-specific handlers (selectSFPicklist, fillSFDate, etc.) but
 * targets standard HTML elements and common React/Vue/Angular patterns.
 *
 * Exported handlers:
 *   selectWebAppPicklist()      — <select>, role=combobox on non-input, custom dropdowns
 *   fillWebAppDate()            — <input type="date">, <input type="datetime-local">
 *   fillWebAppCheckbox()        — <input type="checkbox">, <input type="radio">
 *   fillWebAppAutocomplete()    — <input type="text" role="combobox"> lookup/typeahead
 *   fillWebAppField()           — smart dispatcher: probes DOM type → routes correctly
 *
 * KEY DESIGN RULES:
 *   - labelVariants() only returns multi-word subsets — NEVER single words for label matching
 *   - Single-word variants are only used as last-resort fallback in full-page DOM scans
 *   - input[type=text] with role=combobox → 'autocomplete', NOT 'combobox' (picklist)
 *   - Full-page <select> scan uses EXACT label match only, not single-word fuzzy matching
 */

import type { Page, Locator } from '@playwright/test'
import { createModuleLogger } from '../shared/logger/index.js'

const log = createModuleLogger('webapp-field-handler')

// ─── Label extraction helpers ──────────────────────────────────────────────────

/**
 * Unwrap Playwright expression strings emitted by the AI generator.
 * e.g. getByLabel('Type') → 'Type'
 *      getByRole('combobox', {name:'Status'}) → 'Status'
 *      "Account Name" → "Account Name"  (passthrough)
 */
export function extractWebAppLabel(raw: string): string {
  if (!raw) return raw

  // getByLabel('...') / getByText('...') / getByPlaceholder('...')
  const simpleMatch = raw.match(
    /^(?:page\.)?getBy(?:Label|Text|Placeholder|Title|AltText)\s*\(\s*['"]([^'"]+)['"]/i,
  )
  if (simpleMatch) return simpleMatch[1].trim()

  // getByRole('combobox', { name: 'Type' })
  const roleMatch = raw.match(
    /^(?:page\.)?getByRole\s*\(\s*['"][^'"]+['"]\s*,\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/i,
  )
  if (roleMatch) return roleMatch[1].trim()

  // locator('label=Type') or locator('text=Type')
  const locatorPrefixMatch = raw.match(
    /^(?:page\.)?locator\s*\(\s*['"](label=|text=)([^'"]+)['"]/i,
  )
  if (locatorPrefixMatch) return locatorPrefixMatch[2].trim()

  return raw
}

/**
 * Generate label variants for matching.
 *
 * STRICT variants (used for label proximity matching — never single words):
 *   "Parent Account" → ["Parent Account", "Parent"]  (all-but-last only if 2+ words remain)
 *
 * LOOSE single variants (used ONLY in full-page last-resort scans):
 *   "Parent Account" → ["Account"]
 *
 * WHY: Single-word "Account" matches "Account Name", "Industry" labels in the same
 * form context, causing the wrong field to be targeted.
 */
function labelVariants(label: string): string[] {
  const parts = label.trim().split(/\s+/)
  const strict: string[] = [label]
  if (parts.length > 1) {
    // all-but-last (e.g. "Parent" from "Parent Account") — only if 2+ remaining words
    const allButLast = parts.slice(0, -1).join(' ')
    if (allButLast.includes(' ') || parts.length === 2) {
      // For 2-word "Parent Account" → add "Parent" as a secondary
      // For 3+ word "Account Parent Inc" → add "Account Parent"
      strict.push(allButLast)
    }
    // For compound labels, also try last word only if it is distinctive (2+ chars)
    // but keep it SEPARATE from strict so callers can choose
  }
  return [...new Set(strict)]
}

/**
 * Return ONLY the single last-word variant — used exclusively as last-resort.
 * Kept separate so it's never accidentally used in early strategies.
 */
function looseSingleWord(label: string): string[] {
  const parts = label.trim().split(/\s+/)
  if (parts.length <= 1) return []
  return [parts[parts.length - 1]]  // e.g. "Account" from "Parent Account"
}

// ─── Field type detection ──────────────────────────────────────────────────────

/**
 * Probe the actual DOM element type for a given label.
 *
 * CRITICAL DISTINCTION:
 *   - <select>                              → 'select'       → selectWebAppPicklist()
 *   - <input type=text role=combobox>       → 'autocomplete' → fillWebAppAutocomplete()
 *   - <div/button role=combobox>            → 'combobox'     → selectWebAppPicklist()
 *   - <input type=checkbox>                 → 'checkbox'     → fillWebAppCheckbox()
 *   - <input type=date>                     → 'date'         → fillWebAppDate()
 *   - <input type=text> (no special role)   → 'text'         → standard fill
 *   - <textarea>                            → 'textarea'     → standard fill
 *
 * Uses STRICT label matching (full label text first) to prevent false matches.
 */
export async function probeWebAppFieldType(page: Page, label: string): Promise<string | null> {
  // Only use strict variants for probing — avoid single-word matches
  const strictVariants = labelVariants(label)

  const result = await page.evaluate((args: { vars: string[], label: string }) => {
    const { vars, label } = args
    const allLabels = Array.from(document.querySelectorAll<HTMLElement>('label'))

    // Score-based label matching: exact full label > partial full label > multi-word subset
    const scoredLabels: Array<{ el: HTMLElement, score: number }> = []
    for (const lbl of allLabels) {
      const txt = (lbl.textContent ?? '').trim().replace(/\s+/g, ' ')
      if (!txt) continue
      const txtLower = txt.toLowerCase()
      const labelLower = label.toLowerCase()

      if (txtLower === labelLower) {
        scoredLabels.push({ el: lbl, score: 100 })
      } else if (txtLower.includes(labelLower)) {
        scoredLabels.push({ el: lbl, score: 80 })
      } else if (vars.some(v => txtLower === v.toLowerCase())) {
        scoredLabels.push({ el: lbl, score: 60 })
      } else if (vars.some(v => txtLower.includes(v.toLowerCase()))) {
        scoredLabels.push({ el: lbl, score: 40 })
      }
    }

    // Sort by score descending
    scoredLabels.sort((a, b) => b.score - a.score)

    for (const { el: labelEl } of scoredLabels) {
      // Walk: find associated control (for attr, sibling, parent, etc.)
      const forAttr = labelEl.getAttribute('for')
      const associated = (forAttr ? document.getElementById(forAttr) : null) as HTMLElement | null

      const controls: HTMLElement[] = []
      if (associated) controls.push(associated)

      // Siblings
      let sib = labelEl.nextElementSibling as HTMLElement | null
      for (let i = 0; i < 5 && sib; i++) {
        controls.push(sib)
        sib = sib.nextElementSibling as HTMLElement | null
      }

      // Parent descendants
      const parent = labelEl.parentElement
      if (parent) {
        parent.querySelectorAll<HTMLElement>('input, select, textarea, [role]').forEach(c => {
          if (!controls.includes(c)) controls.push(c)
        })
      }

      for (const ctrl of controls) {
        const tag = ctrl.tagName?.toLowerCase() ?? ''
        const type = ctrl.getAttribute('type')?.toLowerCase() ?? ''
        const role = ctrl.getAttribute('role')?.toLowerCase() ?? ''

        if (tag === 'select') return 'select'
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'date') return 'date'
        if (type === 'datetime-local') return 'datetime'
        if (type === 'time') return 'time'
        if (tag === 'textarea') return 'textarea'

        // CRITICAL: text input with role=combobox is an AUTOCOMPLETE, not a select picklist
        if (tag === 'input' && (type === 'text' || type === '' || !type) && role === 'combobox') {
          return 'autocomplete'
        }
        // Non-input element (div/button/span) with combobox role = true dropdown picker
        if (tag !== 'input' && (role === 'combobox' || role === 'listbox')) {
          return 'combobox'
        }
        if (tag === 'input') return 'text'
      }
    }
    return null
  }, { vars: strictVariants, label }).catch(() => null)

  return result
}

// ─── Autocomplete / Lookup handler ────────────────────────────────────────────

/**
 * Handle typeahead / autocomplete inputs: input[type=text] with role=combobox.
 * These are "lookup" fields (e.g. Parent Account, Assigned To) where you type
 * a search term and select from a dropdown of matching records.
 *
 * Strategy cascade:
 *   1. Find the input via getByLabel → exact/partial
 *   2. Type the value (pressSequentially so React state updates fire)
 *   3. Wait for dropdown options to appear
 *   4. Click the matching option (exact match first, then partial)
 *   5. If no dropdown appears, Tab-commit the typed value (some apps accept free text)
 */
export async function fillWebAppAutocomplete(
  page: Page,
  rawLabel: string,
  value: string,
): Promise<void> {
  const fieldLabel = extractWebAppLabel(rawLabel)
  log.info(`[WEBAPP-AUTOCOMPLETE] Filling lookup "${fieldLabel}" = "${value}"`)

  const strictVariants = labelVariants(fieldLabel)
  let input: Locator | null = null

  // Find the input element
  for (const lbl of strictVariants) {
    // getByLabel (exact)
    try {
      const byLabel = page.getByLabel(lbl, { exact: true }).first()
      if (await byLabel.isVisible({ timeout: 2_000 }).catch(() => false)) { input = byLabel; break }
    } catch { /* try next */ }

    // getByLabel (partial)
    try {
      const byLabel = page.getByLabel(lbl, { exact: false }).first()
      if (await byLabel.isVisible({ timeout: 1_500 }).catch(() => false)) { input = byLabel; break }
    } catch { /* try next */ }

    // XPath: label → sibling/parent input
    try {
      const xpLoc = page.locator(
        `xpath=//label[contains(normalize-space(.),"${lbl}")]/following-sibling::input` +
        `|//label[contains(normalize-space(.),"${lbl}")]/parent::*/descendant::input[@type="text" or not(@type)][1]` +
        `|//label[normalize-space(.)="${lbl}"]/following::input[1]`,
      ).first()
      if (await xpLoc.isVisible({ timeout: 1_500 }).catch(() => false)) { input = xpLoc; break }
    } catch { /* try next */ }
  }

  // Placeholder fallback
  if (!input) {
    for (const lbl of strictVariants) {
      try {
        const ph = page.getByPlaceholder(lbl, { exact: false }).first()
        if (await ph.isVisible({ timeout: 1_500 }).catch(() => false)) { input = ph; break }
      } catch { /* try next */ }
    }
  }

  if (!input) {
    throw new Error(`[WEBAPP-AUTOCOMPLETE] Could not find autocomplete input for "${fieldLabel}" (tried: ${strictVariants.join(', ')})`)
  }

  await input.scrollIntoViewIfNeeded().catch(() => {})

  // Clear existing value and type search term (JS focus + pressSequentially fires React events)
  await input.evaluate((el: HTMLElement) => {
    const inp = el as HTMLInputElement
    inp.focus()
    inp.select()
    inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    inp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    inp.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    inp.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  })
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(100)

  // Type with delay so debounced search fires
  await input.pressSequentially(value, { delay: 80 })
  log.info(`[WEBAPP-AUTOCOMPLETE] Typed "${value}" — waiting for dropdown`)
  await page.waitForTimeout(800)

  // Wait for and click the matching option
  const optionSelectors = [
    `[role="option"]:has-text("${value}")`,
    `[role="listbox"] *:has-text("${value}")`,
    `ul[role="listbox"] li:has-text("${value}")`,
    `.dropdown-item:has-text("${value}")`,
    `.autocomplete-option:has-text("${value}")`,
    `[data-value="${value}"]`,
  ]

  for (const sel of optionSelectors) {
    try {
      const opt = page.locator(sel).first()
      if (await opt.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await opt.scrollIntoViewIfNeeded().catch(() => {})
        await opt.click()
        await page.waitForTimeout(300)
        log.info(`[WEBAPP-AUTOCOMPLETE] ✅ Selected "${value}" via dropdown option`)
        return
      }
    } catch { /* try next */ }
  }

  // Broader: first visible [role="option"] after typing
  const firstOpt = page.locator('[role="option"]').first()
  if (await firstOpt.isVisible({ timeout: 2_000 }).catch(() => false)) {
    const optText = await firstOpt.textContent().catch(() => '')
    log.info(`[WEBAPP-AUTOCOMPLETE] No exact match — clicking first option: "${optText?.trim()}"`)
    await firstOpt.click()
    await page.waitForTimeout(300)
    log.info(`[WEBAPP-AUTOCOMPLETE] ✅ Selected first available option`)
    return
  }

  // ── Advanced Search fallback ────────────────────────────────────────────────
  // Many CRM apps show "Advanced Search" / "Search More" / "Show All Results"
  // when the inline dropdown doesn't have the value. This opens a modal/panel.
  {
    const advSearchBtn = page.locator(
      'button:has-text("Advanced Search"), button:has-text("Search More"), ' +
      'a:has-text("Show All Results"), a:has-text("See All"), ' +
      'button:has-text("View All"), [data-action="advanced-search"]',
    ).first()
    if (await advSearchBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      log.info(`[WEBAPP-AUTOCOMPLETE] Found Advanced Search trigger — clicking`)
      await advSearchBtn.click()
      await page.waitForTimeout(1_500)

      // Search in the advanced modal/panel
      const searchInput = page.locator(
        '[role="dialog"] input[type="text"], [role="dialog"] input[type="search"], ' +
        '.modal input[type="text"], .modal input[type="search"], ' +
        '[class*="modal"] input[type="text"], [class*="search"] input[type="text"]',
      ).first()
      if (await searchInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await searchInput.fill(value)
        await page.waitForTimeout(1_000)

        // Click matching result row
        const resultSelectors = [
          `[role="dialog"] tr:has-text("${value}")`,
          `[role="dialog"] [role="row"]:has-text("${value}")`,
          `.modal tr:has-text("${value}")`,
          `[role="dialog"] li:has-text("${value}")`,
          `[role="dialog"] [role="option"]:has-text("${value}")`,
        ]
        for (const rSel of resultSelectors) {
          const result = page.locator(rSel).first()
          if (await result.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await result.scrollIntoViewIfNeeded().catch(() => {})
            await result.click()
            await page.waitForTimeout(500)
            log.info(`[WEBAPP-AUTOCOMPLETE] ✅ Selected "${value}" via Advanced Search`)
            return
          }
        }
      }

      // Close the modal if nothing was selected
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(300)
      log.warn(`[WEBAPP-AUTOCOMPLETE] Advanced Search opened but could not select "${value}"`)
    }
  }

  // No dropdown appeared — Tab-commit the typed value (free-text fields)
  log.warn(`[WEBAPP-AUTOCOMPLETE] No dropdown appeared for "${fieldLabel}" — Tab-committing typed value`)
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  log.info(`[WEBAPP-AUTOCOMPLETE] ✅ Tab-committed "${value}" for "${fieldLabel}"`)
}

// ─── Picklist / Select handler ─────────────────────────────────────────────────

/**
 * Select a value in a web app picklist/dropdown.
 * Targets true select-style controls: <select>, div/button role=combobox, custom dropdowns.
 * Does NOT handle input[type=text] autocomplete — use fillWebAppAutocomplete() for those.
 *
 * Strategy cascade:
 *   A. Native <select> via XPath from label — STRICT label match only
 *   B. getByLabel → child/self <select>
 *   C. role="combobox" (non-input) → click → role="option" pick
 *   D. getByRole('combobox') by label name → click → pick option
 *   E. aria-haspopup="listbox" trigger button near label
 *   F. Full-page <select> scan — STRICT label match + option value existence check
 *   G. Full-page custom dropdown scan — single-word fallback only
 */
export async function selectWebAppPicklist(
  page: Page,
  rawLabel: string,
  optionValue: string,
): Promise<void> {
  const fieldLabel = extractWebAppLabel(rawLabel)
  if (fieldLabel !== rawLabel) {
    log.info(`[WEBAPP-PICKLIST] Resolved label: "${rawLabel}" → "${fieldLabel}"`)
  }
  log.info(`[WEBAPP-PICKLIST] Selecting "${optionValue}" in "${fieldLabel}"`)

  // STRICT variants only — never single words for label matching
  const strictVariants = labelVariants(fieldLabel)

  // Helper: try selectOption on a <select> locator
  const trySelect = async (loc: Locator, strategy: string): Promise<boolean> => {
    try {
      await loc.selectOption({ label: optionValue })
      await page.waitForTimeout(300)
      log.info(`[WEBAPP-PICKLIST] ✅ ${strategy}: selected "${optionValue}"`)
      return true
    } catch {
      try {
        await loc.selectOption({ value: optionValue })
        await page.waitForTimeout(300)
        log.info(`[WEBAPP-PICKLIST] ✅ ${strategy} (by value): selected "${optionValue}"`)
        return true
      } catch { return false }
    }
  }

  // ── Strategy A: Native <select> via label XPath (STRICT match) ───────────
  for (const lbl of strictVariants) {
    try {
      const nativeSel = page.locator(
        `xpath=//label[normalize-space(.)="${lbl}"]/following-sibling::select` +
        `|//label[normalize-space(.)="${lbl}"]/parent::*/descendant::select` +
        `|//label[normalize-space(.)="${lbl}"]/following::select[1]` +
        `|//label[contains(normalize-space(.),"${lbl}") and string-length(normalize-space(.))<=string-length("${lbl}")+5]/following-sibling::select` +
        `|//label[contains(normalize-space(.),"${lbl}") and string-length(normalize-space(.))<=string-length("${lbl}")+5]/parent::*/descendant::select` +
        `|//*[@aria-label="${lbl}"]/self::select` +
        `|//*[@aria-label and normalize-space(@aria-label)="${lbl}"]/self::select`,
      ).first()
      if (await nativeSel.isVisible({ timeout: 1_500 }).catch(() => false)) {
        if (await trySelect(nativeSel, `Strategy A (strict label "${lbl}" → select)`)) return
      }
    } catch { /* try next */ }
  }

  // ── Strategy B: getByLabel → direct <select> or child select ─────────────
  {
    for (const exact of [true, false]) {
      try {
        const byLabel = page.getByLabel(fieldLabel, { exact }).first()
        if (!await byLabel.isVisible({ timeout: 1_500 }).catch(() => false)) continue

        const tagName = await byLabel.evaluate((el) => el.tagName).catch(() => '')
        if (tagName === 'SELECT') {
          if (await trySelect(byLabel, `Strategy B1 (getByLabel exact=${exact} is select)`)) return
        }

        const innerSel = byLabel.locator('select').first()
        if (await innerSel.isVisible({ timeout: 1_000 }).catch(() => false)) {
          if (await trySelect(innerSel, `Strategy B2 (getByLabel exact=${exact} child select)`)) return
        }
      } catch { /* try next */ }
    }
  }

  // ── Strategy C: Non-input role="combobox" → click → pick option ──────────
  for (const lbl of strictVariants) {
    try {
      const comboboxLoc = page.locator(
        `xpath=//label[contains(normalize-space(.),"${lbl}")]/following-sibling::*[@role="combobox"][not(self::input)]` +
        `|//label[contains(normalize-space(.),"${lbl}")]/parent::*/descendant::*[@role="combobox"][not(self::input)]` +
        `|//*[@aria-label="${lbl}" and @role="combobox" and not(self::input)]`,
      ).first()

      if (await comboboxLoc.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await comboboxLoc.scrollIntoViewIfNeeded().catch(() => {})
        await comboboxLoc.click()
        // Smart wait: wait for dropdown/listbox panel to materialize
        await page.waitForSelector(
          '[role="listbox"], [role="menu"], .dropdown-menu, ul.options, [class*="dropdown"]',
          { state: 'visible', timeout: 5_000 },
        ).catch(() => {})
        await page.waitForTimeout(300) // let animations finish

        // Check if it opened a native <select> (some frameworks use this)
        const tag = await comboboxLoc.evaluate((el) => el.tagName).catch(() => '')
        if (tag === 'SELECT') {
          if (await trySelect(comboboxLoc, `Strategy C (combobox is native select)`)) return
        }

        // Try multiple option-click strategies
        const optionStrategies = [
          `[role="option"]:has-text("${optionValue}")`,
          `[role="listbox"] li:has-text("${optionValue}")`,
          `[role="listitem"]:has-text("${optionValue}")`,
          `.dropdown-item:has-text("${optionValue}")`,
          `li:has-text("${optionValue}")`,
          `[data-value="${optionValue}"]`,
        ]
        let optionClicked = false
        for (const oSel of optionStrategies) {
          const opt = page.locator(oSel).first()
          if (await opt.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await opt.scrollIntoViewIfNeeded().catch(() => {})
            await opt.click()
            await page.waitForTimeout(300)
            log.info(`[WEBAPP-PICKLIST] ✅ Strategy C (role=combobox → option): selected "${optionValue}"`)
            optionClicked = true
            break
          }
        }
        if (optionClicked) return

        // Partial text fallback
        const partialOpt = page.locator('[role="option"], li').filter({ hasText: optionValue }).first()
        if (await partialOpt.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await partialOpt.scrollIntoViewIfNeeded().catch(() => {})
          await partialOpt.click()
          await page.waitForTimeout(300)
          log.info(`[WEBAPP-PICKLIST] ✅ Strategy C (partial text fallback): selected "${optionValue}"`)
          return
        }

        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(200)
      }
    } catch { /* try next */ }
  }

  // ── Strategy D: getByRole('combobox') named by label ─────────────────────
  for (const lbl of strictVariants) {
    try {
      const cb = page.getByRole('combobox', { name: lbl, exact: false })
      const count = await cb.count().catch(() => 0)
      if (count === 0) continue

      const cbFirst = cb.first()
      if (!await cbFirst.isVisible({ timeout: 1_500 }).catch(() => false)) continue

      // If it's a text input, skip — that's an autocomplete, not a picklist
      const cbTag = await cbFirst.evaluate((el) => el.tagName).catch(() => 'INPUT')
      const cbType = await cbFirst.getAttribute('type').catch(() => 'text') ?? 'text'
      if (cbTag === 'INPUT' && (cbType === 'text' || cbType === '')) {
        log.info(`[WEBAPP-PICKLIST] Strategy D: skipping text input combobox ("${lbl}") — use autocomplete handler`)
        continue
      }

      await cbFirst.scrollIntoViewIfNeeded().catch(() => {})
      if (cbTag === 'SELECT') {
        if (await trySelect(cbFirst, `Strategy D1 (getByRole combobox is select "${lbl}")`)) return
      }

      await cbFirst.click()
      // Smart wait: wait for dropdown/listbox panel to materialize
      await page.waitForSelector(
        '[role="listbox"], [role="menu"], .dropdown-menu, ul.options, [class*="dropdown"]',
        { state: 'visible', timeout: 5_000 },
      ).catch(() => {})
      await page.waitForTimeout(300) // let animations finish

      // Try multiple option-click strategies
      const dOptionStrategies = [
        `[role="option"]:has-text("${optionValue}")`,
        `[role="listbox"] li:has-text("${optionValue}")`,
        `[role="listitem"]:has-text("${optionValue}")`,
        `.dropdown-item:has-text("${optionValue}")`,
        `.select-option:has-text("${optionValue}")`,
        `li:has-text("${optionValue}")`,
        `[data-value="${optionValue}"]`,
      ]
      let dOptClicked = false
      for (const oSel of dOptionStrategies) {
        const opt = page.locator(oSel).first()
        if (await opt.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await opt.scrollIntoViewIfNeeded().catch(() => {})
          await opt.click()
          await page.waitForTimeout(300)
          log.info(`[WEBAPP-PICKLIST] ✅ Strategy D2 (getByRole combobox → option "${lbl}"): selected "${optionValue}"`)
          dOptClicked = true
          break
        }
      }
      if (dOptClicked) return

      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(200)
    } catch { /* try next */ }
  }

  // ── Strategy E: aria-haspopup="listbox" trigger near label ───────────────
  for (const lbl of strictVariants) {
    try {
      const triggerBtn = page.locator(
        `xpath=//label[contains(normalize-space(.),"${lbl}")]/following-sibling::*[@aria-haspopup="listbox"]` +
        `|//label[contains(normalize-space(.),"${lbl}")]/parent::*/descendant::*[@aria-haspopup="listbox"]` +
        `|//label[contains(normalize-space(.),"${lbl}")]/following::*[@aria-haspopup="listbox"][1]`,
      ).first()
      if (await triggerBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await triggerBtn.scrollIntoViewIfNeeded().catch(() => {})
        await triggerBtn.click()
        await page.waitForTimeout(500)

        const option = page.locator('[role="option"]').filter({ hasText: optionValue }).first()
        if (await option.isVisible({ timeout: 3_000 }).catch(() => false)) {
          await option.click()
          await page.waitForTimeout(300)
          log.info(`[WEBAPP-PICKLIST] ✅ Strategy E (aria-haspopup→listbox): selected "${optionValue}"`)
          return
        }
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(200)
      }
    } catch { /* try next */ }
  }

  // ── Strategy F: Full-page <select> scan — STRICT label + option existence ─
  log.warn(`[WEBAPP-PICKLIST] Strict strategies failed for "${fieldLabel}" — full-page <select> scan`)
  {
    const picklistTag = `webapp-picklist-${fieldLabel.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`
    // Build scan variants: strict first, then loose single words
    const looseVariants = looseSingleWord(fieldLabel)
    const allVariantsOrdered = [...strictVariants, ...looseVariants]

    const found = await page.evaluate(
      (args: { strictVars: string[], allVars: string[], tag: string, optVal: string, fullLabel: string }) => {
        const { strictVars, allVars, tag, optVal, fullLabel } = args
        const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('select'))
          .filter(s => (s as HTMLElement).offsetParent !== null) // visible only

        const hasMatchingOption = (sel: HTMLSelectElement) =>
          Array.from(sel.options).some(
            o => o.text.toLowerCase() === optVal.toLowerCase() ||
                 o.value.toLowerCase() === optVal.toLowerCase(),
          )

        const getLabelText = (sel: HTMLSelectElement): string => {
          const associated = sel.labels?.[0] ??
            (sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null) ??
            sel.closest('label')
          const labelText = associated?.textContent?.trim() ?? ''
          const ariaLabel = sel.getAttribute('aria-label') ?? ''
          const name = sel.getAttribute('name') ?? ''
          return (labelText + ' ' + ariaLabel + ' ' + name).toLowerCase()
        }

        // Pass 1: STRICT — full label or multi-word subsets match + option exists
        for (const sel of selects) {
          const textToMatch = getLabelText(sel)
          const isStrictMatch = strictVars.some(v => v.length > 3 && textToMatch.includes(v.toLowerCase()))
          if (isStrictMatch && hasMatchingOption(sel)) {
            sel.setAttribute('data-autotest-webapp-target', tag)
            return 'strict'
          }
        }

        // Pass 2: Option-only — find any <select> containing this option value
        // Use FULL label for context scoring though
        const scoredSelects: Array<{ sel: HTMLSelectElement, score: number }> = []
        for (const sel of selects) {
          if (!hasMatchingOption(sel)) continue
          const textToMatch = getLabelText(sel)
          let score = 0
          if (textToMatch.includes(fullLabel.toLowerCase())) score = 100
          else if (strictVars.some(v => textToMatch.includes(v.toLowerCase()))) score = 60
          else if (allVars.some(v => textToMatch.includes(v.toLowerCase()))) score = 30
          else score = 1  // has option but no label match
          scoredSelects.push({ sel, score })
        }
        scoredSelects.sort((a, b) => b.score - a.score)
        if (scoredSelects.length > 0) {
          scoredSelects[0].sel.setAttribute('data-autotest-webapp-target', tag)
          return 'scored'
        }

        return null
      },
      {
        strictVars: strictVariants,
        allVars: allVariantsOrdered,
        tag: picklistTag,
        optVal: optionValue,
        fullLabel: fieldLabel,
      },
    )

    if (found) {
      const scanned = page.locator(`[data-autotest-webapp-target="${picklistTag}"]`).first()
      await page.evaluate((t: string) => {
        document.querySelector(`[data-autotest-webapp-target="${t}"]`)?.removeAttribute('data-autotest-webapp-target')
      }, picklistTag).catch(() => {})

      if (await scanned.isVisible({ timeout: 2_000 }).catch(() => false)) {
        if (await trySelect(scanned, `Strategy F (full-page scan, match=${found})`)) return
      }
    }
  }

  // ── Strategy G: Custom dropdown trigger scan (loose labels) ───────────────
  log.warn(`[WEBAPP-PICKLIST] No <select> matched — trying custom dropdown scan for "${fieldLabel}"`)
  {
    // Use ALL variants including single words as last resort
    const allVariants = [...strictVariants, ...looseSingleWord(fieldLabel)]
    for (const lbl of allVariants) {
      try {
        const anyTrigger = page.locator(
          `xpath=//label[contains(normalize-space(.),"${lbl}")]/following::button[@type="button"][1]` +
          `|//label[contains(normalize-space(.),"${lbl}")]/following::div[@role="combobox"][not(self::input)][1]` +
          `|//label[contains(normalize-space(.),"${lbl}")]/following::span[@role="button"][1]`,
        ).first()
        if (await anyTrigger.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await anyTrigger.click()
          await page.waitForTimeout(500)

          const option = page.locator('[role="option"]')
            .filter({ hasText: new RegExp(`^${optionValue}$`, 'i') }).first()
          const looserOpt = page.locator('[role="option"]').filter({ hasText: optionValue }).first()
          const opt = await option.isVisible({ timeout: 2_000 }).catch(() => false)
            ? option : looserOpt
          if (await opt.isVisible({ timeout: 2_000 }).catch(() => false)) {
            await opt.click()
            await page.waitForTimeout(300)
            log.info(`[WEBAPP-PICKLIST] ✅ Strategy G (custom trigger "${lbl}"): selected "${optionValue}"`)
            return
          }
          await page.keyboard.press('Escape').catch(() => {})
        }
      } catch { /* try next */ }
    }
  }

  throw new Error(
    `[WEBAPP-PICKLIST] Could not locate picklist/select for "${fieldLabel}" (tried: ${[...strictVariants, ...looseSingleWord(fieldLabel)].join(', ')}). ` +
    `Strategies tried: strict label XPath select, getByLabel select, non-input combobox click, ` +
    `getByRole combobox, aria-haspopup trigger, full-page select scan, custom dropdown button scan.`,
  )
}

// ─── Date field handler ────────────────────────────────────────────────────────

/**
 * Fill a date/datetime input in a web app.
 * Accepts: MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD
 */
export async function fillWebAppDate(page: Page, rawLabel: string, dateValue: string): Promise<void> {
  const fieldLabel = extractWebAppLabel(rawLabel)
  log.info(`[WEBAPP-DATE] Setting date "${dateValue}" in "${fieldLabel}"`)

  // Normalise to YYYY-MM-DD
  let isoDate = dateValue.trim()
  const mmddyyyy = isoDate.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  const ddmmyyyy = isoDate.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (mmddyyyy) {
    isoDate = `${mmddyyyy[3]}-${mmddyyyy[1].padStart(2, '0')}-${mmddyyyy[2].padStart(2, '0')}`
  } else if (ddmmyyyy) {
    const day = parseInt(ddmmyyyy[1], 10)
    if (day > 12) {
      isoDate = `${ddmmyyyy[3]}-${ddmmyyyy[2].padStart(2, '0')}-${ddmmyyyy[1].padStart(2, '0')}`
    } else {
      isoDate = `${ddmmyyyy[3]}-${ddmmyyyy[1].padStart(2, '0')}-${ddmmyyyy[2].padStart(2, '0')}`
    }
  }
  log.info(`[WEBAPP-DATE] Normalised: "${dateValue}" → "${isoDate}"`)

  let dateInput: Locator | null = null
  const strictVariants = labelVariants(fieldLabel)

  for (const lbl of strictVariants) {
    try {
      const typed = page.locator(
        `xpath=//label[contains(normalize-space(.),"${lbl}")]/following::input[@type="date" or @type="datetime-local"][1]` +
        `|//label[contains(normalize-space(.),"${lbl}")]/parent::*/descendant::input[@type="date" or @type="datetime-local"]`,
      ).first()
      if (await typed.isVisible({ timeout: 1_500 }).catch(() => false)) { dateInput = typed; break }
    } catch { /* try next */ }

    try {
      const byLabel = page.getByLabel(lbl, { exact: false }).first()
      if (await byLabel.isVisible({ timeout: 1_500 }).catch(() => false)) { dateInput = byLabel; break }
    } catch { /* try next */ }
  }

  if (!dateInput) throw new Error(`[WEBAPP-DATE] Could not find date input for "${fieldLabel}"`)

  await dateInput.scrollIntoViewIfNeeded().catch(() => {})
  const inputType = await dateInput.getAttribute('type').catch(() => 'text') ?? 'text'

  if (inputType === 'date' || inputType === 'datetime-local') {
    try {
      await dateInput.fill(isoDate)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(300)
      log.info(`[WEBAPP-DATE] ✅ Filled type="${inputType}" with "${isoDate}"`)
      return
    } catch {
      await dateInput.evaluate((el: HTMLElement, val: string) => {
        const inp = el as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        setter?.call(inp, val)
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        inp.dispatchEvent(new Event('change', { bubbles: true }))
      }, isoDate)
      await page.keyboard.press('Tab')
      await page.waitForTimeout(300)
      log.info(`[WEBAPP-DATE] ✅ JS value setter for "${isoDate}"`)
      return
    }
  }

  // text input — type as MM/DD/YYYY
  const mmddValue = isoDate.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1')
  try {
    await dateInput.evaluate((el: HTMLElement) => {
      const inp = el as HTMLInputElement
      inp.focus(); inp.select()
      inp.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await dateInput.pressSequentially(mmddValue, { delay: 50 })
    await page.keyboard.press('Tab')
    await page.waitForTimeout(300)
    log.info(`[WEBAPP-DATE] ✅ Typed date "${mmddValue}" into text input`)
  } catch {
    await dateInput.fill(mmddValue)
    await page.keyboard.press('Tab')
  }
}

// ─── Checkbox / Radio handler ──────────────────────────────────────────────────

/**
 * Check/uncheck a checkbox or select a radio button in a web app.
 * @param value — truthy: 'true', '1', 'yes', 'on', 'checked'; or radio option text
 */
export async function fillWebAppCheckbox(
  page: Page,
  rawLabel: string,
  value: string,
): Promise<void> {
  const fieldLabel = extractWebAppLabel(rawLabel)
  log.info(`[WEBAPP-CHECKBOX] Setting "${fieldLabel}" = "${value}"`)

  const shouldCheck = ['true', '1', 'yes', 'on', 'checked'].includes(value.toLowerCase())
  const strictVariants = labelVariants(fieldLabel)

  for (const lbl of strictVariants) {
    try {
      const loc = page.getByLabel(lbl, { exact: false }).first()
      if (await loc.isVisible({ timeout: 1_500 }).catch(() => false)) {
        const type = await loc.getAttribute('type').catch(() => '')
        if (type === 'radio') {
          if (!shouldCheck && value) {
            const radioByVal = page.locator(`input[type="radio"][value="${value}" i]`).first()
            if (await radioByVal.isVisible({ timeout: 1_500 }).catch(() => false)) {
              await radioByVal.check()
              log.info(`[WEBAPP-CHECKBOX] ✅ Radio selected by value: "${value}"`)
              return
            }
          }
          await loc.check()
          log.info(`[WEBAPP-CHECKBOX] ✅ Radio checked via getByLabel: "${lbl}"`)
          return
        }
        if (shouldCheck) { await loc.check() } else { await loc.uncheck() }
        log.info(`[WEBAPP-CHECKBOX] ✅ Checkbox ${shouldCheck ? 'checked' : 'unchecked'} via getByLabel: "${lbl}"`)
        return
      }
    } catch { /* try next */ }
  }

  for (const lbl of strictVariants) {
    try {
      const cbLoc = page.locator(
        `xpath=//label[contains(normalize-space(.),"${lbl}")]/following-sibling::input[@type="checkbox" or @type="radio"]` +
        `|//label[contains(normalize-space(.),"${lbl}")]/parent::*/descendant::input[@type="checkbox" or @type="radio"]` +
        `|//label[contains(normalize-space(.),"${lbl}")]//input[@type="checkbox" or @type="radio"]`,
      ).first()
      if (await cbLoc.isVisible({ timeout: 1_500 }).catch(() => false)) {
        if (shouldCheck) { await cbLoc.check({ force: true }) } else { await cbLoc.uncheck({ force: true }) }
        log.info(`[WEBAPP-CHECKBOX] ✅ Checkbox/radio set via XPath for "${lbl}"`)
        return
      }
    } catch { /* try next */ }
  }

  throw new Error(`[WEBAPP-CHECKBOX] Could not find checkbox/radio for "${fieldLabel}" (tried: ${strictVariants.join(', ')})`)
}

// ─── Smart field dispatcher ────────────────────────────────────────────────────

/**
 * Primary entry point for web app fill/type steps.
 *
 * Probes DOM type → routes to:
 *   select                 → selectWebAppPicklist()
 *   combobox (non-input)   → selectWebAppPicklist()
 *   autocomplete (input+combobox) → fillWebAppAutocomplete()
 *   checkbox / radio       → fillWebAppCheckbox()
 *   date / datetime        → fillWebAppDate()
 *   textarea / text / null → standard .fill()
 */
export async function fillWebAppField(
  page: Page,
  rawLabel: string,
  value: string,
): Promise<void> {
  const fieldLabel = extractWebAppLabel(rawLabel)
  log.info(`[WEBAPP-ENGINE] fillWebAppField: "${fieldLabel}" = "${value}"`)

  // ── Searchbox fast-path ───────────────────────────────────────────────────
  // When the step uses target="searchbox" locator_type="role" (generated for UPDATE/DELETE
  // search steps), use getByRole('searchbox') directly instead of label-based lookup.
  // This is the standard ARIA role for search inputs — far more reliable than label matching
  // on CRM list-page search bars which are rarely labeled.
  if (fieldLabel.toLowerCase() === 'searchbox' || fieldLabel.toLowerCase() === 'search') {
    log.info(`[WEBAPP-ENGINE] Searchbox fast-path: trying getByRole("searchbox") then placeholder patterns`)
    let searchLoc: Locator | null = null

    // Strategy 1: getByRole('searchbox') — standard ARIA role
    try {
      const byRole = page.getByRole('searchbox').first()
      if (await byRole.isVisible({ timeout: 3_000 }).catch(() => false)) {
        searchLoc = byRole
        log.info(`[WEBAPP-ENGINE] ✅ Found search input via getByRole('searchbox')`)
      }
    } catch { /* try next */ }

    // Strategy 2: common placeholder patterns (e.g. "Search contacts...", "Search...")
    if (!searchLoc) {
      const SEARCH_PLACEHOLDERS = ['Search', 'Find', 'Filter', 'Quick find', 'Type to search']
      for (const ph of SEARCH_PLACEHOLDERS) {
        try {
          const byPh = page.getByPlaceholder(ph, { exact: false }).first()
          if (await byPh.isVisible({ timeout: 1_500 }).catch(() => false)) {
            searchLoc = byPh
            log.info(`[WEBAPP-ENGINE] ✅ Found search input via getByPlaceholder("${ph}...")`)
            break
          }
        } catch { /* try next */ }
      }
    }

    // Strategy 3: any visible input[type=search] or input[role=searchbox]
    if (!searchLoc) {
      try {
        const byAttr = page.locator(
          'input[type="search"], input[role="searchbox"], input[aria-label*="search" i], ' +
          'input[placeholder*="search" i], input[placeholder*="find" i], input[placeholder*="filter" i]'
        ).first()
        if (await byAttr.isVisible({ timeout: 1_500 }).catch(() => false)) {
          searchLoc = byAttr
          log.info(`[WEBAPP-ENGINE] ✅ Found search input via attribute scan`)
        }
      } catch { /* try next */ }
    }

    if (searchLoc) {
      await searchLoc.scrollIntoViewIfNeeded().catch(() => {})
      try {
        await searchLoc.fill(value, { timeout: 5_000 })
      } catch {
        await searchLoc.click()
        await searchLoc.clear().catch(() => {})
        await page.keyboard.type(value)
      }
      await page.waitForTimeout(500)
      log.info(`[WEBAPP-ENGINE] ✅ Typed "${value}" into search input`)
      return
    }

    log.warn(`[WEBAPP-ENGINE] Searchbox fast-path failed — falling through to standard label lookup`)
  }

  // ── Probe field type ──────────────────────────────────────────────────────
  const detectedType = await probeWebAppFieldType(page, fieldLabel)
  log.info(`[WEBAPP-ENGINE] Detected type for "${fieldLabel}": ${detectedType ?? 'unknown — defaulting to text fill'}`)

  // True picklist: <select> or non-input combobox trigger
  if (detectedType === 'select' || detectedType === 'combobox') {
    await selectWebAppPicklist(page, fieldLabel, value)
    return
  }

  // Autocomplete / lookup: input[type=text] with role=combobox
  if (detectedType === 'autocomplete') {
    await fillWebAppAutocomplete(page, fieldLabel, value)
    return
  }

  if (detectedType === 'checkbox' || detectedType === 'radio') {
    await fillWebAppCheckbox(page, fieldLabel, value)
    return
  }

  if (detectedType === 'date' || detectedType === 'datetime') {
    await fillWebAppDate(page, fieldLabel, value)
    return
  }

  // ── Standard text fill ────────────────────────────────────────────────────
  const strictVariants = labelVariants(fieldLabel)
  let loc: Locator | null = null

  // Strategy 1: getByLabel — exact then partial
  for (const exact of [true, false]) {
    try {
      const candidate = page.getByLabel(fieldLabel, { exact }).first()
      if (await candidate.isVisible({ timeout: 3_000 }).catch(() => false)) {
        loc = candidate; break
      }
    } catch { /* try next */ }
  }

  // Strategy 2: aria-label attribute (case-insensitive)
  if (!loc) {
    try {
      const ariaLoc = page.locator(`[aria-label="${fieldLabel}" i]`).first()
      if (await ariaLoc.isVisible({ timeout: 1_500 }).catch(() => false)) loc = ariaLoc
    } catch { /* try next */ }
  }

  // Strategy 3: getByPlaceholder
  if (!loc) {
    try {
      const ph = page.getByPlaceholder(fieldLabel, { exact: false }).first()
      if (await ph.isVisible({ timeout: 2_000 }).catch(() => false)) loc = ph
    } catch { /* try next */ }
  }

  // Strategy 4: name/id attributes (snake_case + camelCase)
  if (!loc) {
    for (const lbl of strictVariants) {
      const snake = lbl.toLowerCase().replace(/\s+/g, '_')
      const camel = lbl.replace(/(?:^\w|[A-Z]|\b\w)/g, (w, i) =>
        i === 0 ? w.toLowerCase() : w.toUpperCase()).replace(/\s+/g, '')
      try {
        const byAttr = page.locator(
          `input[name="${snake}" i]:not([type="hidden"]), textarea[name="${snake}" i], ` +
          `input[name="${camel}"]:not([type="hidden"]), textarea[name="${camel}"], ` +
          `input[id="${snake}" i]:not([type="hidden"]), textarea[id="${snake}" i]`,
        ).first()
        if (await byAttr.isVisible({ timeout: 1_500 }).catch(() => false)) { loc = byAttr; break }
      } catch { /* try next */ }
    }
  }

  // Strategy 5: data-testid / data-cy / data-test attributes
  if (!loc) {
    const slug = fieldLabel.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    const snakeSlug = fieldLabel.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
    try {
      const testIdLoc = page.locator(
        `input[data-testid="${slug}" i], textarea[data-testid="${slug}" i], ` +
        `input[data-cy="${slug}" i], textarea[data-cy="${slug}" i], ` +
        `input[data-test="${slug}" i], textarea[data-test="${slug}" i], ` +
        `input[data-testid="${snakeSlug}" i], input[data-cy="${snakeSlug}" i]`,
      ).first()
      if (await testIdLoc.isVisible({ timeout: 1_500 }).catch(() => false)) loc = testIdLoc
    } catch { /* try next */ }
  }

  // Strategy 6: role + name combination
  if (!loc) {
    for (const role of ['textbox', 'spinbutton', 'combobox'] as const) {
      try {
        const roleLoc = page.getByRole(role, { name: fieldLabel, exact: false }).first()
        if (await roleLoc.isVisible({ timeout: 1_500 }).catch(() => false)) { loc = roleLoc; break }
      } catch { /* try next */ }
    }
  }

  // Strategy 7: XPath label proximity (visible text + nearest input)
  if (!loc) {
    for (const lbl of strictVariants) {
      try {
        const xpLoc = page.locator(
          `xpath=//label[contains(normalize-space(.),\"${lbl}\")]/following::input[not(@type=\"hidden\")][1]` +
          `|//label[contains(normalize-space(.),\"${lbl}\")]/parent::*/descendant::input[not(@type=\"hidden\")][1]` +
          `|//label[contains(normalize-space(.),\"${lbl}\")]/following::textarea[1]`,
        ).first()
        if (await xpLoc.isVisible({ timeout: 1_500 }).catch(() => false)) { loc = xpLoc; break }
      } catch { /* try next */ }
    }
  }

  if (!loc) {
    // Last resort: try as autocomplete (unknown type often means autocomplete)
    try {
      await fillWebAppAutocomplete(page, fieldLabel, value)
      return
    } catch { /* not an autocomplete either */ }

    // ── Label correction safety net ──────────────────────────────────────────
    // If no field was found, the AI label may not match the actual page label.
    // Scan visible page labels for a fuzzy match and retry once with the best match.
    log.warn(`[WEBAPP-ENGINE] Field "${fieldLabel}" not found — attempting label correction`)
    try {
      const correctedLabel = await page.evaluate((targetLabel: string) => {
        const root = document.querySelector(
          '[role="dialog"][aria-modal="true"], [role="dialog"], .modal, [class*="modal"]',
        ) || document.body
        const allLabels = Array.from(root.querySelectorAll('label, legend'))
          .map(el => el.textContent?.trim().replace(/^\*\s*/, '').trim() ?? '')
          .filter(t => t.length > 1 && t.length < 80)

        // Also collect aria-labels and placeholders
        const inputs = Array.from(root.querySelectorAll('input, textarea, select'))
        for (const inp of inputs) {
          const al = inp.getAttribute('aria-label')?.trim()
          if (al && al.length > 1) allLabels.push(al)
          const ph = inp.getAttribute('placeholder')?.trim()
          if (ph && ph.length > 1) allLabels.push(ph)
        }

        const unique = [...new Set(allLabels)]
        const targetLower = targetLabel.toLowerCase()
        const targetWords = new Set(targetLower.split(/\s+/))
        let bestMatch = ''
        let bestScore = 0

        for (const pl of unique) {
          const plLower = pl.toLowerCase()
          if (plLower === targetLower) return ''  // already exact — should have been found
          const plWords = new Set(plLower.split(/\s+/))
          let overlap = 0
          for (const w of targetWords) { if (plWords.has(w)) overlap++ }
          const total = Math.max(targetWords.size, plWords.size)
          let score = total > 0 ? overlap / total : 0
          // Containment boost
          if (plLower.includes(targetLower) || targetLower.includes(plLower)) {
            score = Math.max(score, 0.7)
          }
          if (score > bestScore && score >= 0.5) {
            bestScore = score
            bestMatch = pl
          }
        }
        return bestMatch
      }, fieldLabel)

      if (correctedLabel) {
        log.info(`[WEBAPP-ENGINE] Label corrected: "${fieldLabel}" → "${correctedLabel}" — retrying fill`)
        // Retry the entire fill with the corrected label (recursive, but only once)
        await fillWebAppField(page, correctedLabel, value)
        return
      }
    } catch { /* correction failed — throw original error */ }

    throw new Error(
      `[WEBAPP-ENGINE] Could not find field "${fieldLabel}". ` +
      `Tried: getByLabel, aria-label, getByPlaceholder, name/id attrs, data-testid, role+name, XPath proximity, autocomplete scan, label correction.`,
    )
  }

  // Before filling, confirm the actual element type
  const actualTag = await loc.evaluate((el) => el.tagName).catch(() => 'INPUT')
  const actualType = await loc.getAttribute('type').catch(() => 'text') ?? 'text'
  const actualRole = await loc.getAttribute('role').catch(() => '') ?? ''

  if (actualTag === 'SELECT') {
    await selectWebAppPicklist(page, fieldLabel, value)
    return
  }
  if (actualType === 'checkbox' || actualType === 'radio') {
    await fillWebAppCheckbox(page, fieldLabel, value)
    return
  }
  if (actualType === 'date' || actualType === 'datetime-local') {
    await fillWebAppDate(page, fieldLabel, value)
    return
  }
  // input[type=text] with role=combobox = autocomplete/lookup 
  if (actualTag === 'INPUT' && (actualType === 'text' || actualType === '') && actualRole === 'combobox') {
    await fillWebAppAutocomplete(page, fieldLabel, value)
    return
  }
  // Non-input combobox = true picklist trigger
  if (actualTag !== 'INPUT' && (actualRole === 'combobox' || actualRole === 'listbox')) {
    await selectWebAppPicklist(page, fieldLabel, value)
    return
  }

  // Standard text fill
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  try {
    await loc.fill(value, { timeout: 5_000 })
  } catch {
    await loc.click()
    await loc.clear().catch(() => {})
    await page.keyboard.type(value)
  }
  await page.keyboard.press('Tab')
  await page.waitForTimeout(300)
  log.info(`[WEBAPP-ENGINE] ✅ Filled text field "${fieldLabel}" = "${value}"`)
}
