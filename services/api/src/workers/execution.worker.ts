/**
 * Execution Worker — BullMQ Consumer
 *
 * This is the ONLY place where Playwright runs in the entire codebase.
 *
 * Salesforce Lightning field support:
 *   • Picklist       → selectSFPicklist()  — lightning-combobox click+option
 *   • Lookup field   → selectSFLookup()    — type-to-search + click result
 *   • Lookup adv.    → selectSFLookupAdvanced() — modal search + row click
 *   • Date field     → fillSFDate()        — format-aware date input
 *   • Dependent picklist / filtered lookup → same as picklist after parent set
 *   • VF page / iframe → switchframe action + frame-scoped locators
 *   • Autolaunched flow / trigger / validation → navigateFlow + assertToast
 *
 * Session management:
 *   • Saves Playwright storageState to sessions/{projectId}.json after login
 *   • Loads on next run — validates via /lightning/page/home redirect check
 *   • Uses frontdoor.jsp silent login (JSForce accessToken)
 */
import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { Worker, Job, Queue } from 'bullmq'
import { chromium, Browser, BrowserContext, Page, Locator, FrameLocator } from '@playwright/test'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import { getConnection, invalidateConnection } from '../modules/salesforce/lib/sf-connection.js'
import type { ExecutionJob, HealingJob, StepData } from '../shared/queue/job-types.js'
import type { ExecutionStepResult } from '../modules/execution/execution.schema.js'
import { generateAiSuggestions } from '../modules/self-healing/self-healing.service.js'
import { waitForResume, clearPause, resolvePause } from '../shared/execution/pause-gate.js'

const log = createModuleLogger('execution-worker')

// ─── Directory setup ──────────────────────────────────────────────────────────

const BASE_DIR        = path.resolve(process.cwd(), 'static')
const SCREENSHOTS_DIR = path.resolve(BASE_DIR, 'screenshots')
const TRACES_DIR      = path.resolve(BASE_DIR, 'traces')
const SESSIONS_DIR    = path.resolve(BASE_DIR, 'sessions')

for (const dir of [SCREENSHOTS_DIR, TRACES_DIR, SESSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function getSessionPath(projectId: string): string {
  return path.join(SESSIONS_DIR, `${projectId}.json`)
}

function sessionExists(projectId: string): boolean {
  const p = getSessionPath(projectId)
  try { return fs.existsSync(p) && fs.statSync(p).size > 10 } catch { return false }
}

async function saveSession(projectId: string, browserCtx: BrowserContext): Promise<void> {
  try {
    await browserCtx.storageState({ path: getSessionPath(projectId) })
    log.info(`[SESSION] ✅ Session saved → sessions/${projectId}.json`)
    await prisma.projects.update({
      where: { id: projectId },
      data: {
        ui_session_active:          true,
        ui_session_source:          'login',
        ui_session_last_created_at: new Date(),
      },
    }).catch((e: unknown) => log.warn({ e }, '[SESSION] DB flag update failed (non-fatal)'))
  } catch (err) {
    log.warn({ err }, '[SESSION] Failed to save session (non-fatal)')
  }
}

async function deleteSession(projectId: string): Promise<void> {
  const p = getSessionPath(projectId)
  try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* ignore */ }
  try {
    await prisma.projects.update({ where: { id: projectId }, data: { ui_session_active: false } })
  } catch { /* ignore */ }
  log.info(`[SESSION] Invalidated session for project ${projectId}`)
}

// ─── Healing queue producer ───────────────────────────────────────────────────

const healingQueue = new Queue<HealingJob>(QUEUES.HEALING, getRedisOptions())

// ─── Frame registry (per execution) ──────────────────────────────────────────
// Maps executionId → active FrameLocator (set by switchframe action)
const frameRegistry = new Map<string, FrameLocator>()

// ─── Playwright expression extractor ─────────────────────────────────────────

/**
 * When the AI generator emits a Playwright method-call string as the `target`
 * (e.g. `getByLabel('Type')`, `getByText("Customer")`, `getByRole('button',{name:'Save'})`),
 * extract just the plain text/label so SF field handlers can use it.
 *
 * Returns the original string unchanged if no known pattern is matched.
 *
 * Examples:
 *   getByLabel('Account Type')          → "Account Type"
 *   getByLabel("Type", { exact: true }) → "Type"
 *   getByText('Customer')               → "Customer"
 *   getByPlaceholder('Search...')       → "Search..."
 *   getByRole('button', { name: 'Save' }) → "Save"
 *   "Account Type"                      → "Account Type"  (passthrough)
 */
function extractLabelFromTarget(raw: string): string {
  if (!raw) return raw

  // getByLabel('...') / getByText('...') / getByPlaceholder('...')
  const simpleMatch = raw.match(
    /^(?:page\.)?getBy(?:Label|Text|Placeholder|Title|AltText)\s*\(\s*['"]([^'"]+)['"]/i,
  )
  if (simpleMatch) return simpleMatch[1].trim()

  // getByRole('button', { name: 'Save' }) or getByRole("combobox", {name:"Type"})
  const roleMatch = raw.match(
    /^(?:page\.)?getByRole\s*\(\s*['"][^'"]+['"]\s*,\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/i,
  )
  if (roleMatch) return roleMatch[1].trim()

  // locator('label=Type') or locator('text=Type')
  const locatorPrefixMatch = raw.match(/^(?:page\.)?locator\s*\(\s*['"](?:label=|text=)([^'"]+)['"]/i)
  if (locatorPrefixMatch) return locatorPrefixMatch[1].trim()

  return raw
}

// ─── SF-aware label resolver ──────────────────────────────────────────────────

/**
 * Generate candidate label variants to handle AI label ↔ SF UI label mismatches.
 *
 * Examples:
 *   "Account Type" → ["Account Type", "Type"]
 *   "Contact Phone" → ["Contact Phone", "Phone"]
 *   "Type"          → ["Type"]
 */
function labelCandidates(label: string): string[] {
  const candidates = [label]
  const parts = label.trim().split(/\s+/)
  if (parts.length > 1) {
    // Add the LAST word (e.g. "Type" from "Account Type")
    candidates.push(parts[parts.length - 1])
    // Add without the first word (e.g. "Type Standard" from "Account Type Standard")
    if (parts.length > 2) candidates.push(parts.slice(1).join(' '))
  }
  return [...new Set(candidates)]
}

/**
 * Multi-strategy Salesforce field container finder.
 *
 * SF Lightning renders labels as <span> inside <lightning-*> components —
 * not <label for="..."> — so getByLabel() often times out.
 *
 * Tries each candidate label variant ("Account Type", "Type") through:
 *  1. getByLabel (standard HTML / hardened a11y Spring '24+)
 *  2. XPath contains() — span.slds-form-element__label or <label>
 *  3. Placeholder match
 *  4. aria-label attribute match
 */
async function sfFindFieldContainer(
  page: Page,
  label: string,
): Promise<Locator | null> {
  const variants = labelCandidates(label)

  for (const lbl of variants) {
    // 1. Standard getByLabel
    try {
      const byLabel = page.getByLabel(lbl, { exact: false }).first()
      if (await byLabel.isVisible({ timeout: 2_000 })) return byLabel
    } catch { /* try next */ }

    // 2. XPath with contains() — tolerates extra whitespace or colon suffixes
    try {
      const xpathLoc = page.locator(
        `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::*[starts-with(local-name(),"lightning-") or contains(@class,"slds-form-element")][1]` +
        `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::*[starts-with(local-name(),"lightning-") or contains(@class,"slds-form-element")][1]`,
      ).first()
      if (await xpathLoc.isVisible({ timeout: 2_000 })) return xpathLoc
    } catch { /* try next */ }

    // 3. Placeholder match
    try {
      const byPlaceholder = page.getByPlaceholder(lbl, { exact: false }).first()
      if (await byPlaceholder.isVisible({ timeout: 1_500 })) return byPlaceholder
    } catch { /* try next */ }

    // 4. aria-label attribute
    try {
      const byAria = page.locator(`[aria-label*="${lbl}"]`).first()
      if (await byAria.isVisible({ timeout: 1_500 })) return byAria
    } catch { /* try next */ }
  }

  return null
}

// ─── SF Picklist handler ──────────────────────────────────────────────────────

/**
 * Selects a value in a Salesforce picklist.
 *
 * Handles three SF picklist rendering modes:
 *  A) Native <select> (common in modal create forms)
 *  B) lightning-combobox → button[aria-haspopup=listbox] → [role=listbox] options
 *  C) Full-page combobox scan (when label lookup by text fails)
 */
async function selectSFPicklist(page: Page, rawLabel: string, optionValue: string, executionId = 'default'): Promise<void> {
  // Unwrap Playwright expression strings: getByLabel('Type') → 'Type'
  const fieldLabel = extractLabelFromTarget(rawLabel)
  if (fieldLabel !== rawLabel) log.info(`[SF-PICKLIST] Resolved label: "${rawLabel}" → "${fieldLabel}"`)
  log.info(`[SF-PICKLIST] Selecting "${optionValue}" in "${fieldLabel}"`)

  // Dismiss any ghost overlays from previous steps before interacting
  await dismissStaleOverlays(page)

  const variants = labelCandidates(fieldLabel)

  // ── Mode A: native <select> ─────────────────────────────────────
  // SF create/edit modals often render picklists as plain selects.
  for (const lbl of variants) {
    try {
      // Find a <select> sibling/child of a label containing the text
      const nativeSel = page.locator(
        `xpath=//label[contains(normalize-space(),"${lbl}")]/following-sibling::div//select` +
        `|//label[contains(normalize-space(),"${lbl}")]/parent::*/descendant::select` +
        `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::div[contains(@class,"slds-form-element")]//select`,
      ).first()
      if (await nativeSel.isVisible({ timeout: 2_000 })) {
        await nativeSel.selectOption({ label: optionValue })
        await page.waitForTimeout(400)
        log.info(`[SF-PICKLIST] ✅ Selected via native <select> for "${fieldLabel}"`)
        return
      }
    } catch { /* try next mode */ }
  }

  // ── Mode B: lightning-combobox / button[aria-haspopup=listbox] ──
  let triggerBtn: Locator | null = null

  // Try finding container first and extracting the trigger button
  const container = await sfFindFieldContainer(page, fieldLabel)
  if (container) {
    const btn = container.locator(
      'button[aria-haspopup="listbox"], [role="combobox"] > button, a[aria-haspopup="listbox"]',
    ).first()
    if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      triggerBtn = btn
    } else {
      // Container itself might be the trigger (e.g. getByLabel returned it)
      const tagHandle = await container.elementHandle()
      const tagName = await tagHandle?.getProperty('tagName').then(t => t.jsonValue()).catch(() => '')
      if (typeof tagName === 'string' && ['BUTTON', 'SELECT', 'INPUT'].includes(tagName.toUpperCase())) {
        triggerBtn = container as Locator
      }
    }
  }

  // XPath fallback using contains() for each label variant
  if (!triggerBtn) {
    for (const lbl of variants) {
      const xb = page.locator(
        `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::*[contains(@class,"slds-form-element")]//button[@aria-haspopup="listbox"]` +
        `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-combobox//button` +
        `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::*[contains(@class,"slds-form-element")]//button[@aria-haspopup="listbox"]`,
      ).first()
      if (await xb.isVisible({ timeout: 2_000 }).catch(() => false)) {
        triggerBtn = xb
        break
      }
    }
  }

  // ── Mode C: Full-page combobox scan ────────────────────────────
  // When label text search fails entirely (or empty label), scan all visible
  // combobox buttons and pick the one whose nearest label text matches variants.
  // Uses executionId-scoped tag to prevent cross-contamination between parallel runs.
  if (!triggerBtn) {
    log.warn(`[SF-PICKLIST] Label-based lookup failed for "${fieldLabel}" — scanning all comboboxes`)
    const picklistTag = `sf-picklist-${executionId}`
    triggerBtn = await page.evaluate(async ([variants, picklistTag]: [string[], string]) => {
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>('button[aria-haspopup="listbox"], [role="combobox"] > button'),
      ).filter(b => (b as HTMLElement).offsetParent !== null) // visible only

      // First pass: label-match
      if (variants.length > 0) {
        for (const btn of buttons) {
          const form = btn.closest('.slds-form-element, lightning-combobox, lightning-select')
          if (!form) continue
          const labelEl = form.querySelector('label, .slds-form-element__label')
          const labelText = labelEl?.textContent?.trim() ?? ''
          if (variants.some(v => v && labelText.toLowerCase().includes(v.toLowerCase()))) {
            btn.setAttribute('data-autotest-target', picklistTag)
            return true
          }
        }
      }

      // Second pass: no label to match — just pick the first visible combobox
      if (buttons.length > 0) {
        buttons[0].setAttribute('data-autotest-target', picklistTag)
        return true
      }
      return false
    }, [variants, picklistTag] as [string[], string])
      ? page.locator(`[data-autotest-target="${picklistTag}"]`).first()
      : null
  }

  if (!triggerBtn) {
    throw new Error(`[SF-PICKLIST] Could not locate picklist trigger for "${fieldLabel}" (tried: ${variants.join(', ')})`)
  }

  await triggerBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await triggerBtn.scrollIntoViewIfNeeded()
  await triggerBtn.click()

  // After the trigger click the picklist dropdown is open.
  // IMPORTANT: SF has multiple [role="listbox"] in the DOM simultaneously —
  // e.g. the Parent Account lookup has a hidden listbox that is LAST in DOM order.
  // Using .last() therefore grabs the wrong (hidden) element and times out.
  //
  // Fix: skip the listbox container and grab the first VISIBLE [role="option"]
  // that contains the target text directly.
  const allOptions = page.locator('[role="option"]').filter({ hasText: optionValue })
  const option = await getFirstVisibleLocator(allOptions, 8_000)
  await option.click()

  // Clean up the execution-scoped tag we added in Mode C
  const picklistTagCleanup = `sf-picklist-${executionId}`
  await page.evaluate((tag: string) => {
    document.querySelector(`[data-autotest-target="${tag}"]`)
      ?.removeAttribute('data-autotest-target')
  }, picklistTagCleanup).catch(() => {})

  await page.waitForTimeout(500)
  log.info(`[SF-PICKLIST] ✅ Selected "${optionValue}" in "${fieldLabel}"`)
}

// ─── SF Lookup handler ────────────────────────────────────────────────────────

/**
 * Types into a Salesforce Lightning Lookup field and picks the first matching result.
 * Falls back to Advanced Search if no dropdown appears.
 */
async function selectSFLookup(page: Page, rawLabel: string, searchValue: string): Promise<void> {
  // Unwrap Playwright expression strings: getByLabel('Account') → 'Account'
  const fieldLabel = extractLabelFromTarget(rawLabel)
  if (fieldLabel !== rawLabel) log.info(`[SF-LOOKUP] Resolved label: "${rawLabel}" → "${fieldLabel}"`)
  log.info(`[SF-LOOKUP] Searching "${searchValue}" in lookup "${fieldLabel}"`)

  // Dismiss any ghost overlays from previous steps before interacting
  await dismissStaleOverlays(page)

  // ── Find the lookup input and its parent container ─────────────────
  let lookupInput: Locator | null = null
  let lookupContainer: Locator | null = null   // lightning-lookup ancestor for scoped queries
  const POLL_TIMEOUT = 15_000
  const POLL_INTERVAL = 500
  const start = Date.now()

  while (!lookupInput && Date.now() - start < POLL_TIMEOUT) {
    // Strategy 1: container (sfFindFieldContainer) → inner input
    const container = await sfFindFieldContainer(page, fieldLabel)
    if (container) {
      const inner = container.locator('input[type="text"], input:not([type="hidden"])').first()
      if (await inner.isVisible({ timeout: 1_000 }).catch(() => false)) {
        lookupInput = inner
        // Walk up to find the lightning-lookup ancestor
        lookupContainer = container.locator('xpath=ancestor-or-self::lightning-lookup').last()
        if (!(await lookupContainer.isVisible({ timeout: 500 }).catch(() => false))) {
          lookupContainer = null  // ancestor not found, will use page scope
        }
        break
      }
    }

    // Strategy 2: XPath anchored on label → lightning-lookup → input
    if (!lookupInput) {
      const variants = labelCandidates(fieldLabel)
      for (const lbl of variants) {
        const xpLoc = page.locator(
          `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
          `|//label[contains(normalize-space(),"${lbl}")]/following-sibling::div//input[@type="text"]` +
          `|//span[contains(normalize-space(),"${lbl}")]/following::input[@placeholder][1]`,
        ).first()
        if (await xpLoc.isVisible({ timeout: 1_000 }).catch(() => false)) {
          lookupInput = xpLoc
          // Try to find scoped container from the found input
          const lkContainer = page.locator(`xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup`).first()
          if (await lkContainer.isVisible({ timeout: 500 }).catch(() => false)) {
            lookupContainer = lkContainer
          }
          break
        }
      }
    }

    if (!lookupInput) await page.waitForTimeout(POLL_INTERVAL)
  }

  if (!lookupInput) {
    throw new Error(`[SF-LOOKUP] Could not find lookup input for "${fieldLabel}" after ${POLL_TIMEOUT}ms`)
  }

  log.info(`[SF-LOOKUP] ✅ Found lookup input for "${fieldLabel}" (container scoped: ${!!lookupContainer})`)

  // ── Helper: activate input, clear it, type the value ──────────────
  // IMPORTANT: we NEVER call Playwright's .click() here because the
  // lightning-overlay-container (from the previous lookup's dropdown table)
  // may still be covering the input coordinates and would intercept the click.
  // Instead, we use evaluate() to fire JS focus+clear, and pressSequentially()
  // which sends keyboard events via CDP directly to the element — bypassing
  // z-index and overlay interception entirely.
  const activateAndType = async (value: string) => {
    await lookupInput!.scrollIntoViewIfNeeded()
    
    // JS-level focus so SF Aura/LWC event listeners fire inside a modal
    await lookupInput!.evaluate((el: HTMLElement) => {
      const input = el as HTMLInputElement
      input.focus()
      // Dispatch the events SF's LWC combobox uses to activate the lookup search
      input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('mouseup',   { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click',     { bubbles: true, cancelable: true }))
      input.dispatchEvent(new FocusEvent('focus',     { bubbles: true }))
    })
    await page.waitForTimeout(300)

    // Programmatically select all text inside the input
    await lookupInput!.evaluate((el: HTMLElement) => { 
      (el as HTMLInputElement).select() 
    })
    
    // Delete the selected text via keyboard event (this triggers React/Aura change trackers naturally)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(200)

    // pressSequentially targets the element via CDP keyboard events — no coordinates,
    // no overlay interception, just raw keyboard input to the focused element.
    // delay: 90ms — must exceed SF Aura's debounce threshold (~60ms) so the
    // full typed value triggers a single search request, not partial/empty results.
    await lookupInput!.pressSequentially(value, { delay: 90 })
    log.info(`[SF-LOOKUP] Typed "${value}" via pressSequentially (no click, 90ms delay)`)
  }

  // ── Try 1: full value ─────────────────────────────────────────────
  await activateAndType(searchValue)

  // ── Wait for autocomplete dropdown — scoped to lightning-lookup ────
  const scope = lookupContainer ?? page
  let dropdownVisible = await scope.locator('[role="listbox"]').first()
    .isVisible({ timeout: 8_000 }).catch(() => false)

  if (!dropdownVisible) {
    // ── Retry: previous lookup's overlay may still be intercepting ─────
    // Wait for any lingering overlay to close, then retry.
    // Use Tab (not Escape) to blur the field — Escape clears in-progress lookup selections
    // and can revert values on adjacent fields via SF's form event handlers.
    log.warn(`[SF-LOOKUP] No dropdown on first attempt for "${fieldLabel}" — Tab-blurring then retrying`)
    await page.keyboard.press('Tab').catch(() => {})
    await page.waitForTimeout(1_500)
    await activateAndType(searchValue)
    dropdownVisible = await scope.locator('[role="listbox"]').first()
      .isVisible({ timeout: 8_000 }).catch(() => false)
  }

  if (dropdownVisible) {
    log.info(`[SF-LOOKUP] Dropdown appeared for "${searchValue}"`)

    // Try to find a matching option (scoped)
    const optionLocators = [
      scope.locator('[role="option"]').filter({ hasText: searchValue }).first(),
      scope.locator('.slds-listbox__item').filter({ hasText: searchValue }).first(),
      scope.getByRole('option', { name: searchValue }).first(),
      scope.getByRole('option', { name: new RegExp(searchValue.split(' ')[0], 'i') }).first(),
      scope.locator('[role="option"]').first(),  // last resort: first available option
    ]

    for (const opt of optionLocators) {
      if (await opt.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await opt.scrollIntoViewIfNeeded().catch(() => {})
        await opt.click()
        // Wait for the dropdown to close naturally after selection.
        // DO NOT press Escape here — SF Lightning combobox interprets Escape
        // as "revert selection" which undoes the click and leaves only typed text,
        // producing the "Select an option from the picklist" validation error.
        await page.waitForTimeout(1_500)
        log.info(`[SF-LOOKUP] ✅ Selected "${searchValue}" via inline dropdown`)
        return
      }
    }
    log.warn(`[SF-LOOKUP] Dropdown was visible but no option matched "${searchValue}"`)
  } else {
    log.warn(`[SF-LOOKUP] No dropdown appeared after 8s for "${searchValue}" in "${fieldLabel}"`)
  }

  // ── Fallback: ArrowDown keyboard navigation ────────────────────────
  // Pressing ArrowDown from the focused input opens the dropdown in SF Lightning.
  log.warn(`[SF-LOOKUP] Trying ArrowDown keyboard nav for "${searchValue}"`)
  await lookupInput.press('ArrowDown')
  await page.waitForTimeout(800)

  const highlighted = (lookupContainer ?? page).locator('[aria-selected="true"], [role="option"].slds-has-focus, [role="option"]:first-child').first()
  if (await highlighted.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await lookupInput.press('Enter')
    await page.waitForTimeout(600)
    log.info(`[SF-LOOKUP] ✅ Selected via ArrowDown + Enter`)
    return
  }

  // ── Prefix retry ──────────────────────────────────────────────────
  const prefix = searchValue.slice(0, Math.min(3, searchValue.length))
  if (prefix.length < searchValue.length) {
    log.warn(`[SF-LOOKUP] Retrying with prefix "${prefix}" for "${fieldLabel}"`)
    await activateAndType(prefix)   // re-use the no-click helper
    await page.waitForTimeout(2_000)  // longer wait for prefix search

    const firstOpt = (lookupContainer ?? page).locator('[role="option"]').first()
    if (await firstOpt.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await firstOpt.scrollIntoViewIfNeeded().catch(() => {})
      await firstOpt.click()
      await page.waitForTimeout(600)
      log.info(`[SF-LOOKUP] ✅ Selected first result via prefix "${prefix}"`)
      return
    }
  }

  // ── Final Fallback: Advanced Search Modal ─────────────────────────
  // If no inline dropdown option matched, check if SF provided the "Advanced Search"
  // or "Show All Results" link at the bottom of the dropdown. If so, click it and
  // delegate to the advanced search handler (which handles the modal).
  log.warn(`[SF-LOOKUP] Prefix retry failed. Attempting Advanced Search modal fallback for "${fieldLabel}"`)
  
  // Find "Show All Results" or "Advanced Search" inside the listbox
  const advSearchBtn = (lookupContainer ?? page).locator(
    'button[title*="Advanced Search"], [data-value="actionAdvancedSearch"], lightning-base-combobox-item, .slds-listbox__item'
  ).filter({ hasText: /Show All|Advanced Search/i }).first()
  
  if (await advSearchBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    log.info(`[SF-LOOKUP] Found Advanced Search / Show All Results link. Clicking...`)
    await advSearchBtn.click().catch(() => {})
  } else {
    log.info(`[SF-LOOKUP] No Advanced Search link found. Pressing Enter to try to trigger it...`)
    await lookupInput.press('Enter')
  }

  await page.waitForTimeout(1_000)

  // Verify if the Advanced Search Modal actually opened.
  // IMPORTANT: We must NOT match the parent create/edit form modal!
  // The parent modal also has [role="dialog"] and contains field placeholders
  // like "Search Account's Warehouses..." which would match hasText: 'Search'.
  // The real Advanced Search modal always contains a data table (role="grid" or <table>).
  const advSearchModal = page.locator('[role="dialog"]').filter({ has: page.locator('table, [role="grid"]') }).first()
  // Fallback: try dialog with a title/header containing "Search" (not just any "Search" text in a child)
  const advSearchModalAlt = page.locator('[role="dialog"] header, [role="dialog"] h2, [role="dialog"] .slds-modal__header').filter({ hasText: 'Search' }).first()

  const isAdvSearchOpen =
    await advSearchModal.isVisible({ timeout: 4_000 }).catch(() => false) ||
    await advSearchModalAlt.isVisible({ timeout: 1_000 }).catch(() => false)

  if (isAdvSearchOpen) {
    log.info(`[SF-LOOKUP] Advanced Search modal detected (with table/grid). Delegating resolution...`)
    await selectSFLookupAdvanced(page, fieldLabel, searchValue, true)
    return
  }

  throw new Error(`[SF-LOOKUP] Could not select "${searchValue}" in lookup "${fieldLabel}" — dropdown did not appear, no matching inline option found, and advanced search declined to open.`)
}


// ─── SF Lookup Advanced Search ────────────────────────────────────────────────

/**
 * Opens the SF Lookup Advanced Search modal, searches, and clicks the matching row.
 * NOTE: This is only called for non-modal contexts (list views, record pages).
 * Do NOT add calls from inside create/edit form modals — the parent modal blocks clicks.
 */
async function selectSFLookupAdvanced(
  page: Page,
  fieldLabel: string,
  searchValue: string,
  alreadyOpen?: boolean
): Promise<void> {

  log.info(`[SF-LOOKUP-ADV] Advanced search for "${searchValue}" in "${fieldLabel}"`)

  if (!alreadyOpen) {
    // Click "Search..." or "Advanced Search" button that appears in the lookup dropdown
    const advBtn = page.locator(
      'button:has-text("Search"), [data-value*="advanced"], a.slds-show:has-text("Search")',
    ).first()

    if (await advBtn.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await advBtn.click()
    } else {
      // Press Enter in the lookup input to trigger advanced search
      const lookupInput = page.locator(
        `xpath=//span[normalize-space()="${fieldLabel}"]/ancestor::lightning-lookup//input`,
      ).first()
      await lookupInput.press('Enter')
    }
  }

  // Wait for the advanced search modal.
  // CRITICAL: Use .last() not .first() — when a WH CODE lookup opens Advanced Search
  // from inside a create/edit form modal, there are TWO [role="dialog"] elements
  // in lightning-overlay-container: (1) the parent form, (2) the Advanced Search modal.
  // .first() picks the parent form, which is the WRONG modal.
  // .last() picks the topmost (most recently opened) dialog = the Advanced Search.
  const modal = page.locator('[role="dialog"]').filter({ hasText: /Advanced Search|Search/i }).last()
  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  log.info(`[SF-LOOKUP-ADV] Modal is visible (using .last() for topmost dialog). Searching for "${searchValue}"...`)

  // ── Clear field and submit search ──────────────────────────────────────────
  // Use JS-level focus + fill instead of Playwright .click(), because the
  // lightning-overlay-container from the previous lookup can still intercept
  // pointer events even though the modal is visually on top.
  const modalInput = modal.locator('input[type="text"], input[placeholder*="Search"], input[placeholder*="search"]').first()
  if (await modalInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
    // JS-level focus and select-all — bypasses overlay interception entirely
    await modalInput.evaluate((el: HTMLElement) => {
      const inp = el as HTMLInputElement
      inp.focus()
      inp.select()
      inp.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
    })
    await page.waitForTimeout(200)
    await page.keyboard.press('Backspace')  // clear selected text
    await page.waitForTimeout(100)

    // Type via CDP keyboard events — no coordinate-based clicks needed
    await modalInput.pressSequentially(searchValue, { delay: 40 })
    await page.waitForTimeout(300)

    // Strategy 1: click the Search submit button explicitly via JS
    const submitBtn = modal.locator(
      'button:has-text("Search"), button[title="Search"], button[type="submit"], input[type="submit"]'
    ).first()
    if (await submitBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      // Use JS click to bypass overlay interception on the submit button too
      await submitBtn.evaluate((el: HTMLElement) => el.click())
      log.info(`[SF-LOOKUP-ADV] Clicked Search submit button (via JS)`)
    } else {
      // Strategy 2: press Enter with explicit focus
      await modalInput.focus()
      await modalInput.press('Enter')
      log.info(`[SF-LOOKUP-ADV] Pressed Enter to submit search`)
    }
  } else {
    log.warn(`[SF-LOOKUP-ADV] No search input found in modal — proceeding without re-search`)
  }

  // ── Wait for results with retry polling (up to 10s) ───────────────────────
  // SF Advanced Search modals can be slow to populate results — don't use a
  // fixed 2s wait; instead poll until rows appear or timeout.
  log.info(`[SF-LOOKUP-ADV] Waiting for result rows...`)

  // Build candidate locators ordered by specificity.
  // Each fires independently so we don't miss results rendered in different layouts.
  const candidateLocators = [
    // Exact text match in table row
    modal.locator('table tbody tr').filter({ hasText: searchValue }).first(),
    // Exact text match in ARIA row
    modal.locator('[role="row"]').filter({ hasText: searchValue }).first(),
    // Partial match: first word of search value (e.g. "Account" from "Account Warehouse 1")
    modal.locator('table tbody tr').filter({ hasText: searchValue.split(' ')[0] }).first(),
    modal.locator('[role="row"]').filter({ hasText: searchValue.split(' ')[0] }).first(),
    // Any table row (last resort)
    modal.locator('table tbody tr').first(),
    modal.locator('[role="row"]:not([role="row"] [role="row"])').nth(1), // skip header row
  ]

  let selectedRow: (typeof candidateLocators)[0] | null = null
  const pollStart = Date.now()
  const POLL_TIMEOUT = 10_000

  while (!selectedRow && Date.now() - pollStart < POLL_TIMEOUT) {
    for (const rowLoc of candidateLocators) {
      try {
        if (await rowLoc.isVisible({ timeout: 500 })) {
          selectedRow = rowLoc
          break
        }
      } catch { /* try next */ }
    }
    if (!selectedRow) await page.waitForTimeout(600)
  }

  if (!selectedRow) {
    // One last diagnostic: log what text is visible inside the modal
    const modalText = await modal.textContent().catch(() => '<unable to read>')
    log.error(`[SF-LOOKUP-ADV] Modal content (first 500 chars): ${modalText?.slice(0, 500)}`)
    throw new Error(`[SF-LOOKUP-ADV] No result rows found for "${searchValue}" in Advanced Search modal`)
  }

  // ── Select the row: LWS-safe cascade ──────────────────────────────────────
  //
  // Salesforce Lightning Web Security (LWS) sandboxes JavaScript run via
  // page.evaluate() — event dispatches fired from that context are silently
  // dropped by LWC component internals. We therefore rely exclusively on
  // Playwright CDP-based interactions (.click(), page.mouse.click()) which
  // send real browser input events that LWS cannot intercept.
  //
  // Priority order:
  //   A) Playwright native .click() on the record-name <a> link
  //      → selects the record AND closes the modal in one action (most reliable)
  //   B) Playwright native .click() on the first row's radio-column cell
  //   C) page.mouse.click() at multiple radio-column offsets + "Select" button
  //   D) page.mouse.click() directly on the record-name <a> bounding box
  //
  await selectedRow.scrollIntoViewIfNeeded().catch(() => {})

  const selectBtn = modal.locator('button:has-text("Select"), button[title="Select"]').first()
  let modalClosed = false

  /** Scroll Select button into view, then click it via CDP. Returns true if modal closed. */
  const clickSelectBtn = async (): Promise<boolean> => {
    await selectBtn.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(200)
    const selectBox = await selectBtn.boundingBox().catch(() => null)
    if (selectBox) {
      await page.mouse.click(
        selectBox.x + selectBox.width / 2,
        selectBox.y + selectBox.height / 2,
      )
      log.info(`[SF-LOOKUP-ADV] Mouse-clicked "Select" button`)
    } else {
      // Playwright native click as last resort (handles scroll + wait automatically)
      await selectBtn.click({ timeout: 3_000 }).catch(() => {})
      log.info(`[SF-LOOKUP-ADV] Playwright-clicked "Select" button`)
    }
    return modal.waitFor({ state: 'hidden', timeout: 8_000 }).then(() => true).catch(() => false)
  }

  /** True if Select button is now enabled (radio was accepted by LWC). */
  const isSelectEnabled = async (): Promise<boolean> => {
    await selectBtn.scrollIntoViewIfNeeded().catch(() => {})
    return selectBtn.isEnabled({ timeout: 2_500 }).catch(() => false)
  }

  // ── Strategy A: Playwright .click() on the record-name <a> link ───────────
  // This is the gold-standard approach: clicking the record name link in the
  // Advanced Search table both selects the record AND dismisses the modal.
  // .click() uses CDP DispatchMouseEvent at element coordinates — LWS cannot block it.
  log.info(`[SF-LOOKUP-ADV] Strategy A: Playwright .click() on record-name link`)
  const nameLink = selectedRow.locator('a[data-recordid], a[href*="/lightning/r/"], a').first()
  const nameLinkVisible = await nameLink.isVisible({ timeout: 3_000 }).catch(() => false)
  if (nameLinkVisible) {
    try {
      await nameLink.scrollIntoViewIfNeeded().catch(() => {})
      await nameLink.click({ timeout: 5_000 })
      log.info(`[SF-LOOKUP-ADV] Strategy A: .click() dispatched on record-name link`)
      modalClosed = await modal.waitFor({ state: 'hidden', timeout: 8_000 })
        .then(() => true).catch(() => false)
      if (modalClosed) log.info(`[SF-LOOKUP-ADV] ✅ Strategy A succeeded`)
      else log.warn(`[SF-LOOKUP-ADV] Strategy A: modal did not close — continuing`)
    } catch (e) {
      log.warn(`[SF-LOOKUP-ADV] Strategy A failed: ${(e as Error).message}`)
    }
  } else {
    log.warn(`[SF-LOOKUP-ADV] Strategy A: no visible <a> link in result row`)
  }

  // ── Strategy B: Playwright .click() on the first table cell (radio column) ─
  // The radio button's host cell responds to Playwright clicks even through
  // shadow DOM because CDP DispatchMouseEvent targets the viewport coordinate
  // of the cell, letting the browser's own hit-testing select the correct element.
  if (!modalClosed) {
    log.info(`[SF-LOOKUP-ADV] Strategy B: Playwright .click() on first row cell`)
    try {
      const firstCell = selectedRow.locator('td, th').first()
      const cellVisible = await firstCell.isVisible({ timeout: 2_000 }).catch(() => false)
      if (cellVisible) {
        await firstCell.scrollIntoViewIfNeeded().catch(() => {})
        await firstCell.click({ timeout: 4_000 })
        log.info(`[SF-LOOKUP-ADV] Strategy B: .click() on first cell`)
        await page.waitForTimeout(1_200)
        if (await isSelectEnabled()) {
          log.info(`[SF-LOOKUP-ADV] Strategy B: "Select" enabled — clicking it`)
          modalClosed = await clickSelectBtn()
          if (modalClosed) log.info(`[SF-LOOKUP-ADV] ✅ Strategy B succeeded`)
        } else {
          log.warn(`[SF-LOOKUP-ADV] Strategy B: "Select" still disabled — continuing`)
        }
      }
    } catch (e) {
      log.warn(`[SF-LOOKUP-ADV] Strategy B failed: ${(e as Error).message}`)
    }
  }

  // ── Strategy C: page.mouse.click() at multiple radio-column x-offsets ──────
  // Sends a raw CDP mouse event to the viewport coordinate of the radio button.
  // We try several x-offsets from the row left edge, checking isEnabled() after
  // each attempt so we stop as soon as the radio registers.
  if (!modalClosed) {
    log.info(`[SF-LOOKUP-ADV] Strategy C: raw mouse clicks at multiple radio-column offsets`)
    const rowBox = await selectedRow.boundingBox().catch(() => null)
    if (rowBox) {
      const rowMidY = rowBox.y + rowBox.height / 2
      // Typical SF Lightning radio column positions: 12–35 px from row left edge
      for (const xOffset of [12, 20, 30, 35, 8]) {
        const clickX = rowBox.x + xOffset
        const clickY = rowMidY
        // Ensure coordinate is inside the viewport
        if (clickX < 0 || clickY < 0) continue
        await page.mouse.click(clickX, clickY)
        log.info(`[SF-LOOKUP-ADV] Strategy C: mouse click at (${clickX.toFixed(0)}, ${clickY.toFixed(0)}) [x+${xOffset}]`)
        await page.waitForTimeout(1_000)
        if (await isSelectEnabled()) {
          log.info(`[SF-LOOKUP-ADV] Strategy C: "Select" enabled after x+${xOffset} click`)
          modalClosed = await clickSelectBtn()
          if (modalClosed) {
            log.info(`[SF-LOOKUP-ADV] ✅ Strategy C succeeded`)
            break
          }
        }
      }
    } else {
      log.warn(`[SF-LOOKUP-ADV] Strategy C: no bounding box for result row`)
      // Attempt a Playwright force-click on the row as a fallback within Strategy C
      await selectedRow.click({ force: true, timeout: 3_000 }).catch(() => {})
      await page.waitForTimeout(1_000)
      if (await isSelectEnabled()) {
        log.info(`[SF-LOOKUP-ADV] Strategy C force-click: "Select" enabled`)
        modalClosed = await clickSelectBtn()
      }
    }
  }

  // ── Strategy D: page.mouse.click() directly on the record-name <a> position ─
  // Different from Strategy A: we get the bounding box and send a raw CDP mouse
  // event rather than using Playwright's .click() — useful if .click() was
  // intercepted by an overlay but the coordinates are still clear.
  if (!modalClosed) {
    log.warn(`[SF-LOOKUP-ADV] Strategy D: page.mouse.click() on record-name link viewport coords`)
    const nameLinkBox = await nameLink.boundingBox().catch(() => null)
    if (nameLinkBox) {
      await page.mouse.click(
        nameLinkBox.x + nameLinkBox.width / 2,
        nameLinkBox.y + nameLinkBox.height / 2,
      )
      log.info(`[SF-LOOKUP-ADV] Strategy D: mouse click dispatched on link`)
      modalClosed = await modal.waitFor({ state: 'hidden', timeout: 8_000 })
        .then(() => true).catch(() => false)
      if (modalClosed) log.info(`[SF-LOOKUP-ADV] ✅ Strategy D succeeded`)
    } else {
      log.warn(`[SF-LOOKUP-ADV] Strategy D: no bounding box for record-name link`)
    }
  }

  // ── Escalation: Escape key ────────────────────────────────────────────────
  if (!modalClosed) {
    log.warn(`[SF-LOOKUP-ADV] All strategies exhausted — pressing Escape to close modal`)
    await page.keyboard.press('Escape')
    modalClosed = await modal.waitFor({ state: 'hidden', timeout: 4_000 })
      .then(() => true).catch(() => false)
  }

  // ── Last resort: forcibly remove ONLY the topmost dialog from DOM ───────
  // Do NOT remove all dialogs — that destroys the parent create/edit form modal.
  if (!modalClosed) {
    log.warn(`[SF-LOOKUP-ADV] Modal STILL open — force-removing TOPMOST dialog only`)
    await page.evaluate(() => {
      const dialogs = document.querySelectorAll('lightning-overlay-container section[role="dialog"]')
      const backdrops = document.querySelectorAll('lightning-overlay-container .slds-backdrop')
      if (dialogs.length > 1) {
        dialogs[dialogs.length - 1].remove()
        if (backdrops.length > 0) backdrops[backdrops.length - 1].remove()
      }
    })
    await page.waitForTimeout(500)
  }

  await page.waitForTimeout(800)
  log.info(`[SF-LOOKUP-ADV] ✅ Selected "${searchValue}" via advanced search`)
}


// ─── SF Date Field handler ────────────────────────────────────────────────────

/**
 * Fills a Salesforce date input. SF uses standard <input type="text"> formatted MM/DD/YYYY
 * for lightning-datepicker components (not <input type="date">).
 */
async function fillSFDate(page: Page, rawLabel: string, dateValue: string): Promise<void> {
  const fieldLabel = extractLabelFromTarget(rawLabel)
  if (fieldLabel !== rawLabel) log.info(`[SF-DATE] Resolved label: "${rawLabel}" → "${fieldLabel}"`)
  log.info(`[SF-DATE] Setting date "${dateValue}" in "${fieldLabel}"`) 

  // Dismiss any ghost overlays from previous steps before interacting
  await dismissStaleOverlays(page)

  // Normalize date to MM/DD/YYYY (accepts ISO 8601: 2025-12-31 → 12/31/2025)
  let formatted = dateValue
  const isoMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    formatted = `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1]}`
  }

  const container = await sfFindFieldContainer(page, fieldLabel)
  let dateInput: Locator | null = null

  if (container) {
    dateInput = container.locator('input[type="text"], input[placeholder*="/"]').first()
  }
  if (!dateInput || !(await dateInput.isVisible({ timeout: 2_000 }).catch(() => false))) {
    dateInput = page.locator(
      `xpath=//span[normalize-space()="${fieldLabel}"]/ancestor::lightning-datepicker//input` +
      `|//label[normalize-space()="${fieldLabel}"]/following::input[@type="text"][1]`,
    ).first()
  }

  await dateInput!.waitFor({ state: 'visible', timeout: 10_000 })
  await dateInput!.scrollIntoViewIfNeeded()
  await dateInput!.click({ clickCount: 3 }) // triple-click to select all existing text
  await dateInput!.fill(formatted)
  await dateInput!.press('Tab') // confirm + close datepicker
  await page.waitForTimeout(400)
  log.info(`[SF-DATE] ✅ Date "${formatted}" set in "${fieldLabel}"`)
}

// ─── Smart locator resolver ───────────────────────────────────────────────────

function resolveLocator(page: Page, step: StepData): Locator {
  let target      = step.target ?? ''
  let locatorType = (step.locator_type ?? '').toLowerCase().trim()
  const action    = (step.action || '').toLowerCase().replace(/[-_\s]/g, '')

  // Unwrap Playwright expression strings (e.g. getByLabel('Type') → 'Type')
  const extracted = extractLabelFromTarget(target)
  if (extracted !== target) {
    const raw = step.target ?? ''
    const isRole = /^(?:page\.)?getByRole/i.test(raw)
    
    // For getByRole strings, case 'role' needs to parse the full string, so DO NOT overwrite target
    if (!isRole) {
      target = extracted
    }
    
    // Force the locator type based on the function used
    if (/^(?:page\.)?getByLabel/i.test(raw))      locatorType = 'label'
    else if (/^(?:page\.)?getByText/i.test(raw))   locatorType = 'text'
    else if (/^(?:page\.)?getByPlaceholder/i.test(raw)) locatorType = 'placeholder'
    else if (isRole)                               locatorType = 'role'
    else if (/^(?:page\.)?getByTitle/i.test(raw))  locatorType = 'title'
    else if (/^(?:page\.)?getByAltText/i.test(raw)) locatorType = 'alt'
  }

  // API Name to Label Normalization (Custom_Field__c → Custom Field)
  if (/__(c|r|C|R)$/.test(target)) {
    target = target.slice(0, -3).replace(/_/g, ' ').trim()
  }

  // Auto-detect locator_type from target pattern
  if (!locatorType || locatorType === 'css') {
    if (/^role=\w+,\s*name=/.test(target))       locatorType = 'role'
    else if (target.startsWith('label='))          { locatorType = 'label'; target = target.slice(6) }
    else if (target.startsWith('text='))           { locatorType = 'text';  target = target.slice(5) }
    else if (!target.match(/[.#\[\]>:=]/) && target.length > 0) locatorType = 'label'
  }

  // Normalise AI-generated variants
  if (['role_button','button_role','button','btn'].includes(locatorType)) {
    locatorType = 'role'
    if (!/^role=\w+,\s*name=/.test(target) && !target.includes(':')) target = `button:${target}`
  }
  if (['field_label','get_by_label','by_label','field_name'].includes(locatorType)) locatorType = 'label'
  if (['get_by_text','by_text','inner_text'].includes(locatorType))                 locatorType = 'text'
  if (target.startsWith('getByRole(') || target.startsWith('page.getByRole(')) locatorType = 'role'

  switch (locatorType) {
    case 'label':
      if (action === 'click') {
        return page.getByLabel(target, { exact: false })
          .or(page.getByRole('link', { name: target, exact: false }))
          .or(page.getByRole('button', { name: target, exact: false }))
          .or(page.getByText(target, { exact: false }))
      }
      return page.getByLabel(target, { exact: false })

    case 'placeholder':
      return page.getByPlaceholder(target, { exact: false })

    case 'text':
      return page.getByText(target, { exact: false })

    case 'role': {
      // For clickable roles (button, link, menuitem, tab, option) use exact:true so that
      // 'name=Save' does NOT substring-match 'Save & New'. Input roles (textbox, combobox, etc.)
      // keep exact:false so partial label matching still works.
      const EXACT_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'treeitem'])

      const getByRoleMatch = target.match(
        /^(?:page\.)?getByRole\(\s*['"]([A-Za-z0-9_-]+)['"]\s*(?:,\s*\{\s*name:\s*['"]([^'"]+)['"]\s*\}\s*)?\)$/,
      )
      if (getByRoleMatch) {
        const role = getByRoleMatch[1].trim() as Parameters<Page['getByRole']>[0]
        return page.getByRole(role, { name: getByRoleMatch[2]?.trim(), exact: EXACT_ROLES.has(role) })
      }
      const roleMatch = target.match(/^role=(\w+),\s*name=(.+)$/)
      if (roleMatch) {
        const role = roleMatch[1].trim() as Parameters<Page['getByRole']>[0]
        return page.getByRole(role, { name: roleMatch[2].trim(), exact: EXACT_ROLES.has(role) })
      }
      const colonIdx = target.indexOf(':')
      if (colonIdx > -1) {
        const role = target.slice(0, colonIdx).trim() as Parameters<Page['getByRole']>[0]
        return page.getByRole(role, { name: target.slice(colonIdx + 1).trim(), exact: EXACT_ROLES.has(role) })
      }
      return page.getByRole(target as Parameters<Page['getByRole']>[0], { exact: false })
    }

    case 'testid':
    case 'test-id':
    case 'data-testid':
      return page.getByTestId(target)

    case 'title':
      return page.getByTitle(target, { exact: false })

    case 'alt':
    case 'alttext':
    case 'alt-text':
      return page.getByAltText(target, { exact: false })

    default:
      return page.locator(target)
  }
}

// ─── Stale overlay dismissal ─────────────────────────────────────────────────

/**
 * Dismisses any residual SF Lightning overlays left over from a previous
 * lookup, picklist, or modal step that did not fully clean up the DOM.
 *
 * These "ghost" overlays remain invisible but still intercept pointer events,
 * causing subsequent field interactions to miss their targets entirely.
 *
 * Called at the top of every SF field handler before any interaction.
 */
async function dismissStaleOverlays(page: Page): Promise<void> {
  try {
    const stale = page.locator(
      'lightning-overlay-container .slds-backdrop_open, ' +
      'lightning-overlay-container section[role="dialog"]',
    )
    const count = await stale.count()
    if (count === 0) return
    log.info(`[OVERLAY] ⚠️  ${count} stale overlay(s) detected — dismissing with Escape`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  } catch { /* no overlay present — continue */ }
}

// ─── Visibility helper ────────────────────────────────────────────────────────

async function getFirstVisibleLocator(baseLocator: Locator, timeout = 15_000): Promise<Locator> {
  const startTime = Date.now()
  
  while (Date.now() - startTime < timeout) {
    const count = await baseLocator.count()
    const globalLocators: Locator[] = []
    
    for (let i = 0; i < count; i++) {
      const l = baseLocator.nth(i)
      if (await l.isVisible()) {
        const isGlobal = await l.evaluate(
          el => !!el.closest('one-app-nav-bar, .slds-global-header_container')
        ).catch(() => false)
        
        if (!isGlobal) {
          return l // Priority match inside main content
        } else {
          globalLocators.push(l)
        }
      }
    }
    
    // If we only found elements in the global header, delay returning them
    // to give the SPA page content up to 3000ms to render a better match.
    if (globalLocators.length > 0 && Date.now() - startTime > 3_000) {
      return globalLocators[0]
    }
    
    await baseLocator.page().waitForTimeout(400)
  }
  return baseLocator.first()
}

// ─── Modal-scoped resolution ──────────────────────────────────────────────────

/**
 * SF Lightning opens create/edit forms inside a modal overlay.
 * Page-level `getByLabel('Account Name')` matches BOTH:
 *   1. The actual form input inside the modal
 *   2. A hidden column-width resizer (`<input type="range" aria-label="Account Name column width">`)
 *
 * This helper detects an open modal and resolves the locator within it first.
 * Falls back to page-wide if no match is found inside the modal.
 */
async function modalScopedResolve(page: Page, step: StepData): Promise<Locator> {
  // ── Wait for modal to appear ──────────────────────────────────
  // After clicking "New" / "Edit", SF takes 1-5 seconds to render the modal.
  // We poll for up to 8 seconds before giving up.
  const modal = page.locator(
    '[role="dialog"][aria-modal="true"], [role="dialog"].slds-modal, div.slds-modal.slds-fade-in-open',
  ).first()

  let modalOpen = false
  const modalStart = Date.now()
  while (Date.now() - modalStart < 8_000) {
    modalOpen = await modal.isVisible().catch(() => false)
    if (modalOpen) break
    await page.waitForTimeout(400)
  }

  // Resolve target label once — used in both modal-scoped and page-wide paths
  const extracted = extractLabelFromTarget(step.target ?? '')
  const locatorType = (step.locator_type ?? '').toLowerCase().trim()

  if (modalOpen) {
    log.info(`[MODAL-SCOPE] Modal detected — scoping locators within it`)

    // Get the modal content area
    const modalBody = modal.locator(
      '.slds-modal__content, .modal-body, .slds-p-around_medium, form, records-record-edit-form',
    ).first()
    const scope = (await modalBody.isVisible({ timeout: 2_000 }).catch(() => false))
      ? modalBody
      : modal

    // Try getByLabel inside modal first (most common).
    // IMPORTANT: iterate ALL label variants (e.g. "Business Phone" → ["Business Phone", "Phone"])
    // because SF metadata labels (e.g. "Business Phone") differ from what Lightning renders ("Phone").
    if (!locatorType || locatorType === 'label' || locatorType === 'css') {
      const variants = labelCandidates(extracted)
      for (const lbl of variants) {
        const allLabels = scope.getByLabel(lbl, { exact: false })
        const labelCount = await allLabels.count()
        for (let li = 0; li < labelCount; li++) {
          const labelLoc = allLabels.nth(li)
          if (!(await labelLoc.isVisible().catch(() => false))) continue
          const inputType = await labelLoc.evaluate(
            el => (el as HTMLInputElement).type?.toLowerCase() ?? '',
          ).catch(() => '')
          // Skip range sliders and hidden inputs
          if (inputType === 'range' || inputType === 'hidden') continue
          log.info(`[MODAL-SCOPE] ✅ Found "${extracted}" inside modal via getByLabel("${lbl}") (nth ${li})`)
          return labelLoc
        }
      }

      // Try input/textarea within form-element that has the label text — using all variants
      for (const lbl of variants) {
        const xpathInModal = scope.locator(
          `xpath=.//label[contains(normalize-space(),"${lbl}")]/ancestor::*[contains(@class,"slds-form-element")][1]//input[not(@type="hidden") and not(@type="range")]` +
          `|.//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::*[contains(@class,"slds-form-element")][1]//input[not(@type="hidden") and not(@type="range")]` +
          `|.//label[contains(normalize-space(),"${lbl}")]/ancestor::*[contains(@class,"slds-form-element")][1]//textarea`,
        ).first()
        if (await xpathInModal.isVisible({ timeout: 2_000 }).catch(() => false)) {
          log.info(`[MODAL-SCOPE] ✅ Found "${extracted}" inside modal via XPath (label: "${lbl}")`)
          return xpathInModal
        }
      }
    }

    log.info(`[MODAL-SCOPE] No match inside modal for "${extracted}" — falling back to page-wide`)
  }

  // Fallback: page-wide resolution.
  // Also try label variants here — e.g. "Business Phone" may fail but "Phone" will succeed.
  if (!locatorType || locatorType === 'label' || locatorType === 'css') {
    const variants = labelCandidates(extracted)
    for (const lbl of variants) {
      const candidate = page.getByLabel(lbl, { exact: false })
      const count = await candidate.count()
      for (let i = 0; i < count; i++) {
        const loc = candidate.nth(i)
        if (!(await loc.isVisible({ timeout: 1_500 }).catch(() => false))) continue
        const inputType = await loc.evaluate(
          el => (el as HTMLInputElement).type?.toLowerCase() ?? '',
        ).catch(() => '')
        if (inputType === 'range' || inputType === 'hidden') continue
        const isGlobal = await loc.evaluate(
          el => !!el.closest('one-app-nav-bar, .slds-global-header_container'),
        ).catch(() => false)
        if (isGlobal) continue
        log.info(`[PAGE-SCOPE] ✅ Found "${extracted}" page-wide via getByLabel("${lbl}") (nth ${i})`)
        return loc
      }
    }
  }
  return getFirstVisibleLocator(resolveLocator(page, step), 10_000)
}

// ─── Action executor ──────────────────────────────────────────────────────────

async function executeStep(
  page: Page,
  step: StepData,
  stepIndex: number,
  isLastStep: boolean,
  screenshotsDir: string,
  executionId: string,
  // SF session recovery — passed from processExecution
  browserCtx?: BrowserContext,
  projectId?: string,
  projectCategory?: string,
): Promise<ExecutionStepResult> {
  const start  = Date.now()
  const action = step.action.toLowerCase().replace(/[-_\s]/g, '')
  const target = step.target ?? ''
  const value  = step.value  ?? ''
  let screenshotPath: string | null = null

  // Resolve active page context (may be inside an iframe)
  const activeFrame = frameRegistry.get(executionId)

  // ── 2-attempt retry wrapper ────────────────────────────────────────────────
  // Transient SF Lightning failures (ghost overlays, slow LWC renders, race
  // conditions) are recoverable with a brief pause + Escape to reset DOM state.
  // Attempt 2 only fires if attempt 1 throws — not for skipped or passed steps.
  let lastStepError: Error | null = null

  for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    switch (action) {

      // ── Navigation ─────────────────────────────────────
      case 'navigate':
      case 'goto':
      case 'open': {
        const navUrl = value || target
        if (!navUrl) { log.warn(`[EXEC] NAVIGATE step ${stepIndex + 1} has no URL — skipping`); break }
        let resolvedUrl = navUrl
        if (navUrl.startsWith('/')) {
          try { resolvedUrl = `${new URL(page.url()).origin}${navUrl}` } catch { /* first step */ }
        }
        try {
          await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        } catch (navErr: unknown) {
          const msg = navErr instanceof Error ? navErr.message : String(navErr)
          if (!msg.includes('ERR_ABORTED')) throw navErr
          log.warn(`[EXEC] NAVIGATE: ERR_ABORTED ignored (SF SPA) at step ${stepIndex + 1}`)
        }
        // Clear frame context on navigation
        frameRegistry.delete(executionId)

        // ── SF Session Guard ────────────────────────────────────────────
        // Salesforce redirects expired sessions to /login with domcontentloaded
        // appearing to "succeed". Detect this redirect and re-authenticate
        // transparently before continuing to the next step.
        if (projectCategory === 'salesforce' && projectId && browserCtx) {
          // Increase settle wait to 4s — SF's inline login form renders AFTER
          // domcontentloaded, sometimes taking 3-4s for the LWC shell to detect
          // the expired session and swap in the login form.
          await page.waitForTimeout(4_000)
          const postNavUrl = page.url().toLowerCase()

          // Check 1: URL-based detection
          const isLoginUrl = postNavUrl.includes('/login')
            || postNavUrl.includes('/authorize')
            || postNavUrl.includes('secur/login')

          // Check 2: DOM-based detection — SF renders the login form INLINE at
          // the same URL when sessions expire, so URL checks miss it.
          // Use 8s timeout to give the LWC shell enough time to show the form.
          const hasLoginForm = !isLoginUrl && await page.locator(
            'input[name="username"], input[id="username"], input[name="un"]',
          ).first().isVisible({ timeout: 8_000 }).catch(() => false)

          if (isLoginUrl || hasLoginForm) {
            log.warn(
              `[EXEC] NAVIGATE step ${stepIndex + 1}: SF session expired ` +
              `(${isLoginUrl ? 'login URL redirect' : 'inline login form detected'}). ` +
              `Re-authenticating via JSForce...`,
            )
            invalidateConnection(projectId)
            deleteSession(projectId)
            await loginToSalesforce(page, browserCtx, projectId)
            log.info(`[EXEC] Re-auth OK — retrying navigation to ${resolvedUrl}`)
            try {
              await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
            } catch (retryErr: unknown) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
              if (!retryMsg.includes('ERR_ABORTED')) throw retryErr
            }
          }
        }

        // SF Lightning post-navigate stabilization:
        // domcontentloaded fires early but LWC/Aura components keep rendering.
        // Wait until at least one form element or Lightning component is visible
        // (up to 5s) so the next step doesn't hit an empty DOM.
        if (resolvedUrl.includes('/lightning/')) {
          await page.locator(
            '.slds-form, lightning-input, lightning-combobox, lightning-lookup, input[class*="slds"], ' +
            '.slds-table, .forceSalesPath, one-record-home-flexipage2, force-highlights-panel',
          ).first().waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {
            // Page may not have a form (e.g. list views) — that's fine, continue
          })
        }
        break
      }

      // ── Click ──────────────────────────────────────────
      case 'click': {
        if (activeFrame) {
          const frameLoc = activeFrame.locator(target)
          await frameLoc.waitFor({ state: 'visible', timeout: 15_000 })
          await frameLoc.click()
        } else {
          // Modal-scoped: find the element inside an open modal first
          const loc = await modalScopedResolve(page, step)
          await loc.waitFor({ state: 'visible', timeout: 15_000 })
          await loc.scrollIntoViewIfNeeded()
          await loc.click({ timeout: 15_000 })
        }
        break
      }

      // ── Fill / Type ────────────────────────────────────
      case 'type':
      case 'fill':
      case 'input': {
        // SF date fields need special handling (lightning-datepicker, MM/DD/YYYY format)
        if ((step as any).sf_field_type === 'date') {
          await fillSFDate(page, target, value)
          break
        }

        if (activeFrame) {
          const frameLoc = activeFrame.locator(target)
          await frameLoc.waitFor({ state: 'visible', timeout: 12_000 })
          await frameLoc.fill(value)
        } else {
          // Modal-scoped: find the input inside an open modal first
          const loc = await modalScopedResolve(page, step)
          await loc.waitFor({ state: 'visible', timeout: 15_000 })
          try {
            await loc.fill(value, { timeout: 10_000 })
          } catch {
            const inner = loc.locator('input:not([type="hidden"]):not([type="range"]), textarea').first()
            if (await inner.isVisible({ timeout: 2_000 }).catch(() => false)) {
              await inner.fill(value, { timeout: 10_000 })
            } else {
              // Try clicking + typing (contenteditable or rich text)
              await loc.click()
              await page.keyboard.type(value)
            }
          }
        }
        break
      }

      // ── SELECT — SF-aware dispatcher ───────────────────
      case 'select':
      case 'selectoption': {
        // Unwrap Playwright expression strings from target
        // e.g. getByLabel('Type') → 'Type', getByRole('button',{name:'Save'}) → 'Save'
        const resolvedTarget = extractLabelFromTarget(target)
        if (resolvedTarget !== target) {
          log.info(`[EXEC] SELECT: resolved target "${target}" → "${resolvedTarget}"`)
        }

        // ── Case: residual Playwright expression (no label extracted) ──
        // Happens when AI emits e.g. getByRole('combobox') with no {name:'...'}.
        // Execute the role/locator directly: click the first visible element,
        // then pick the option from the dropdown that opens.
        const stillPlaywrightExpr = /^(?:page\.)?getBy\w+\s*\(/.test(resolvedTarget)
        if (stillPlaywrightExpr) {
          log.info(`[EXEC] SELECT: target is a raw Playwright expression — direct role execution`)

          // getByRole('combobox') → click it, then pick option
          const roleOnlyMatch = resolvedTarget.match(
            /^(?:page\.)?getByRole\s*\(\s*['"]([^'"]+)['"]\s*\)\s*$/,
          )
          // getByRole('combobox') → iterate ALL visible comboboxes, open each one,
          // check if the target option value exists in its dropdown, and select it.
          // This prevents blindly clicking the first combobox (e.g. Parent Account lookup)
          // when the target value ('Customer') belongs to a different combobox (Type).
          if (roleOnlyMatch) {
            const role = roleOnlyMatch[1] as Parameters<Page['getByRole']>[0]
            const allComboboxes = page.getByRole(role)
            const count = await allComboboxes.count()
            log.info(`[EXEC] SELECT: found ${count} visible "${role}" elements — probing for "${value}"`)

            let selected = false
            for (let ci = 0; ci < count; ci++) {
              const cb = allComboboxes.nth(ci)
              if (!(await cb.isVisible().catch(() => false))) continue

              await cb.scrollIntoViewIfNeeded().catch(() => {})
              await cb.click()
              await page.waitForTimeout(600) // wait for dropdown to render

              // Check if any [role="option"] containing the value is now visible
              const matchingOpt = page.locator('[role="option"]').filter({ hasText: value })
              const optCount = await matchingOpt.count()
              let found = false
              for (let oi = 0; oi < optCount; oi++) {
                if (await matchingOpt.nth(oi).isVisible().catch(() => false)) {
                  await matchingOpt.nth(oi).click()
                  found = true
                  break
                }
              }

              if (found) {
                log.info(`[EXEC] SELECT: ✅ found "${value}" in combobox #${ci + 1}`)
                selected = true
                await page.waitForTimeout(500)
                break
              }

              // Close this dropdown (wrong combobox) and try the next one
              await page.keyboard.press('Escape')
              await page.waitForTimeout(300)
            }

            if (selected) break

            // None of the comboboxes had the option — last resort: try SF picklist handler
            log.warn(`[EXEC] SELECT: no combobox contained "${value}", falling back to SF picklist`)
            await selectSFPicklist(page, '', value, executionId)
            break
          }

          // Any other residual expr: fall through to picklist with an empty label
          // Mode C (full-page combobox scan) will handle it
          await selectSFPicklist(page, '', value, executionId)
          break
        }

        const sfType = (step as any).sf_field_type as string | undefined

        if (sfType === 'lookup' || sfType === 'lookup_advanced') {
          await selectSFLookup(page, resolvedTarget, value)
        } else if (sfType === 'date') {
          await fillSFDate(page, resolvedTarget, value)
        } else {
          // Check if there's a lightning-lookup ancestor (use contains() for label variants)
          const ltVariants = labelCandidates(resolvedTarget)
          let isLookup = false
          for (const lbl of ltVariants) {
            isLookup = await page.locator(
              `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup` +
              `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup`,
            ).first().isVisible({ timeout: 1_500 }).catch(() => false)
            if (isLookup) break
          }

          if (isLookup) {
            await selectSFLookup(page, resolvedTarget, value)
          } else {
            // Default: SF picklist (handles native <select>, lightning-combobox, full scan)
            await selectSFPicklist(page, resolvedTarget, value, executionId)
          }
        }
        break
      }

      // ── SF Lookup (explicit action) ────────────────────
      case 'lookup':
      case 'sflookup': {
        await selectSFLookup(page, target, value)
        break
      }

      // ── SF Picklist (explicit action) ──────────────────
      case 'picklist':
      case 'sfpicklist': {
        await selectSFPicklist(page, target, value, executionId)
        break
      }

      // ── SF Date ────────────────────────────────────────
      case 'date':
      case 'sfdate':
      case 'setdate': {
        await fillSFDate(page, target, value)
        break
      }

      // ── SF Record Type Selection ────────────────────────
      // Handles the record type selection dialog that Salesforce Lightning
      // shows before the create form when an object has multiple record types.
      // target = exact record type Name (e.g. "Damage", "Stock In")
      case 'selectrecordtype':
      case 'select_record_type':
      case 'chooserecordtype': {
        const rtName = target.trim()
        log.info(`[SF-RT] Selecting record type "${rtName}"`)

        // ── Helper: attempt to click a record type tile ─────────────────
        const trySelectRTTile = async (): Promise<boolean> => {
          // Data-value variants: SF sometimes uses developerName (spaces→underscores)
          const rtNormUnderscore = rtName.replace(/\s+/g, '_')
          const rtNormSpace      = rtName.replace(/_+/g, ' ')

          // Strategy 1a: [data-value="Damage"] exact
          // Strategy 1b: [data-value="Damage_Type"] (underscore variant)
          // Strategy 1c: [data-value] case-insensitive via XPath attr match
          for (const dv of [rtName, rtNormUnderscore, rtNormSpace]) {
            const loc = page.locator(`[data-value="${dv}"]`).first()
            if (await loc.isVisible({ timeout: 1_500 }).catch(() => false)) {
              await loc.scrollIntoViewIfNeeded().catch(() => {})
              await loc.click()
              log.info(`[SF-RT] ✅ Selected via data-value="${dv}"`)
              await page.waitForTimeout(500)
              return true
            }
          }

          // Strategy 2: radio label text — case-insensitive via filter
          const allLabels = page.locator(
            'input[type="radio"] + label, ' +
            '.slds-visual-picker__figure, ' +
            'span.slds-radio__label, ' +
            '.flowRuntimeRadio .slds-form-element__label',
          )
          const labelCount = await allLabels.count()
          for (let i = 0; i < labelCount; i++) {
            const lbl = allLabels.nth(i)
            if (!await lbl.isVisible().catch(() => false)) continue
            const text = (await lbl.textContent() ?? '').trim()
            if (text.toLowerCase() === rtName.toLowerCase()) {
              await lbl.scrollIntoViewIfNeeded().catch(() => {})
              await lbl.click()
              log.info(`[SF-RT] ✅ Selected via label text match "${text}"`)
              await page.waitForTimeout(500)
              return true
            }
          }

          // Strategy 3: dialog getByText case-insensitive
          const rtNameRegex = new RegExp(`^${rtName}$`, 'i')
          const inDialog = page.locator('[role="dialog"]').getByText(rtNameRegex).first()
          if (await inDialog.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await inDialog.scrollIntoViewIfNeeded().catch(() => {})
            await inDialog.click()
            log.info(`[SF-RT] ✅ Selected via dialog regex match`)
            await page.waitForTimeout(500)
            return true
          }

          // Strategy 4: page-wide text match (full-page RT selector, not a dialog)
          const pageWide = page.getByText(rtNameRegex).first()
          if (await pageWide.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await pageWide.scrollIntoViewIfNeeded().catch(() => {})
            await pageWide.click()
            log.info(`[SF-RT] ✅ Selected via page-wide regex match`)
            await page.waitForTimeout(500)
            return true
          }

          return false
        }

        // ── Phase 1: try to find the RT dialog as-is ────────────────────
        // Wait up to 8s for either an RT dialog or visual picker tiles
        await page.waitForSelector(
          '[role="dialog"]:has([data-value]), ' +
          '[data-value], ' +
          '.slds-visual-picker, ' +
          '.flowRuntimeRadio',
          { timeout: 8_000 },
        ).catch(() => {
          log.warn(`[SF-RT] RT dialog not found within 8s — will check if wrong form is open`)
        })

        if (await trySelectRTTile()) break

        // ── Phase 2: Recovery — SF may have auto-opened the default RT form ──
        // This happens when the user navigated to /new instead of the list view,
        // and their SF profile has a default record type set.
        // Fix: cancel/close the current form and navigate to the object list,
        // then click New to force the RT selection dialog.
        log.warn(`[SF-RT] RT dialog not interactable — checking if wrong form is open`)

        // Log what data-value tiles ARE visible for debugging
        const visibleTiles = await page.locator('[data-value]').evaluateAll(
          (els) => els.map((e) => e.getAttribute('data-value') ?? '').filter(Boolean),
        )
        if (visibleTiles.length > 0) {
          log.info(`[SF-RT] Visible data-value tiles: ${JSON.stringify(visibleTiles)}`)
        }

        // Check if we're currently on a create form (a form was already opened)
        const isFormOpen = await page.locator(
          '.slds-form, lightning-input, lightning-combobox, force-record-edit-row'
        ).first().isVisible({ timeout: 2_000 }).catch(() => false)

        if (isFormOpen) {
          log.info(`[SF-RT] Create form is already open (wrong RT). Cancelling to retry from list view...`)

          // Click Cancel to dismiss the current form
          const cancelBtn = page.locator('[role="button"]:has-text("Cancel"), button:has-text("Cancel")')
            .or(page.getByRole('button', { name: 'Cancel' })).first()
          if (await cancelBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await cancelBtn.click()
            await page.waitForTimeout(1_500)
          }

          // Navigate to the object list view to trigger the proper RT selection flow
          const currentUrl = page.url()
          const objectMatch = currentUrl.match(/\/lightning\/o\/([^/]+)/)
          if (objectMatch) {
            const objApiName = objectMatch[1]
            const listUrl = `/lightning/o/${objApiName}/list`
            log.info(`[SF-RT] Navigating to list view: ${listUrl}`)
            await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
            await page.waitForTimeout(2_500)

            // Click the New button from the list view — this ALWAYS shows the RT dialog
            const newBtn = page.getByRole('button', { name: 'New' }).first()
            await newBtn.waitFor({ state: 'visible', timeout: 10_000 })
            await newBtn.click()
            log.info(`[SF-RT] Clicked New from list view — waiting for RT dialog`)
            await page.waitForTimeout(2_000)

            // Retry selecting the record type
            if (await trySelectRTTile()) break
          }
        }

        // Log all visible RT labels for debugging
        const visibleLabels = await page.locator(
          'input[type="radio"] + label, .slds-visual-picker__figure, span.slds-radio__label'
        ).evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''))
        log.error(`[SF-RT] All strategies failed for "${rtName}". Visible tiles: ${JSON.stringify(visibleTiles)}, Visible labels: ${JSON.stringify(visibleLabels)}`)

        throw new Error(`[SF-RT] Could not select record type "${rtName}" — no matching tile found. Available: ${JSON.stringify([...visibleTiles, ...visibleLabels])}`)
      }

      // ── Checkbox ───────────────────────────────────────
      case 'check':
      case 'checkbox': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.check({ timeout: 10_000 })
        break
      }

      case 'uncheck': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.uncheck({ timeout: 10_000 })
        break
      }

      // ── Hover ──────────────────────────────────────────
      case 'hover': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.hover({ timeout: 10_000 })
        break
      }

      // ── Keyboard ───────────────────────────────────────
      case 'press':
      case 'keyboard': {
        await page.keyboard.press(value || target)
        break
      }

      // ── Wait ───────────────────────────────────────────
      case 'wait':
      case 'waitfor': {
        if (/^\d+$/.test(value)) {
          await page.waitForTimeout(parseInt(value, 10))
        } else {
          await page.waitForSelector(value || target, { timeout: 30_000 })
        }
        break
      }

      // ── Assert ─────────────────────────────────────────
      case 'assert':
      case 'assertvisible':
      case 'asserttext': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        if (value) {
          const text = await loc.textContent()
          if (!text?.includes(value)) {
            throw new Error(`Assertion failed: "${target}" text "${text}" does not contain "${value}"`)
          }
        }
        break
      }

      case 'asserturl': {
        const currentUrl = page.url()
        if (!currentUrl.includes(target)) {
          throw new Error(`URL assertion failed: "${currentUrl}" does not contain "${target}"`)
        }
        break
      }

      // ── Assert Toast (validation rule / flow / trigger) ─
      case 'asserttoast':
      case 'asserterror':
      case 'assertsuccess': {
        // SF Lightning renders toasts in several different DOM structures depending
        // on the page type (Aura, LWC, Experience Cloud, etc.).
        // We try them all and take whichever appears first.
        const toastSelectors = [
          '.slds-notify .slds-notify__content',           // Classic/Aura toast
          '[data-key="success"] .toastMessage',           // LWC success toast
          '[data-key="error"] .toastMessage',             // LWC error toast
          '[data-key="warning"] .toastMessage',           // LWC warning toast
          '[data-key="info"] .toastMessage',              // LWC info toast
          '.forceActionsText',                            // force:showToast legacy
          'force-toast .toastMessage',                   // web component variant
          '.toastMessage',                                // catch-all
          'lightning-toast .slds-notify__content',        // LWC lightning-toast
          '[role="status"]',                              // ARIA role fallback
        ]
        const toastLoc = page.locator(toastSelectors.join(', ')).first()

        let toastText: string | null = null
        try {
          await toastLoc.waitFor({ state: 'visible', timeout: 15_000 })
          toastText = await toastLoc.textContent()
        } catch {
          // Toast may have already auto-dismissed (SF toasts last ~3s).
          // Fall back: check if the page title/URL indicates a successful save.
          const pageText = await page.title().catch(() => '')
          const url = page.url()
          if (value) {
            const lv = value.toLowerCase()
            if (pageText.toLowerCase().includes(lv) || url.toLowerCase().includes('view')) {
              log.info(`[EXEC] Toast auto-dismissed but page title/URL confirms save: "${pageText}"`)
              break
            }
          }
          throw new Error(`Toast not found after 15s and no page-state fallback matched.`)
        }

        if (value && toastText && !toastText.toLowerCase().includes(value.toLowerCase())) {
          throw new Error(`Toast assertion failed: got "${toastText?.trim()}", expected to contain "${value}"`)
        }
        log.info(`[EXEC] Toast assertion passed: "${toastText?.trim()}"`)
        break
      }


      // ── URL Navigate (flow / VF page URL) ─────────────
      case 'navigateflow':
      case 'runflow':
      case 'trigger': {
        // Navigate to a Salesforce Flow URL or record page to trigger flow/trigger
        const flowUrl = value || target
        await page.goto(flowUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        await page.waitForTimeout(2_000)
        break
      }

      // ── VF Page / iframe support ───────────────────────
      case 'switchframe':
      case 'switchtoframe':
      case 'enterframe': {
        // target = iframe name, title attribute, or CSS selector of iframe
        let frameLocator: FrameLocator
        if (target.match(/[.#\[>]/)) {
          frameLocator = page.frameLocator(target)
        } else {
          // Try name first, then title partial match
          frameLocator = page.frameLocator(`iframe[name="${target}"], iframe[title*="${target}"]`)
        }
        // Verify frame is accessible
        await frameLocator.locator('body').waitFor({ state: 'attached', timeout: 10_000 })
        frameRegistry.set(executionId, frameLocator)
        log.info(`[EXEC] Switched to frame "${target}" for execution ${executionId}`)
        break
      }

      case 'exitframe':
      case 'switchtoparent': {
        frameRegistry.delete(executionId)
        log.info(`[EXEC] Exited frame context for execution ${executionId}`)
        break
      }

      // ── Scroll ─────────────────────────────────────────
      case 'scroll': {
        if (target) {
          await (await getFirstVisibleLocator(resolveLocator(page, step))).scrollIntoViewIfNeeded()
        } else {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        }
        break
      }

      // ── Explicit screenshot ────────────────────────────
      case 'screenshot': {
        const ssFile = `step-${stepIndex}-explicit-${Date.now()}.png`
        const ssPath = path.join(screenshotsDir, ssFile)
        await page.screenshot({ path: ssPath, fullPage: false })
        screenshotPath = `/screenshots/${executionId}/${ssFile}`
        break
      }

      // ── Clear cookies ──────────────────────────────────
      case 'clearcookies': {
        await page.context().clearCookies()
        break
      }

      // ── Unknown action ─────────────────────────────────
      default: {
        log.warn(`[EXEC] Unknown action "${step.action}" at step ${stepIndex + 1} — skipping`)
        return {
          step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
          status: 'skipped', message: `Unknown action "${step.action}" — skipped`,
          duration_ms: Date.now() - start, screenshot_path: null, error: null,
        }
      }
    }

    // Auto-screenshot on last step
    if (isLastStep && action !== 'screenshot') {
      const ssFile    = `step-${stepIndex + 1}-FINAL-${Date.now()}.png`
      const ssAbsPath = path.join(screenshotsDir, ssFile)
      try {
        await page.screenshot({ path: ssAbsPath, fullPage: false })
        screenshotPath = `/screenshots/${executionId}/${ssFile}`
      } catch { /* non-fatal */ }
    }

    return {
      step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
      status: 'passed', message: `Step ${stepIndex + 1} passed`,
      duration_ms: Date.now() - start, screenshot_path: screenshotPath, error: null,
    }

  } catch (err: unknown) {
    lastStepError = err instanceof Error ? err : new Error(String(err))

    if (attempt < 2) {
      log.warn(
        `[EXEC] ⚠️  Step ${stepIndex + 1} ("${step.action}") failed on attempt ${attempt} — ` +
        `retrying in 2s after DOM reset. Error: ${lastStepError.message}`,
      )
      // Reset DOM state: dismiss any lingering overlays/modals that caused the failure
      await dismissStaleOverlays(page).catch(() => {})
      await page.waitForTimeout(2_000)
      // Continue to attempt 2
      continue
    }

    // All attempts exhausted — capture failure screenshot and return failed result
    const errMsg     = lastStepError.message
    const failSsFile = `step-${stepIndex + 1}-FAILED-${Date.now()}.png`
    try {
      await page.screenshot({ path: path.join(screenshotsDir, failSsFile), fullPage: false })
      screenshotPath = `/screenshots/${executionId}/${failSsFile}`
    } catch { /* ignore */ }

    return {
      step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
      status: 'failed', message: `Step ${stepIndex + 1} failed (2 attempts): ${errMsg}`,
      duration_ms: Date.now() - start, screenshot_path: screenshotPath, error: errMsg,
    }
  }
  } // end retry loop

  // Should never reach here — the loop always returns inside try or catch
  return {
    step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
    status: 'failed', message: `Step ${stepIndex + 1} failed: unexpected retry loop exit`,
    duration_ms: Date.now() - start, screenshot_path: screenshotPath, error: 'Unexpected retry loop exit',
  }
}

// ─── Salesforce login ─────────────────────────────────────────────────────────

/** Returns true if the current page is a Salesforce login page (URL OR DOM). */
async function isSalesforceLoginPage(page: Page): Promise<boolean> {
  const url = page.url().toLowerCase()
  if (url.includes('/login') || url.includes('/authorize') || url.includes('secur/login')) {
    return true
  }
  // SF inline login: page URL stays the same but a login form appears in the DOM
  return page.locator(
    'input[name="username"], input[id="username"], input[name="un"]',
  ).first().isVisible({ timeout: 5_000 }).catch(() => false)
}

async function loginToSalesforce(
  page:       Page,
  browserCtx: BrowserContext,
  projectId:  string,
): Promise<void> {
  log.info(`[EXEC-SF] Getting JSForce connection for project ${projectId}...`)
  try {
    const conn = await getConnection(projectId)

    if (!conn.accessToken || !conn.instanceUrl) {
      throw new Error('JSForce connection missing accessToken or instanceUrl')
    }

    log.info('[EXEC-SF] Attempting silent login via frontdoor.jsp (attempt 1)')

    const instanceUrl  = conn.instanceUrl.startsWith('http')
      ? conn.instanceUrl
      : `https://${conn.instanceUrl}`
    const frontdoorUrl = `${instanceUrl}/secur/frontdoor.jsp?sid=${conn.accessToken}`

    await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    // Wait for SF to process and possibly redirect — inline login forms render after 2-3s
    await page.waitForTimeout(3_000)

    if (!(await isSalesforceLoginPage(page))) {
      log.info(`[EXEC-SF] ✅ frontdoor.jsp login OK → ${page.url()}`)
      await saveSession(projectId, browserCtx)
      return
    }

    // Attempt 1 failed — token is expired. Force a fresh connection.
    log.warn('[EXEC-SF] frontdoor.jsp showed login page (URL or DOM). Invalidating token and retrying...')
    invalidateConnection(projectId)
    const freshConn = await getConnection(projectId)
    const freshUrl   = `${freshConn.instanceUrl}/secur/frontdoor.jsp?sid=${freshConn.accessToken}`

    await page.goto(freshUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(3_000)

    if (await isSalesforceLoginPage(page)) {
      throw new Error(
        '[EXEC-SF] Salesforce silent login failed twice. ' +
        'Check credentials/OAuth token in the environment settings.'
      )
    }

    log.info(`[EXEC-SF] ✅ Retry frontdoor.jsp OK → ${page.url()}`)
    await saveSession(projectId, browserCtx)

  } catch (err) {
    log.error({ err }, '[EXEC-SF] Failed to login to Salesforce via JSForce')
    throw err
  }
}

// ─── WebApp login ─────────────────────────────────────────────────────────────

async function loginToWebApp(
  page:       Page,
  browserCtx: BrowserContext,
  context:    ExecutionJob['context'],
  projectId:  string,
): Promise<void> {
  if (!context.webLoginUrl || !context.webUsername || !context.webPassword) {
    log.info('[EXEC-WEB] No web credentials — skipping login'); return
  }

  const strategy = context.webLoginStrategy ?? 'form'

  if (strategy === 'basic_auth') {
    const url     = new URL(context.webLoginUrl)
    url.username  = context.webUsername
    url.password  = context.webPassword
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await saveSession(projectId, browserCtx)
    return
  }

  await page.goto(context.webLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const emailInput    = page.locator('input[type="email"], input[name*="user"], input[name*="email"]').first()
  const passwordInput = page.locator('input[type="password"]').first()

  try {
    await emailInput.waitFor({ state: 'visible', timeout: 8_000 })
    await emailInput.fill(context.webUsername)
    await passwordInput.fill(context.webPassword)
    await page.keyboard.press('Enter')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    log.info('[EXEC-WEB] ✅ Form login submitted')
    await saveSession(projectId, browserCtx)
  } catch {
    log.warn('[EXEC-WEB] Login form heuristic failed — continuing without session save')
  }
}

// ─── Browser state highlighting ─────────────────────────────────────────────

/**
 * The border-injection script, used in both addInitScript (for future pages)
 * and page.evaluate() (for the current page). Self-contained — creates the
 * border overlay + badge, defaults to 'running' state, and watches for
 * changes to document.body[data-autotest-state] via MutationObserver.
 */
const BORDER_INJECTION_SCRIPT = `
(function() {
  function inject() {
    if (document.getElementById('autotest-state-border')) return;
    if (!document.body) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject, { once: true });
      } else {
        setTimeout(inject, 30);
      }
      return;
    }

    // ── Inject keyframe animations for 'running' flicker ──────────────────
    if (!document.getElementById('autotest-state-style')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'autotest-state-style';
      styleEl.textContent =
        '@keyframes at-border-flicker{' +
          '0%,100%{border-color:#f59e0b;box-shadow:inset 0 0 20px rgba(245,158,11,0.35),0 0 0 2px rgba(245,158,11,0)}' +
          '50%{border-color:#fbbf24;box-shadow:inset 0 0 48px rgba(251,191,36,0.75),0 0 0 4px rgba(251,191,36,0.3)}' +
        '}' +
        '@keyframes at-badge-flicker{' +
          '0%,100%{opacity:1;background:#f59e0b}' +
          '50%{opacity:0.65;background:#fbbf24}' +
        '}';
      (document.head || document.documentElement).appendChild(styleEl);
    }

    var colors = {
      running: { border: '#f59e0b', shadow: 'rgba(245,158,11,0.35)', label: '\u25b6 RUNNING' },
      paused:  { border: '#3b82f6', shadow: 'rgba(59,130,246,0.35)',  label: '\u23f8 PAUSED' },
      passed:  { border: '#22c55e', shadow: 'rgba(34,197,94,0.35)',   label: '\u2705 PASSED' },
      failed:  { border: '#ef4444', shadow: 'rgba(239,68,68,0.35)',   label: '\u274c FAILED' }
    };

    var overlay = document.createElement('div');
    overlay.id = 'autotest-state-border';
    // Start with flicker animation active (running state)
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;pointer-events:none;z-index:2147483646;border:4px solid #f59e0b;box-sizing:border-box;animation:at-border-flicker 1s ease-in-out infinite;box-shadow:inset 0 0 20px rgba(245,158,11,0.35)';

    var badge = document.createElement('div');
    badge.id = 'autotest-state-badge';
    badge.textContent = '\u25b6 RUNNING';
    badge.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;padding:4px 16px;border-radius:0 0 10px 10px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.06em;color:#fff;background:#f59e0b;animation:at-badge-flicker 1s ease-in-out infinite';

    document.body.appendChild(overlay);
    document.body.appendChild(badge);

    function applyState() {
      var state = document.body.getAttribute('data-autotest-state') || 'running';
      var cfg = colors[state];
      if (!cfg) return;
      if (state === 'running') {
        // Flickering yellow — disable transition so animation takes full control
        overlay.style.transition  = 'none';
        overlay.style.animation   = 'at-border-flicker 1s ease-in-out infinite';
        overlay.style.borderColor = cfg.border;
        badge.style.animation     = 'at-badge-flicker 1s ease-in-out infinite';
        badge.style.background    = cfg.border;
      } else {
        // Solid color with smooth transition for paused / passed / failed
        overlay.style.animation   = 'none';
        overlay.style.transition  = 'border-color 0.4s ease,box-shadow 0.4s ease';
        overlay.style.borderColor = cfg.border;
        overlay.style.boxShadow   = 'inset 0 0 20px ' + cfg.shadow;
        badge.style.animation     = 'none';
        badge.style.background    = cfg.border;
      }
      badge.textContent = cfg.label;
    }

    applyState();

    new MutationObserver(applyState).observe(document.body, {
      attributes: true,
      attributeFilter: ['data-autotest-state']
    });
  }

  inject();
})();
`

/**
 * Sets up the browser state border for interactive mode.
 * Uses addInitScript so the border appears automatically on every page load.
 * Does NOT run page.evaluate on the current page (about:blank) — instead
 * the border appears naturally on the first real navigation.
 */
async function setupBrowserStateBorder(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript({ content: BORDER_INJECTION_SCRIPT })
}

/**
 * Changes the browser window border color. Call this to transition between states.
 */
async function setBrowserState(page: Page, state: 'running' | 'paused' | 'passed' | 'failed' | ''): Promise<void> {
  try {
    await page.evaluate((s) => {
      if (document.body) document.body.setAttribute('data-autotest-state', s)
    }, state)
  } catch { /* page may have navigated — non-fatal */ }
}

// ─── HITL: In-browser pause overlay ─────────────────────────────────────────

/**
 * Injects a floating "Test Paused" overlay panel directly into the Playwright-
 * controlled browser window. The overlay has Resume and Skip buttons.
 *
 * PRIMARY communication channel:
 *   <a href="/autotest-hitl-signal?action=resume" target="hidden-iframe">
 *   Clicking a native <a> link is pure HTML — immune to LWS, CSP, and all
 *   JavaScript sandboxing. Playwright's page.route() intercepts the iframe's
 *   navigation at the CDP Fetch domain layer.
 *
 * BACKUP channels (JS-based, fire when JS is available):
 *   - page.exposeFunction('__autotestHitlSignal') — direct Node.js callback
 *   - document.body.setAttribute('data-autotest-hitl-action') — polled by Node.js
 *   - sessionStorage.setItem('autotest-hitl-action') — survives DOM issues
 *   - hidden checkbox inputs — polled by Node.js as additional detection
 */
async function injectPauseOverlay(
  page: Page,
  executionId: string,
  stepNum: number,
  stepAction: string,
  stepTarget: string,
  stepValue: string,
  errorMsg: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await page.evaluate(
      ({ stepNum, stepAction, stepTarget, stepValue, errorMsg, timeoutMs }: {
        stepNum: number; stepAction: string; stepTarget: string;
        stepValue: string; errorMsg: string; timeoutMs: number
      }) => {
        // Remove any existing overlay
        document.getElementById('autotest-pause-overlay')?.remove()
        // Clear stale signals
        document.body.removeAttribute('data-autotest-hitl-action')
        try { sessionStorage.removeItem('autotest-hitl-action') } catch {}

        const TIMEOUT_SECS = Math.floor(timeoutMs / 1000)
        const overlay = document.createElement('div')
        overlay.id = 'autotest-pause-overlay'
        overlay.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:auto'

        const tgt = stepTarget ? stepTarget.replace(/</g, '&lt;') : stepAction
        const val = stepValue ? stepValue.replace(/</g, '&lt;') : ''
        const errTxt = (errorMsg || 'Failed \u2014 please complete this step manually.').replace(/</g, '&lt;')

        // ── Overlay HTML ────────────────────────────────────────────────
        // Resume/Skip are <a> tags targeting a hidden <iframe>.
        // Clicking a native link is pure HTML — no JS event handlers needed.
        // Playwright's page.route() intercepts the iframe request at CDP level.
        overlay.innerHTML = `<div id="autotest-pause-card" style="background:linear-gradient(135deg,#1a1f2e 0%,#232941 100%);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:28px 32px;width:420px;box-shadow:0 32px 80px rgba(0,0,0,0.6);position:relative;pointer-events:auto">
          <style>@keyframes at-slide{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}} #autotest-pause-card{animation:at-slide .3s ease both} #autotest-pause-card a.at-btn:hover{filter:brightness(1.15)} #autotest-pause-card a.at-btn:active{transform:scale(.97);opacity:.8}</style>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#f59e0b,#fbbf24);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">\u23F8</div>
            <div>
              <div style="color:#fff;font-size:16px;font-weight:700">Test Paused</div>
              <div style="color:#94a3b8;font-size:11px">AutoTest AI \u2022 Human-in-the-Loop</div>
            </div>
          </div>
          <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:16px"></div>
          <div style="margin-bottom:12px">
            <div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Action Required</div>
            <div style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:12px 14px">
              <span style="color:#f1f5f9;font-size:13px;font-weight:600">Step ${stepNum} &mdash; </span><span style="color:#fbbf24;font-size:13px;font-weight:600">${tgt}</span>${val ? '<br><span style="color:#10b981;font-size:13px;margin-top:4px;display:inline-block">' + val + '</span>' : ''}
            </div>
          </div>
          <div style="margin-bottom:16px">
            <div style="color:#94a3b8;font-size:10px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px">Error</div>
            <div style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:10px;padding:10px 12px;color:#fca5a5;font-size:12px;line-height:1.5;max-height:64px;overflow-y:auto">${errTxt}</div>
          </div>
          <div style="background:rgba(255,255,255,0.03);border-left:3px solid #4ade80;border-radius:6px;padding:10px 12px;color:#cbd5e1;font-size:12px;line-height:1.5;margin-bottom:16px">Complete the step above manually, then click Resume or Skip.</div>
          <iframe name="autotest-hitl-frame" style="display:none;width:0;height:0;border:none;position:absolute" aria-hidden="true"></iframe>
          <input type="checkbox" id="autotest-resume-chk" style="display:none;position:absolute" aria-hidden="true">
          <input type="checkbox" id="autotest-skip-chk" style="display:none;position:absolute" aria-hidden="true">
          <div style="display:flex;gap:10px">
            <a id="autotest-resume-btn" class="at-btn" href="/autotest-hitl-signal?action=resume" target="autotest-hitl-frame" style="flex:1;padding:12px 0;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:14px;font-weight:700;box-shadow:0 4px 12px rgba(34,197,94,.3);transition:filter .15s,transform .15s;pointer-events:auto;text-decoration:none;text-align:center;display:block;user-select:none;-webkit-user-select:none;line-height:1.2">\u25B6 Resume</a>
            <a id="autotest-skip-btn" class="at-btn" href="/autotest-hitl-signal?action=skip" target="autotest-hitl-frame" style="flex:1;padding:12px 0;border-radius:10px;cursor:pointer;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#cbd5e1;font-size:14px;font-weight:600;transition:filter .15s,transform .15s;pointer-events:auto;text-decoration:none;text-align:center;display:block;user-select:none;-webkit-user-select:none;line-height:1.2">\u23ED Skip Step</a>
          </div>
          <div style="margin-top:12px;text-align:center">
            <span style="color:#475569;font-size:11px">Auto-timeout in </span><span id="autotest-timer" style="color:#64748b;font-size:11px;font-weight:600">${Math.floor(TIMEOUT_SECS/60)}:${String(TIMEOUT_SECS%60).padStart(2,'0')}</span>
          </div>
        </div>`

        document.body.appendChild(overlay)

        // Countdown timer
        let remaining = TIMEOUT_SECS
        const timerEl = document.getElementById('autotest-timer')
        const timerInterval = setInterval(() => {
          remaining--
          if (remaining <= 0) { clearInterval(timerInterval); return }
          if (timerEl) {
            const m = Math.floor(remaining / 60)
            const s = remaining % 60
            timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`
          }
        }, 1000)

        // JS-based signal channels (backup — the <a> + iframe approach works
        // without JavaScript, but these provide additional redundancy)
        function handleAction(action: string, btnId: string) {
          clearInterval(timerInterval)
          const btn = document.getElementById(btnId) as HTMLElement | null
          if (btn) { btn.textContent = 'Processing\u2026'; btn.style.opacity = '0.6'; btn.style.pointerEvents = 'none' }
          const card = document.getElementById('autotest-pause-card') as HTMLElement | null
          if (card) { card.style.opacity = '0.6'; card.style.pointerEvents = 'none' }
          // Check hidden checkbox for DOM poll detection
          const chkId = action === 'resume' ? 'autotest-resume-chk' : 'autotest-skip-chk'
          const chk = document.getElementById(chkId) as HTMLInputElement | null
          if (chk) chk.checked = true
          // exposeFunction channel
          try { if (typeof (window as any).__autotestHitlSignal === 'function') { (window as any).__autotestHitlSignal(action) } } catch {}
          // DOM attribute
          document.body.setAttribute('data-autotest-hitl-action', action)
          // sessionStorage
          try { sessionStorage.setItem('autotest-hitl-action', action) } catch {}
        }

        // Attach JS event handlers as ADDITIONAL channels (may fail in LWS — non-fatal)
        try {
          const resumeBtn = overlay.querySelector('#autotest-resume-btn')
          const skipBtn = overlay.querySelector('#autotest-skip-btn')
          if (resumeBtn) {
            resumeBtn.addEventListener('click', (e) => {
              e.stopPropagation(); e.stopImmediatePropagation()
              handleAction('resume', 'autotest-resume-btn')
            }, { capture: true })
          }
          if (skipBtn) {
            skipBtn.addEventListener('click', (e) => {
              e.stopPropagation(); e.stopImmediatePropagation()
              handleAction('skip', 'autotest-skip-btn')
            }, { capture: true })
          }
        } catch { /* LWS may block addEventListener — the <a>+iframe channel handles it */ }
      },
      { stepNum, stepAction, stepTarget, stepValue, errorMsg, timeoutMs },
    )
    log.info(`[HITL] \u2705 Pause overlay injected for step ${stepNum} (execution ${executionId})`)
  } catch (err) {
    log.warn({ err }, '[HITL] Could not inject in-browser pause overlay (non-fatal)')
  }
}

/**
 * Removes the HITL pause overlay from the Playwright browser DOM.
 */
async function removePauseOverlay(page: Page): Promise<void> {
  try {
    await page.evaluate(() => document.getElementById('autotest-pause-overlay')?.remove())
  } catch { /* page may have navigated — non-fatal */ }
}

// ─── Core worker function ─────────────────────────────────────────────────────

async function processExecution(job: Job<ExecutionJob>): Promise<void> {
  const { testRunId: executionId, testCaseId, projectId, triggeredBy, context } = job.data
  log.info(
    `[EXEC] Starting ${executionId} ` +
    `(testCase=${testCaseId}, project=${projectId}, trigger=${triggeredBy})`,
  )

  const startTime = Date.now()

  // Mark RUNNING
  await prisma.test_runs.update({ where: { id: executionId }, data: { status: 'running' } })

  // Clear any stale frame context
  frameRegistry.delete(executionId)

  let browser:        Browser | null        = null
  let browserContext: BrowserContext | null = null
  let page:           Page | null           = null

  const stepResults: ExecutionStepResult[]       = []
  let finalStatus: 'PASSED' | 'FAILED' | 'ERROR' = 'PASSED'
  let errorMessage: string | null                 = null

  const execScreenDir = path.join(SCREENSHOTS_DIR, executionId)
  fs.mkdirSync(execScreenDir, { recursive: true })

  try {
    const isInteractive = context.interactive === true
    browser = await chromium.launch(
      isInteractive
        ? { headless: false, args: ['--start-maximized', '--no-sandbox', '--disable-setuid-sandbox'] }
        : { headless: true },
    )
    if (isInteractive) log.info(`[EXEC] 🖥️  Interactive (headed) browser launched for ${executionId}`)

    const traceFile  = path.join(TRACES_DIR, `${executionId}.zip`)
    const useSession = context.useSessionReuse !== false && !!projectId
    const hasSession = useSession && sessionExists(projectId)

    const createFresh = async (): Promise<{ ctx: BrowserContext; pg: Page }> => {
      const ctx = await browser!.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      })
      await ctx.tracing.start({ screenshots: true, snapshots: true })
      return { ctx, pg: await ctx.newPage() }
    }

    // ── Load or create browser context ───────────────────────────
    if (hasSession) {
      log.info(`[SESSION] Loading stored session for project ${projectId}`)
      try {
        browserContext = await browser.newContext({
          storageState:      getSessionPath(projectId),
          viewport:          { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
        })
        await browserContext.tracing.start({ screenshots: true, snapshots: true })
        page = await browserContext.newPage()
      } catch (loadErr) {
        log.warn({ loadErr }, '[SESSION] Failed to load stored session — starting fresh')
        const fresh = await createFresh()
        browserContext = fresh.ctx; page = fresh.pg
      }
    } else {
      const fresh = await createFresh()
      browserContext = fresh.ctx; page = fresh.pg
    }

    // ── Set up browser state border (interactive mode only) ────
    // addInitScript makes the border appear on every navigation (defaults to yellow/running).
    // No page.evaluate needed here — border will show on the first real page load.
    if (isInteractive && browserContext) {
      await setupBrowserStateBorder(browserContext)
    }

    // ── Login / session-validation phase ─────────────────────────
    if (!context.isLoginTest) {
      if (context.projectCategory === 'salesforce') {
        // Always run loginToSalesforce for Salesforce projects.
        // The stored session (loaded above) helps with SF app-shell caching,
        // but we ALWAYS do a fresh frontdoor.jsp auth on top to guarantee the
        // browser cookie is valid before executing any test steps.
        // loginToSalesforce now detects inline login forms (not just URL redirects)
        // so it correctly handles expired OAuth2 tokens that used to slip through.
        log.info(`[SESSION] Running Salesforce frontdoor.jsp login (hasStoredSession=${hasSession})`)
        try {
          await loginToSalesforce(page!, browserContext!, projectId)
        } catch (loginErr) {
          log.error({ loginErr }, '[SESSION] Salesforce login failed — test cannot proceed')
          throw loginErr
        }

      } else if (context.projectCategory === 'webapp' && context.webLoginStrategy !== 'none') {
        if (hasSession) {
          log.info('[SESSION] Using stored web app session — skipping login')
        } else {
          await loginToWebApp(page, browserContext, context, projectId)
        }
      }
    }

    // ── Step execution phase ──────────────────────────────────────
    let firstFailedLocator:     string | null = null
    let failedScreenshotBase64: string | null = null
    let failedHtmlSnippet:      string | null = null

    // ── HITL: Mutable resolve reference for signal channels ────
    let hitlSettleFn: ((action: 'resume' | 'skip') => void) | null = null
    let hitlRouteRegistered = false
    let hitlFnExposed = false

    for (let i = 0; i < context.steps.length; i++) {
      const step       = context.steps[i]
      const isLastStep = i === context.steps.length - 1
      const result     = await executeStep(
        page!, step, i, isLastStep, execScreenDir, executionId,
        browserContext ?? undefined,
        projectId,
        context.projectCategory,
      )
      stepResults.push(result)

      log.info(
        `[EXEC] Step ${i + 1}/${context.steps.length}: ${result.status}` +
        ` — ${step.action} "${step.target ?? ''}"`,
      )

      if (result.status === 'failed') {
        // ── HITL: Interactive pause on step failure ───────────────────────
        if (isInteractive && page) {
          log.warn(
            `[HITL] Step ${i + 1} failed in interactive mode — pausing for user intervention.`,
          )

          // Write 'paused' status to DB
          await prisma.test_runs.update({
            where: { id: executionId },
            data: {
              status: 'paused',
              logs: [...stepResults, { ...result, message: `⏸ Step ${i + 1} paused — waiting for manual completion` }],
            },
          }).catch((e: unknown) => log.warn({ e }, '[HITL] Failed to write paused status'))

          // ── Register CDP route interception ONCE ─────────────
          if (!hitlRouteRegistered) {
            try {
              await page.route('**/autotest-hitl-signal**', async (route) => {
                try {
                  const url = new URL(route.request().url())
                  const action = url.searchParams.get('action')
                  log.info(`[HITL] ⚡ CDP route intercepted: action="${action}"`)
                  if (hitlSettleFn && (action === 'resume' || action === 'skip')) {
                    hitlSettleFn(action as 'resume' | 'skip')
                  }
                  await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
                } catch { await route.abort().catch(() => {}) }
              })
              hitlRouteRegistered = true
              log.info('[HITL] ✅ CDP route registered for /autotest-hitl-signal')
            } catch (routeErr) {
              log.warn({ routeErr }, '[HITL] Could not register CDP route')
            }
          }

          // ── Register exposeFunction (direct Node.js channel) ONCE ──────
          if (!hitlFnExposed) {
            try {
              await page.exposeFunction('__autotestHitlSignal', (action: string) => {
                log.info(`[HITL] ⚡ exposeFunction channel fired: action="${action}"`)
                if (hitlSettleFn && (action === 'resume' || action === 'skip')) {
                  hitlSettleFn(action as 'resume' | 'skip')
                }
              })
              hitlFnExposed = true
              log.info('[HITL] ✅ exposeFunction registered: __autotestHitlSignal')
            } catch (fnErr) {
              log.warn({ fnErr }, '[HITL] Could not register exposeFunction (non-fatal)')
            }
          }

          // ── Inject floating overlay ──────────────────────────
          const pauseTimeoutMs = 10 * 60 * 1000
          await injectPauseOverlay(
            page, executionId, i + 1,
            step.action, step.target ?? '', step.value ?? '',
            result.error ?? result.message ?? 'Step failed',
            pauseTimeoutMs,
          )
          await setBrowserState(page, 'paused')

          // ── Re-inject overlay after page navigation ─────────
          let hitlPauseSettled = false
          const reInjectOverlay = async () => {
            if (hitlPauseSettled) return
            try {
              await page!.waitForTimeout(500)
              if (hitlPauseSettled) return
              await injectPauseOverlay(
                page!, executionId, i + 1,
                step.action, step.target ?? '', step.value ?? '',
                result.error ?? result.message ?? 'Step failed',
                pauseTimeoutMs,
              )
              log.info(`[HITL] ♻️ Overlay re-injected after page navigation for step ${i + 1}`)
              await setBrowserState(page!, 'paused')
            } catch (err) {
              log.warn({ err }, '[HITL] Could not re-inject overlay after navigation (non-fatal)')
            }
          }
          page.on('load', reInjectOverlay)

          let pauseAction: 'resume' | 'skip' = 'resume'
          try {
            // Quad-channel HITL gate — whichever fires first wins:
            //   Channel 0 (iframe link) — <a href> targeting hidden iframe, intercepted by page.route(). Pure HTML, no JS needed.
            //   Channel 1 (exposeFunc)  — window.__autotestHitlSignal() calls Node.js directly. Survives navigation.
            //   Channel 2 (DOM poll)    — polls checkbox state + data-autotest-hitl-action every 500ms.
            //   Channel 3 (dashboard)   — waitForResume() resolves on POST /api/v1/test-runs/:id/resume.
            pauseAction = await new Promise<'resume' | 'skip'>((resolve, reject) => {
              const deadline = Date.now() + pauseTimeoutMs
              let settled = false

              function settle(action: 'resume' | 'skip') {
                if (settled) return
                settled = true
                hitlPauseSettled = true
                hitlSettleFn = null
                clearInterval(pollInterval)
                try { page?.off('load', reInjectOverlay) } catch {}
                resolve(action)
              }

              hitlSettleFn = settle

              // Channel 3: dashboard button → POST /resume → resolvePause → settle
              waitForResume(executionId, pauseTimeoutMs)
                .then(settle)
                .catch((err) => { if (!settled) { settled = true; hitlSettleFn = null; clearInterval(pollInterval); reject(err) } })

              // Channel 2: DOM polling (checkbox + attribute + sessionStorage)
              let consecutivePollErrors = 0
              const MAX_POLL_ERRORS = 30
              const pollInterval = setInterval(async () => {
                if (settled || Date.now() > deadline) {
                  clearInterval(pollInterval)
                  if (!settled) { settled = true; hitlSettleFn = null; reject(new Error('HITL pause timed out')) }
                  return
                }
                try {
                  const action = await page!.evaluate(() => {
                    // Check hidden checkboxes (set by JS handlers)
                    const resumeChk = document.getElementById('autotest-resume-chk') as HTMLInputElement | null
                    const skipChk = document.getElementById('autotest-skip-chk') as HTMLInputElement | null
                    if (resumeChk?.checked) return 'resume'
                    if (skipChk?.checked) return 'skip'
                    // Check DOM attribute + sessionStorage
                    const a = document.body.getAttribute('data-autotest-hitl-action')
                              || sessionStorage.getItem('autotest-hitl-action')
                    if (a) {
                      document.body.removeAttribute('data-autotest-hitl-action')
                      try { sessionStorage.removeItem('autotest-hitl-action') } catch {}
                    }
                    return a
                  })
                  consecutivePollErrors = 0
                  if (action === 'resume' || action === 'skip') settle(action)
                } catch {
                  consecutivePollErrors++
                  if (consecutivePollErrors >= MAX_POLL_ERRORS) {
                    clearInterval(pollInterval)
                    log.warn(`[HITL] DOM poll stopped after ${MAX_POLL_ERRORS} consecutive errors — relying on CDP route + dashboard`)
                  }
                }
              }, 500)
            })

            resolvePause(executionId, pauseAction)
            await prisma.test_runs.update({ where: { id: executionId }, data: { status: 'running' } }).catch(() => {})
            log.info(`[HITL] User chose: "${pauseAction}" for step ${i + 1}`)
          } catch {
            log.warn(`[HITL] Pause timed out for step ${i + 1} — marking as failed and stopping`)
            hitlPauseSettled = true
            hitlSettleFn = null
            try { page.off('load', reInjectOverlay) } catch {}
            await removePauseOverlay(page)
            await setBrowserState(page, 'failed')
            finalStatus = 'FAILED'
            firstFailedLocator = step.target ?? ''
            break
          }

          // Remove overlay
          await removePauseOverlay(page)
          await setBrowserState(page, 'running')

          if (pauseAction === 'skip') {
            stepResults[stepResults.length - 1] = {
              ...result, status: 'skipped',
              message: `Step ${i + 1} skipped by user (interactive mode)`, error: null,
            }
            log.info(`[HITL] Step ${i + 1} skipped — continuing to step ${i + 2}`)
            continue
          }

          // resume: mark as manually completed
          stepResults[stepResults.length - 1] = {
            ...result, status: 'passed',
            message: `Step ${i + 1} completed manually by user (interactive mode)`, error: null,
          }
          log.info(`[HITL] Step ${i + 1} marked as manually completed — continuing`)
          continue
        }

        // ── Non-interactive: standard failure handling ────────────────────
        finalStatus = 'FAILED'

        if (!firstFailedLocator) {
          firstFailedLocator = step.target ?? ''

          if (result.screenshot_path) {
            try {
              failedScreenshotBase64 = fs.readFileSync(
                path.join(process.cwd(), 'static', result.screenshot_path),
              ).toString('base64')
            } catch { /* ignore */ }
          }

          try {
            failedHtmlSnippet = await page!.evaluate((sel) => {
              try {
                const el = document.querySelector(sel)
                return el ? el.outerHTML.slice(0, 2048) : document.body.innerHTML.slice(0, 2048)
              } catch { return document.body.innerHTML.slice(0, 2048) }
            }, firstFailedLocator)
          } catch { /* ignore */ }
        }

        break // Stop on first failure
      }
    }

    // ── Set final browser state color + capture result screenshot ──────
    if (isInteractive && page) {
      await setBrowserState(page, finalStatus === 'PASSED' ? 'passed' : 'failed')
      // Wait for the 400ms CSS transition to fully settle before screenshotting
      await page.waitForTimeout(600).catch(() => {})

      // ── Capture the authoritative RESULT screenshot with border visible ──
      const resultStatus   = finalStatus === 'PASSED' ? 'PASSED' : 'FAILED'
      const resultSsFile   = `result-${resultStatus}-${Date.now()}.png`
      const resultSsAbsPath = path.join(execScreenDir, resultSsFile)
      try {
        await page.screenshot({ path: resultSsAbsPath, fullPage: false })
        // Inject it as the last step so it wins the lastScreenshot pick below
        stepResults.push({
          step:            stepResults.length + 1,
          action:          'RESULT_SCREENSHOT',
          target:          null,
          value:           null,
          status:          finalStatus === 'PASSED' ? 'passed' : 'failed',
          message:         `Final result screenshot — ${resultStatus}`,
          duration_ms:     0,
          screenshot_path: `/screenshots/${executionId}/${resultSsFile}`,
          error:           null,
        })
        log.info(`[EXEC] 📸 Result screenshot captured with ${resultStatus} border: ${resultSsFile}`)
      } catch (ssErr) {
        log.warn({ ssErr }, '[EXEC] Could not capture result screenshot (non-fatal)')
      }

      // Brief pause so the user can see the final result color
      await page.waitForTimeout(2400).catch(() => {})
    }

    // ── Stop trace ────────────────────────────────────────────────
    try { await browserContext!.tracing.stop({ path: traceFile }) }
    catch (traceErr) { log.warn({ traceErr }, '[EXEC] Failed to stop trace') }

    // ── Enqueue healing if failed ─────────────────────────────────
    if (finalStatus === 'FAILED' && firstFailedLocator !== null) {
      await healingQueue.add('heal', {
        executionId,
        testRunId:        executionId,
        testCaseId,
        projectId,
        failedLocator:    firstFailedLocator,
        screenshotBase64: failedScreenshotBase64 ?? '',
        htmlSnippet:      failedHtmlSnippet ?? '',
        logs:             stepResults as unknown as Record<string, unknown>[],
        steps:            context.steps,
      }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } })
      log.info(`[EXEC] Healing job enqueued for ${executionId}`)
    }

  } catch (err: unknown) {
    log.error({ err }, `[EXEC] Fatal error in execution ${executionId}`)
    finalStatus  = 'ERROR'
    errorMessage = err instanceof Error ? err.message : String(err)
    stepResults.push({
      step:            stepResults.length + 1,
      action:          'SYSTEM',
      target:          null,
      value:           null,
      status:          'failed',
      message:         `Fatal execution error: ${errorMessage}`,
      duration_ms:     Date.now() - startTime,
      screenshot_path: null,
      error:           errorMessage,
    })
  } finally {
    frameRegistry.delete(executionId)
    clearPause(executionId)  // clean up HITL pause gate if still pending
    try { await browserContext?.close() } catch { /* ignore */ }
    try { await browser?.close()        } catch { /* ignore */ }
  }

  // ── Write final result to test_runs ──────────────────────────
  const durationMs     = Date.now() - startTime
  const lastScreenshot = stepResults.slice().reverse().find((s) => s.screenshot_path)?.screenshot_path ?? null
  const testRunStatus  =
    finalStatus === 'PASSED' ? 'passed'
    : finalStatus === 'FAILED' ? 'failed'
    : 'error'

  try {
    await prisma.test_runs.update({
      where: { id: executionId },
      data: {
        status:          testRunStatus,
        result:          testRunStatus,
        logs:            stepResults as unknown as object[],
        duration:        durationMs / 1000,
        screenshot_path: lastScreenshot,
      },
    })
    log.info(`[EXEC] test_runs ${executionId} → ${testRunStatus} in ${durationMs}ms`)
  } catch (writeErr) {
    log.error({ writeErr }, `[EXEC] Failed to write final status for ${executionId}`)
  }

  // ── AI Fix Assistant: generate step-correction suggestions for failed runs ──
  // Mirrors Python's inline generate_healing_suggestions() call.
  // Runs synchronously so ai_suggestions is ready when the frontend polls.
  if (testRunStatus === 'failed') {
    log.info(`[EXEC] Generating AI healing suggestions for failed run ${executionId}…`)
    await generateAiSuggestions(
      executionId,
      context.steps as unknown as Record<string, unknown>[],
      stepResults as unknown as Record<string, unknown>[],
    )
  }

  if (finalStatus === 'ERROR') {
    throw new Error(errorMessage ?? 'Unknown execution error')
  }
}

// ─── Worker boot ──────────────────────────────────────────────────────────────

const worker = new Worker<ExecutionJob>(
  QUEUES.EXECUTION,
  processExecution,
  {
    ...getRedisOptions(),
    concurrency: 3,
    limiter: { max: 5, duration: 60_000 },
  },
)

worker.on('completed', (job)      => log.info(`[EXEC] Job ${job.id} completed`))
worker.on('failed',    (job, err) => log.error({ err }, `[EXEC] Job ${job?.id} failed: ${err.message}`))
worker.on('error',     (err)      => log.error({ err }, '[EXEC] Worker error'))

log.info('🔧 Execution worker started — Playwright headless runner active (SF Lightning full support)')

export default worker
