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
import { handleStepFailure } from '../modules/ai-agents/execution.agent.js'
import {
  fillWebAppField,
  selectWebAppPicklist,
  fillWebAppDate as fillWebAppDateField,
  fillWebAppCheckbox,
  extractWebAppLabel,
} from './webapp-field-handler.js'

const log = createModuleLogger('execution-worker')

/**
 * Returns true for both 'webapp' (legacy) and 'web_app' (DB-stored) categories.
 * The project_integrations table stores 'web_app' but older code used 'webapp'.
 * Always use this check instead of === 'webapp' to avoid silent mismatches.
 */
function isWebAppCategory(category: string | undefined | null): boolean {
  if (!category) return false
  const c = category.toLowerCase()
  return c === 'webapp' || c === 'web_app'
}

// ─── Directory setup ──────────────────────────────────────────────────────────

const BASE_DIR = path.resolve(process.cwd(), 'static')
const SCREENSHOTS_DIR = path.resolve(BASE_DIR, 'screenshots')
const TRACES_DIR = path.resolve(BASE_DIR, 'traces')
const SESSIONS_DIR = path.resolve(BASE_DIR, 'sessions')

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
        ui_session_active: true,
        ui_session_source: 'login',
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

// ─── SF Field Map (per execution) ────────────────────────────────────────────
// Built after clicking New/Edit/Clone — maps {fieldLabel → fieldType}
// Persists across steps within the same execution so the fill handler knows types.
const sfFieldMapRegistry = new Map<string, Record<string, string>>()

// ─── MCP Metadata Map (per execution) ────────────────────────────────────────
// Loaded once at execution start from metadata_normalized table — maps {fieldLabel → metadata}
const sfMetadataMapRegistry = new Map<string, Record<string, any>>()

// ─── SF Lightning Engine — ported from Python salesforce_engine.py ────────────
// These functions provide the critical runtime field type detection, modal
// stabilization, and error handling that the Python engine used.

/**
 * Scan the current page/modal DOM and build a {label → fieldType} map.
 * This is the KEY function that tells the fill engine what type each field is.
 *
 * Port of Python salesforce_engine.py lines 176–282.
 */
async function scanFieldMap(page: Page): Promise<Record<string, string>> {
  try {
    const fieldMap: Record<string, string> = await page.evaluate(() => {
      const modal = document.querySelector(
        '.slds-modal__content, records-record-edit-form, lightning-record-edit-form',
      ) || document.body
      const map: Record<string, string> = {}

      // Scan lightning-input-field components
      modal.querySelectorAll('lightning-input-field').forEach((field) => {
        const label = field.querySelector('label, .slds-form-element__label, legend')
        if (!label) return
        const labelText = label.textContent?.trim() ?? ''
        if (!labelText) return

        // Detect field type from child components
        if (field.querySelector('input[type="checkbox"], lightning-primitive-input-toggle')) {
          map[labelText] = 'checkbox'
        } else if (field.querySelector('lightning-datepicker')) {
          map[labelText] = 'date'
        } else if (field.querySelector('lightning-timepicker')) {
          map[labelText] = 'time'
        } else if (field.querySelector('lightning-dual-listbox')) {
          map[labelText] = 'multipicklist'
        } else if (field.querySelector('lightning-combobox')) {
          map[labelText] = 'picklist'
        } else if (field.querySelector('lightning-lookup, lightning-grouped-combobox, input[role="combobox"]')) {
          map[labelText] = 'lookup'
        } else if (field.querySelector('lightning-input-rich-text, [contenteditable="true"]')) {
          map[labelText] = 'richtext'
        } else if (field.querySelector('lightning-textarea, textarea')) {
          map[labelText] = 'textarea'
        } else if (field.querySelector('input[type="file"], lightning-file-upload')) {
          map[labelText] = 'file'
        } else {
          map[labelText] = 'text'
        }
      })

      // Scan standalone lightning components
      const componentTags = [
        'lightning-input', 'lightning-combobox', 'lightning-datepicker',
        'lightning-timepicker', 'lightning-textarea', 'lightning-lookup',
        'lightning-dual-listbox', 'lightning-input-rich-text',
        'lightning-file-upload',
      ]
      componentTags.forEach((tag) => {
        modal.querySelectorAll(tag).forEach((el) => {
          const label = el.querySelector('label, .slds-form-element__label')
          if (!label) return
          const labelText = label.textContent?.trim() ?? ''
          if (!labelText || map[labelText]) return

          if (tag === 'lightning-datepicker') map[labelText] = 'date'
          else if (tag === 'lightning-timepicker') map[labelText] = 'time'
          else if (tag === 'lightning-combobox') map[labelText] = 'picklist'
          else if (tag === 'lightning-lookup') map[labelText] = 'lookup'
          else if (tag === 'lightning-textarea') map[labelText] = 'textarea'
          else if (tag === 'lightning-dual-listbox') map[labelText] = 'multipicklist'
          else if (tag === 'lightning-input-rich-text') map[labelText] = 'richtext'
          else if (tag === 'lightning-file-upload') map[labelText] = 'file'
          else map[labelText] = 'text'
        })
      })

      // Scan .slds-form-element containers as fallback
      modal.querySelectorAll('.slds-form-element').forEach((el) => {
        const label = el.querySelector('label, .slds-form-element__label, legend')
        if (!label) return
        const labelText = label.textContent?.trim() ?? ''
        if (!labelText || map[labelText]) return

        if (el.querySelector('input[type="checkbox"], lightning-primitive-input-toggle')) {
          map[labelText] = 'checkbox'
        } else if (el.querySelector('input[type="date"], lightning-datepicker')) {
          map[labelText] = 'date'
        } else if (el.querySelector('lightning-timepicker')) {
          map[labelText] = 'time'
        } else if (el.querySelector('lightning-dual-listbox')) {
          map[labelText] = 'multipicklist'
        } else if (el.querySelector('select, lightning-combobox, [role="listbox"]')) {
          map[labelText] = 'picklist'
        } else if (el.querySelector('input[role="combobox"]')) {
          map[labelText] = 'lookup'
        } else if (el.querySelector('lightning-input-rich-text, [contenteditable="true"]')) {
          map[labelText] = 'richtext'
        } else if (el.querySelector('textarea')) {
          map[labelText] = 'textarea'
        } else if (el.querySelector('input[type="file"], lightning-file-upload')) {
          map[labelText] = 'file'
        } else {
          map[labelText] = 'text'
        }
      })

      return map
    })
    log.info(`[SF-ENGINE] 📋 Field map scanned: ${JSON.stringify(fieldMap)}`)
    return fieldMap
  } catch (e) {
    log.warn({ e }, '[SF-ENGINE] Field map scan failed')
    return {}
  }
}

/**
 * Scroll the modal container to bring a field label into view using JS.
 * Port of Python salesforce_engine.py lines 594–625.
 */
async function scrollModalToField(page: Page, label: string): Promise<void> {
  try {
    const scrolled = await page.evaluate((labelText: string) => {
      const modal = document.querySelector(
        '.slds-modal__content, div.modal-body, records-record-edit-form',
      )
      if (!modal) return false
      const labels = Array.from(modal.querySelectorAll(
        'label, span.slds-form-element__label, legend, .test-id__field-label',
      ))
      const target = labels.find(
        (l) => l.textContent && l.textContent.trim().includes(labelText),
      )
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' })
        return true
      }
      // Label not found — scroll to bottom to reveal lazy-loaded fields
      ;(modal as HTMLElement).scrollTop = (modal as HTMLElement).scrollHeight
      return false
    }, label)
    await page.waitForTimeout(500)
    if (scrolled) {
      log.info(`[SF-ENGINE] Scrolled modal to "${label}"`)
    }
  } catch { /* non-fatal */ }
}

/**
 * Wait for all Salesforce Lightning spinners to disappear.
 * Port of Python salesforce_engine.py lines 4202–4222.
 */
async function waitForSpinnerGone(page: Page, timeout = 15_000): Promise<void> {
  const spinnerSel = 'lightning-spinner, .slds-spinner, .slds-spinner_container:not(.slds-hide)'
  try {
    const spinner = page.locator(spinnerSel)
    if (await spinner.count() > 0) {
      log.info('[SF-ENGINE] Spinner detected, waiting for it to clear...')
      await spinner.first().waitFor({ state: 'hidden', timeout })
      log.info('[SF-ENGINE] Spinner cleared')
      await page.waitForTimeout(300)
    }
  } catch { /* spinner may have disappeared during check */ }
}

/**
 * Wait for Salesforce modal to open, fields to render, and stabilize.
 * Returns true if modal was detected.
 * Port of Python salesforce_engine.py lines 119–169.
 */
async function waitForSFModal(page: Page): Promise<boolean> {
  const modalSel =
    'div[role="dialog"], .forceModal, .records-modal, .slds-modal, ' +
    'records-record-edit-form, lightning-record-edit-form, section.slds-modal, ' +
    'div.slds-modal__content'
  try {
    await page.locator(modalSel).first().waitFor({ state: 'visible', timeout: 15_000 })
    log.info('[SF-ENGINE] Modal container detected')
  } catch {
    log.info('[SF-ENGINE] Modal container not detected within 15s')
    return false
  }

  // Wait for form fields to render inside the modal
  const fieldSel =
    '.slds-form-element, lightning-input-field, lightning-input, ' +
    'lightning-combobox, lightning-datepicker'
  try {
    await page.locator(fieldSel).first().waitFor({ state: 'visible', timeout: 15_000 })
    log.info('[SF-ENGINE] Form fields detected in modal')
  } catch {
    log.info('[SF-ENGINE] Form fields not detected within 15s — continuing anyway')
  }

  // Stabilization wait — allow Lightning components to fully initialize
  await page.waitForTimeout(800)
  log.info('[SF-ENGINE] Modal stabilization complete')
  return true
}

/**
 * Install a MutationObserver to auto-dismiss "We hit a snag" error modals.
 * Port of Python salesforce_engine.py lines 4004–4083.
 */
async function installErrorModalWatcher(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      if ((window as any).__autotest_error_watcher) return
      const obs = new MutationObserver(() => {
        // Dismiss uiPanel error dialogs
        document.querySelectorAll('.uiPanel').forEach((panel) => {
          const h = panel.querySelector('h2, [class*="title"]')
          const t = (h?.textContent || '').toLowerCase()
          if (t.includes('snag') || t.includes('error')) {
            const btn = panel.querySelector('button.slds-modal__close') ||
              panel.querySelector("button[title='Close']") ||
              panel.querySelector("button[title='OK']") ||
              panel.querySelector('button')
            if (btn) (btn as HTMLElement).click()
          }
        })
        // Dismiss uiModal--app-error
        document.querySelectorAll('.uiModal--app-error').forEach((modal) => {
          const btn = modal.querySelector('.modal-footer button') ||
            modal.querySelector('button.slds-modal__close')
          if (btn) (btn as HTMLElement).click()
        })
      })
      obs.observe(document.body, { childList: true, subtree: true })
      ;(window as any).__autotest_error_watcher = obs
    })
    log.info('[SF-ENGINE] Error modal watcher installed')
  } catch (e) {
    log.warn({ e }, '[SF-ENGINE] Failed to install error modal watcher')
  }
}

/**
 * Dismiss any visible Salesforce error modals.
 * Port of Python salesforce_engine.py lines 4085–4200.
 */
async function dismissErrorModal(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Dismiss uiPanel error dialogs ('We hit a snag')
      document.querySelectorAll('.uiPanel').forEach((panel) => {
        const h = panel.querySelector('h2, [class*="title"]')
        const t = (h?.textContent || '').toLowerCase()
        if (t.includes('snag') || t.includes('error')) {
          const btn = panel.querySelector('button.slds-modal__close') ||
            panel.querySelector("button[title='Close']") ||
            panel.querySelector("button[title='OK']") ||
            panel.querySelector('button')
          if (btn) (btn as HTMLElement).click()
        }
      })
      // Dismiss uiModal--app-error
      document.querySelectorAll('.uiModal--app-error').forEach((modal) => {
        const btn = modal.querySelector('.modal-footer button') ||
          modal.querySelector('button.slds-modal__close')
        if (btn) (btn as HTMLElement).click()
      })
    })
  } catch { /* non-fatal */ }
}

/**
 * Handle Salesforce "Duplicate Rule" popup — click "Save Anyway".
 * Port of Python salesforce_engine.py lines 4720+.
 */
async function handleDuplicatePopup(page: Page): Promise<void> {
  try {
    // Check for duplicate popup within 3s
    const dupModal = page.locator(
      'div.forceModalActionContainer:has-text("duplicate"), ' +
      '[role="dialog"]:has-text("duplicate"), ' +
      '.modal-footer:has-text("Save")',
    ).first()
    if (await dupModal.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Try "Save Anyway" or "Save" button
      const saveBtn = page.locator(
        'button:has-text("Save Anyway"), button:has-text("Save")',
      ).last()
      if (await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await saveBtn.click()
        log.info('[SF-ENGINE] ✅ Duplicate popup dismissed via "Save Anyway"')
        await page.waitForTimeout(1_000)
      }
    }
  } catch { /* no duplicate popup — continue */ }
}

/**
 * Fuzzy-correct a label by scanning visible labels on the page.
 * Port of Python salesforce_engine.py lines 1025–1064.
 */
async function correctLabel(page: Page, label: string): Promise<string> {
  try {
    const pageLabels: string[] = await page.evaluate(() => {
      const root = document.querySelector(
        '.slds-modal__content, records-record-edit-form',
      ) || document.body
      const labels = root.querySelectorAll(
        'label, span.slds-form-element__label, legend',
      )
      return Array.from(labels)
        .map((l) => l.textContent?.trim() ?? '')
        .filter(Boolean)
        .map((t) => t.replace(/^\*/, '').trim())
    })
    if (!pageLabels.length) return label

    const labelWords = new Set(label.toLowerCase().split(/\s+/))
    let bestMatch = label
    let bestScore = 0

    for (const pageLbl of pageLabels) {
      const pageWords = new Set(pageLbl.toLowerCase().split(/\s+/))
      if (!pageWords.size) continue
      let overlap = 0
      for (const w of labelWords) { if (pageWords.has(w)) overlap++ }
      const total = Math.max(labelWords.size, pageWords.size)
      const score = total > 0 ? overlap / total : 0
      if (score > bestScore && score >= 0.5 && overlap >= 2) {
        bestScore = score
        bestMatch = pageLbl
      }
    }
    if (bestMatch !== label) {
      log.info(`[SF-ENGINE] Label corrected: "${label}" → "${bestMatch}"`)
    }
    return bestMatch
  } catch {
    return label
  }
}

/**
 * Real-time JS probe to detect the actual field type by inspecting DOM structure.
 * Port of Python salesforce_engine.py lines 1066–1111.
 */
async function probeFieldTypeJS(page: Page, label: string): Promise<string | null> {
  try {
    return await page.evaluate((labelText: string) => {
      const root = document.querySelector(
        '.slds-modal__content, records-record-edit-form, lightning-record-edit-form',
      ) || document.body
      const labels = root.querySelectorAll(
        'label, span.slds-form-element__label, legend, .test-id__field-label',
      )
      for (const lbl of Array.from(labels)) {
        const txt = lbl.textContent?.trim()
        if (!txt || !txt.includes(labelText)) continue
        // Walk up to container
        const container = lbl.closest(
          'lightning-input-field, lightning-combobox, lightning-picklist, ' +
          'lightning-grouped-combobox, .slds-form-element',
        )
        if (!container) continue
        // Check for date FIRST (before combobox, since date inputs can have role=combobox)
        if (container.querySelector('lightning-datepicker')) return 'date'
        // Check for picklist indicators
        if (container.querySelector('lightning-combobox, lightning-picklist, [role="listbox"]')) return 'picklist'
        const btn = container.querySelector('button')
        if (btn) {
          const btnText = btn.textContent?.trim()
          if (btnText === '--None--' || btnText === 'Select an Option' ||
            btnText === 'None' || btn.getAttribute('aria-haspopup') === 'listbox') {
            return 'picklist'
          }
        }
        const combobox = container.querySelector('[role="combobox"], input[role="combobox"]')
        if (combobox && !container.querySelector('lightning-datepicker')) return 'picklist'
        if (container.querySelector('lightning-lookup')) return 'lookup'
        if (container.querySelector('textarea, lightning-textarea')) return 'textarea'
        return 'text'
      }
      return null
    }, label)
  } catch {
    return null
  }
}

/**
 * Load MCP field metadata from metadata_normalized table for a project.
 * Returns a map of {fieldLabel → {type, api_name, required, values, controllerName, ...}}.
 * Port of Python salesforce_engine.py load_field_metadata().
 */
async function loadFieldMetadata(projectId: string): Promise<Record<string, any>> {
  try {
    const rows = await prisma.metadata_normalized.findMany({
      where: {
        project_id: projectId,
        entity_type: 'field',
      },
      select: {
        label: true,
        object_name: true,
        structured_json: true,
      },
    })

    const metaMap: Record<string, any> = {}
    for (const row of rows) {
      const label = row.label?.trim()
      if (!label) continue
      const json = (row.structured_json ?? {}) as Record<string, any>
      metaMap[label] = {
        type: json.type ?? json.soap_type ?? '',
        api_name: json.api_name ?? json.name ?? '',
        required: json.required ?? json.nillable === false,
        values: json.picklist_values ?? json.restrictedPicklistValues ?? [],
        controllerName: json.controllerName ?? '',
        object_name: row.object_name ?? '',
      }
    }
    log.info(`[SF-ENGINE] Loaded ${Object.keys(metaMap).length} field metadata entries`)
    return metaMap
  } catch (e) {
    log.warn({ e }, '[SF-ENGINE] Failed to load field metadata')
    return {}
  }
}

/**
 * Resolve the field type for a given label using the 3-layer strategy:
 * 1. Step-level sf_field_type (from AI generation)
 * 2. DOM field map (from scanFieldMap after modal opens)
 * 3. MCP metadata map (from DB)
 * 4. Real-time JS DOM probe (last resort)
 *
 * Returns the resolved field type string.
 */
async function resolveFieldType(
  page: Page,
  label: string,
  stepSfType: string | undefined,
  executionId: string,
): Promise<string> {
  // Layer 1: Explicit sf_field_type from step
  if (stepSfType && stepSfType !== 'text' && stepSfType !== 'unknown') {
    log.info(`[SF-ENGINE] Field type for "${label}": "${stepSfType}" (from step metadata)`)
    return stepSfType
  }

  // Layer 2: DOM field map
  const fieldMap = sfFieldMapRegistry.get(executionId)
  if (fieldMap) {
    // Exact match
    if (fieldMap[label]) {
      log.info(`[SF-ENGINE] Field type for "${label}": "${fieldMap[label]}" (from DOM field map)`)
      return fieldMap[label]
    }
    // Fuzzy match (case-insensitive partial)
    for (const [mapLabel, mapType] of Object.entries(fieldMap)) {
      if (label.toLowerCase().includes(mapLabel.toLowerCase()) ||
        mapLabel.toLowerCase().includes(label.toLowerCase())) {
        log.info(`[SF-ENGINE] Field type for "${label}": "${mapType}" (fuzzy DOM match via "${mapLabel}")`)
        return mapType
      }
    }
  }

  // Layer 3: MCP metadata map
  const metaMap = sfMetadataMapRegistry.get(executionId)
  if (metaMap) {
    let meta = metaMap[label]
    if (!meta) {
      // Case-insensitive partial match
      for (const [metaLabel, metaInfo] of Object.entries(metaMap)) {
        if (label.toLowerCase().includes(metaLabel.toLowerCase()) ||
          metaLabel.toLowerCase().includes(label.toLowerCase())) {
          meta = metaInfo
          break
        }
      }
    }
    if (meta) {
      const sfType = (meta.type ?? '').toLowerCase()
      const typeMapping: Record<string, string> = {
        picklist: 'picklist',
        multipicklist: 'multipicklist',
        combobox: 'picklist',
        reference: 'lookup',
        date: 'date',
        datetime: 'date',
        boolean: 'checkbox',
        time: 'time',
        textarea: 'text',
        string: 'text',
        email: 'text',
        phone: 'text',
        url: 'text',
        currency: 'text',
        double: 'text',
        int: 'text',
        percent: 'text',
      }
      const mapped = typeMapping[sfType] ?? 'text'
      log.info(`[SF-ENGINE] Field type for "${label}": "${sfType}" → "${mapped}" (from MCP metadata)`)
      return mapped
    }
  }

  // Layer 4: Real-time JS DOM probe
  const probed = await probeFieldTypeJS(page, label)
  if (probed) {
    log.info(`[SF-ENGINE] Field type for "${label}": "${probed}" (from JS DOM probe)`)
    return probed
  }

  log.info(`[SF-ENGINE] Field type for "${label}": "text" (default — no detection matched)`)
  return 'text'
}

/**
 * Post-save error detection — checks main page AND all iframes for SF error messages.
 * Port of Python salesforce_engine.py lines 1289–1354.
 */
async function detectPostSaveError(page: Page): Promise<string | null> {
  const errorPatterns = [
    'update failed', 'required field', 'first error:',
    'error in expression', 'validation rule', 'review the following',
    'field integrity exception', 'insufficient access',
    'system.dmlexception', 'an error occurred',
  ]

  // Check all frames (main + child iframes)
  try {
    const frames = page.frames()
    for (const frame of frames) {
      try {
        const frameText: string = await frame.evaluate(
          () => document.body ? document.body.innerText : '',
        ).catch(() => '')
        const lower = frameText.toLowerCase()
        for (const pat of errorPatterns) {
          const idx = lower.indexOf(pat)
          if (idx >= 0) {
            return frameText.substring(Math.max(0, idx), idx + 300).trim()
          }
        }
      } catch { continue }
    }
  } catch { /* ignore */ }

  // Check SF-specific CSS error selectors on main page
  const errSelectors = [
    '.slds-notify--error', 'div[data-key="error"]',
    '.slds-notify_alert[role="alert"]', '.pageLevelErrors',
    '.forceFormPageError', '.inlineErrors', '.errorMsg',
    '.slds-theme--error', 'div.slds-box.error',
    'p.errorMsg', 'div.message.errorM3',
  ]
  for (const sel of errSelectors) {
    try {
      const loc = page.locator(sel).first()
      if (await loc.isVisible({ timeout: 1_000 }).catch(() => false)) {
        const txt = (await loc.textContent() ?? '').trim().substring(0, 300)
        if (txt && txt.length > 5) return txt
      }
    } catch { continue }
  }

  return null
}

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
 *   "Account Type"  → ["Account Type", "Account", "Type"]
 *   "Account ID"    → ["Account ID", "Account Name", "Account"]
 *   "Contact ID"    → ["Contact ID", "Contact Name", "Contact"]
 *   "Contact Phone" → ["Contact Phone", "Contact", "Phone"]
 *   "Type"          → ["Type"]
 *
 * Special rules:
 *  - If the last word is a stop-word like "ID", "Name", "Number",
 *    we skip adding it as a standalone candidate to avoid matching unrelated fields.
 *  - SF LOOKUP ALIAS: When the last word is "ID" (case insensitive), Salesforce
 *    typically displays the lookup field using "Name" instead (e.g. AccountId field
 *    renders as "Account Name" in the UI). We add "X Name" as a high-priority
 *    candidate right after the original label to handle this common mismatch.
 */
const LOOKUP_LABEL_STOP_WORDS = new Set(['id', 'name', 'no', 'no.', 'number', '#'])

function labelCandidates(label: string): string[] {
  const candidates = [label]
  const parts = label.trim().split(/\s+/)
  if (parts.length > 1) {
    const lastWord = parts[parts.length - 1]
    const lastWordNorm = lastWord.toLowerCase().replace(/\.$/, '')
    const isStopWord = LOOKUP_LABEL_STOP_WORDS.has(lastWordNorm)

    // SF LOOKUP ALIAS: "Account ID" → also try "Account Name"
    // Salesforce renders relationship (lookup) fields with the "Name" label
    // in the UI, not "ID". This is the most common AI label ↔ SF UI mismatch.
    if (lastWordNorm === 'id') {
      const prefix = parts.slice(0, -1).join(' ')
      candidates.push(`${prefix} Name`)
    }

    if (!isStopWord) {
      // Add the LAST word (e.g. "Type" from "Account Type")
      candidates.push(lastWord)
    }
    // Always add all-but-last (e.g. "Account" from "Account ID", "Account Type")
    if (parts.length >= 2) candidates.push(parts.slice(0, -1).join(' '))
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
  }, picklistTagCleanup).catch(() => { })

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

    // Strategy 2: XPath anchored on label → lookup host → input
    // Covers: lightning-lookup, c-lookup, combo-lookup, records-record-picker, and
    // any parent with class slds-form-element that wraps an autocomplete input.
    if (!lookupInput) {
      const variants = labelCandidates(fieldLabel)
      for (const lbl of variants) {
        const xpLoc = page.locator(
          // lightning-lookup (classic)
          `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
          // c-lookup or custom lookup components
          `|//label[contains(normalize-space(),"${lbl}")]/ancestor::c-lookup//input` +
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::c-lookup//input` +
          // records-record-picker (newer SF UI)
          `|//label[contains(normalize-space(),"${lbl}")]/ancestor::records-record-picker//input` +
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::records-record-picker//input` +
          // Generic: label sibling div with text input
          `|//label[contains(normalize-space(),"${lbl}")]/following-sibling::div//input[@type="text"]` +
          // Generic: slds-form-element ancestor with auto-complete input
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::div[contains(@class,"slds-form-element")]//input[not(@type="hidden")]` +
          // Placeholder fallback from label span
          `|//span[contains(normalize-space(),"${lbl}")]/following::input[@placeholder][1]`,
        ).first()
        if (await xpLoc.isVisible({ timeout: 1_000 }).catch(() => false)) {
          lookupInput = xpLoc
          // Try to find scoped container (try multiple lookup host elements)
          for (const host of ['lightning-lookup', 'c-lookup', 'records-record-picker', 'combo-lookup']) {
            const lkContainer = page.locator(`xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::${host}`).first()
            if (await lkContainer.isVisible({ timeout: 400 }).catch(() => false)) {
              lookupContainer = lkContainer
              break
            }
          }
          break
        }
      }
    }

    // Strategy 3: JS full-page scan — last resort inside the poll loop.
    // Scans ALL visible inputs with autocomplete/aria-autocomplete or that are
    // inside any lookup-like host, then picks the one whose nearest label matches.
    // This handles shadow-DOM-adjacent components where XPath can't cross boundaries.
    if (!lookupInput) {
      const variants = labelCandidates(fieldLabel)
      const lookupTag = `sf-lookup-scan-${fieldLabel.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`
      const found = await page.evaluate(([vars, tag]: [string[], string]) => {
        // EXPANDED: Gather ALL visible text inputs — not just SF-specific ones.
        // Custom CRM comboboxes use plain <input type="text"> without autocomplete.
        const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>(
          'input[type="text"], input[type="search"], input:not([type]), textarea, ' +
          'input[autocomplete], input[aria-autocomplete], ' +
          'lightning-lookup input, c-lookup input, ' +
          'records-record-picker input, [class*="lookup"] input, ' +
          '[class*="search"] input, [class*="combobox"] input, [class*="select"] input'
        )).filter(inp => (inp as HTMLElement).offsetParent !== null) // visible only

        for (const inp of allInputs) {
          // Walk ancestors to find a label
          let el: Element | null = inp
          let labelText = ''
          for (let depth = 0; depth < 15 && el; depth++) {
            el = el.parentElement
            if (!el) break
            const labelEl =
              el.querySelector('label, .slds-form-element__label, legend, [class*="label"]') ??
              el.closest('label')
            if (labelEl) {
              labelText = labelEl.textContent?.trim() ?? ''
              break
            }
          }
          // Also check aria-label and placeholder on the input itself
          if (!labelText) {
            labelText = inp.getAttribute('aria-label') ??
                        inp.getAttribute('placeholder') ??
                        inp.getAttribute('name') ?? ''
          }

          if (vars.some(v => v && labelText.toLowerCase().includes(v.toLowerCase()))) {
            inp.setAttribute('data-autotest-lookup-target', tag)
            return true
          }
        }
        return false
      }, [variants, lookupTag] as [string[], string])

      if (found) {
        const scanned = page.locator(`[data-autotest-lookup-target="${lookupTag}"]`).first()
        if (await scanned.isVisible({ timeout: 1_000 }).catch(() => false)) {
          lookupInput = scanned
          log.info(`[SF-LOOKUP] ✅ Strategy 3 (JS scan) found input for "${fieldLabel}"`)
          // clean up the tag immediately
          await page.evaluate((t: string) => {
            document.querySelector(`[data-autotest-lookup-target="${t}"]`)?.removeAttribute('data-autotest-lookup-target')
          }, lookupTag).catch(() => {})
        }
      }
    }

    // Strategy 4: Custom combobox — locate by placeholder text matching field label.
    // Many non-SF CRM apps render lookup fields as plain inputs with descriptive
    // placeholders like "Search and select an account" — no SF-specific wrappers.
    if (!lookupInput) {
      const variants = labelCandidates(fieldLabel)
      const placeholderLoc = page.locator(
        variants.map(v => `input[placeholder*="${v}" i], input[placeholder*="select" i][placeholder*="${v.split(' ')[0]}" i]`).join(', ')
      ).first()
      if (await placeholderLoc.isVisible({ timeout: 1_000 }).catch(() => false)) {
        lookupInput = placeholderLoc
        log.info(`[SF-LOOKUP] ✅ Strategy 4 (placeholder match) found input for "${fieldLabel}"`)
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
      input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      input.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
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

  // ── Wait for autocomplete dropdown ────────────────────────────────
  // Supports both SF ARIA-based dropdowns and custom CRM combobox dropdowns.
  const scope = lookupContainer ?? page

  // Comprehensive dropdown selectors — ordered from most specific (SF) to generic (custom CRM)
  const DROPDOWN_SELECTORS = [
    '[role="listbox"]',                               // SF Lightning / ARIA standard
    '[role="combobox"] + ul',                         // Standard combobox pattern
    'ul[class*="dropdown"]', 'ul[class*="suggest"]',  // Generic list dropdowns
    'ul[class*="option"]', 'ul[class*="result"]',
    'div[class*="dropdown"]:not([class*="button"])',  // Div-based dropdowns
    'div[class*="suggest"]', 'div[class*="result"]',
    'div[class*="option-list"]', 'div[class*="menu"]',
    '.slds-listbox', '.slds-dropdown',                // SLDS utility classes
  ]

  // Helper: find first visible dropdown container after typing
  const findDropdown = async (): Promise<Locator | null> => {
    for (const sel of DROPDOWN_SELECTORS) {
      const loc = scope.locator(sel).first()
      if (await loc.isVisible({ timeout: 500 }).catch(() => false)) {
        return loc
      }
    }
    // Also try page-level (in case scoped lookup container is wrong)
    for (const sel of DROPDOWN_SELECTORS) {
      const loc = page.locator(sel).first()
      if (await loc.isVisible({ timeout: 300 }).catch(() => false)) {
        return loc
      }
    }
    return null
  }

  let dropdownContainer = await (async () => {
    // Wait up to 8s for a dropdown to appear
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const dd = await findDropdown()
      if (dd) return dd
      await page.waitForTimeout(200)
    }
    return null
  })()

  let dropdownVisible = !!dropdownContainer

  if (!dropdownVisible) {
    // ── Retry: previous lookup's overlay may still be intercepting ─────
    log.warn(`[SF-LOOKUP] No dropdown on first attempt for "${fieldLabel}" — Tab-blurring then retrying`)
    await page.keyboard.press('Tab').catch(() => { })
    await page.waitForTimeout(1_500)
    await activateAndType(searchValue)
    dropdownContainer = await (async () => {
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const dd = await findDropdown()
        if (dd) return dd
        await page.waitForTimeout(200)
      }
      return null
    })()
    dropdownVisible = !!dropdownContainer
  }

  if (dropdownVisible && dropdownContainer) {
    log.info(`[SF-LOOKUP] Dropdown appeared for "${searchValue}"`)

    // Comprehensive option selectors — SF ARIA + custom CRM list items
    const OPTION_SELECTORS = [
      `[role="option"]`,
      `.slds-listbox__item`,
      `li[class*="option"]`, `li[class*="result"]`, `li[class*="item"]`,
      `li`, // generic list items
      `div[class*="option"]`, `div[class*="item"]`, `div[class*="result"]`,
    ]

    for (const sel of OPTION_SELECTORS) {
      const allOpts = dropdownContainer.locator(sel)
      const count = await allOpts.count().catch(() => 0)
      if (count === 0) continue

      // Try to find one matching the search value
      const matchingOpt = allOpts.filter({ hasText: searchValue }).first()
      const firstWord = searchValue.split(' ')[0]
      const partialOpt = allOpts.filter({ hasText: firstWord }).first()
      const firstOpt = allOpts.first()

      for (const opt of [matchingOpt, partialOpt, firstOpt]) {
        if (await opt.isVisible({ timeout: 1_000 }).catch(() => false)) {
          await opt.scrollIntoViewIfNeeded().catch(() => { })
          await opt.click({ force: true })
          await page.waitForTimeout(1_500)
          // Verify the input was populated (field value changed)
          const inputVal = await lookupInput.inputValue().catch(() => '')
          if (inputVal && inputVal !== searchValue) {
            // Input changed — value was populated by selection
            log.info(`[SF-LOOKUP] ✅ Selected "${searchValue}" via inline dropdown (${sel})`)
            return
          }
          // For custom comboboxes: input may be cleared and a chip/tag added
          // Check if dropdown closed as sign of success
          const ddStillVisible = await dropdownContainer!.isVisible({ timeout: 500 }).catch(() => false)
          if (!ddStillVisible) {
            log.info(`[SF-LOOKUP] ✅ Dropdown closed after click — treating as success (${sel})`)
            return
          }
          break
        }
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
      await firstOpt.scrollIntoViewIfNeeded().catch(() => { })
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
    await advSearchBtn.click().catch(() => { })
  } else {
    log.info(`[SF-LOOKUP] No Advanced Search link found. Pressing Enter to try to trigger it...`)
    await lookupInput.press('Enter')
  }

  await page.waitForTimeout(1_000)

  // Verify if the Advanced Search Modal actually opened.
  //
  // IMPORTANT: We cannot use '[role="dialog"] filter({has: table})' because the
  // PARENT create/edit form modal ALSO has tables/grids. Instead, count the
  // number of dialogs BEFORE clicking Advanced Search vs AFTER — if the count
  // increased, a new modal opened and that is the Advanced Search dialog.
  //
  // Also check for the explicit heading text 'Advanced Search' which ONLY
  // appears in the Advanced Search modal, not the form modal.
  const dialogCountAfter = await page.locator('[role="dialog"]').count().catch(() => 0)
  const advSearchByHeading = page.locator('[role="dialog"]').filter({
    has: page.locator('h1, h2, .slds-modal__title').filter({ hasText: /^Advanced Search$/i })
  }).first()
  const advSearchByNewDialog = dialogCountAfter > 1
    ? page.locator('[role="dialog"]').nth(dialogCountAfter - 1)  // newest dialog
    : null

  const isAdvSearchOpen =
    await advSearchByHeading.isVisible({ timeout: 4_000 }).catch(() => false) ||
    (advSearchByNewDialog ? await advSearchByNewDialog.isVisible({ timeout: 2_000 }).catch(() => false) : false)

  if (isAdvSearchOpen) {
    log.info(`[SF-LOOKUP] Advanced Search modal detected (${dialogCountAfter} dialogs). Delegating...`)
    await selectSFLookupAdvanced(page, fieldLabel, searchValue, true)
    return
  }

  throw new Error(`[SF-LOOKUP] Could not select "${searchValue}" in lookup "${fieldLabel}" — no Advanced Search modal opened (${dialogCountAfter} dialogs on page).`)
}


// ─── SF Lookup Advanced Search ────────────────────────────────────────────────

/**
 * Waits for the DOM to stabilize by polling the count of matching elements.
 * Returns only once the count remains constant for `stableMs` milliseconds.
 *
 * This is the KEY FIX for the "click does nothing" bug:
 * Salesforce LWC re-renders the listbox 1-2 times after a search completes,
 * so any reference acquired during re-render points to a detached (dead) node.
 * Polling until the count stabilizes guarantees we only interact with the
 * final, attached DOM nodes.
 */
async function waitForDOMStability(
  locator: Locator,
  { timeoutMs = 8_000, stableMs = 800, pollMs = 200 } = {},
): Promise<number> {
  const start = Date.now()
  let lastCount = -1
  let stableSince = Date.now()

  while (Date.now() - start < timeoutMs) {
    const currentCount = await locator.count().catch(() => 0)
    if (currentCount !== lastCount) {
      lastCount = currentCount
      stableSince = Date.now()
    } else if (currentCount > 0 && Date.now() - stableSince >= stableMs) {
      return currentCount // stable!
    }
    await locator.page().waitForTimeout(pollMs)
  }
  return lastCount // timed out but return whatever we have
}

// ─── Advanced Search Radio Selector — simplified & robust for Spring '25+ ──

/**
 * Robust radio selection for Salesforce Advanced Search (Spring '25 / Summer '25+).
 *
 * 6 strategies in priority order:
 *   1. setChecked(true, { force: true }) — Playwright-recommended for radios.
 *   2. check({ force: true }) — slightly different API path.
 *   3. Click visible faux/label elements — manual visual path.
 *   4. Click the first <td> cell of the row — triggers row-level selection.
 *   5. NUCLEAR JS (TOPMOST dialog) — force .checked + full event dispatch for LWC.
 *   6. Keyboard navigation — ArrowDown to first row + Space to select.
 *
 * Captures a debug screenshot on failure for diagnostics.
 *
 * @returns true if a record was selected and the modal closed
 */
async function selectAdvancedSearchRadio(
  page: Page,
  modal: Locator,
  searchValue: string,
): Promise<boolean> {
  log.info(`[ADV-RADIO] Starting selection for "${searchValue}"`)

  // ── 1. Strong stability wait for results ─────────────────────────────────
  try {
    await modal.locator('table').first().waitFor({ state: 'visible', timeout: 15_000 })
  } catch {
    log.warn(`[ADV-RADIO] No results table in modal after 15s`)
    return false
  }

  await page.waitForTimeout(1_500)

  // Use `table tbody tr` specifically to exclude header rows.
  // The `[role="row"]` selector also matches <thead> <tr role="row"> which inflates
  // the count and can cause Strategy 4/5 to target the wrong element.
  const rows = modal.locator('table tbody tr')
  const pollStart = Date.now()
  let hasRows = false
  while (Date.now() - pollStart < 12_000) {
    if (await rows.count().catch(() => 0) > 0) { hasRows = true; break }
    await page.waitForTimeout(300)
  }
  if (!hasRows) {
    // Fallback: try [role="row"] in case the table doesn't use <tbody>
    const roleRows = modal.locator('[role="row"]')
    const roleRowCount = await roleRows.count().catch(() => 0)
    if (roleRowCount > 0) {
      log.info(`[ADV-RADIO] No <tbody> rows — found ${roleRowCount} [role="row"] elements`)
      hasRows = true
    } else {
      log.warn(`[ADV-RADIO] No rows appeared in table after 12s`)
      return false
    }
  }

  const stableCount = await waitForDOMStability(rows, {
    timeoutMs: 12_000, stableMs: 1_000, pollMs: 200,
  })
  log.info(`[ADV-RADIO] Table stabilized with ${stableCount} rows`)

  // ── 2. Find the best matching row ────────────────────────────────────────
  // Filter to data rows that contain <td> (excludes header <tr> with <th>)
  let row = modal.locator('table tbody tr')
    .filter({ hasText: searchValue })
    .first()

  if (await row.count().catch(() => 0) === 0) {
    // Broader fallback: any <tr> with the text that has a <td>
    row = modal.locator('tr')
      .filter({ hasText: searchValue })
      .filter({ has: modal.locator('td') })
      .first()
  }

  if (await row.count().catch(() => 0) === 0) {
    log.warn(`[ADV-RADIO] No matching data row for "${searchValue}" — using first data row`)
    row = rows.first()
  } else {
    log.info(`[ADV-RADIO] Found data row matching "${searchValue}"`)
  }

  await row.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => { })
  await page.waitForTimeout(800)

  const radioInput = row.locator('input[type="radio"]').first()
  let radioChecked = false

  // Helper: check if ANY radio in the modal is now checked
  const isAnyRadioChecked = async (): Promise<boolean> => {
    const checked = await modal.locator('input[type="radio"]:checked').count().catch(() => 0)
    return checked > 0
  }

  // ── Strategy 1: setChecked — Playwright-recommended ─────────────────────
  try {
    await radioInput.setChecked(true, { force: true, timeout: 8_000 })
    if (await radioInput.isChecked().catch(() => false)) {
      log.info(`[ADV-RADIO] ✅ S1: setChecked(true, force) succeeded`)
      radioChecked = true
    }
  } catch (e) {
    log.warn(`[ADV-RADIO] S1 setChecked failed: ${(e as Error).message}`)
  }

  // ── Strategy 2: check({ force }) fallback ───────────────────────────────
  if (!radioChecked) {
    try {
      await radioInput.check({ force: true, timeout: 6_000 })
      if (await radioInput.isChecked().catch(() => false)) {
        log.info(`[ADV-RADIO] ✅ S2: check({ force }) succeeded`)
        radioChecked = true
      }
    } catch (e) {
      log.warn(`[ADV-RADIO] S2 check() failed: ${(e as Error).message}`)
    }
  }

  // ── Strategy 3: Click visible faux + label ──────────────────────────────
  if (!radioChecked) {
    for (const sel of ['span.slds-radio_faux', 'span.slds-radio--faux', 'label.slds-radio__label', 'label[for]']) {
      const visual = row.locator(sel).first()
      if (await visual.count().catch(() => 0) > 0) {
        await visual.click({ force: true, timeout: 4_000 }).catch(() => { })
        await page.waitForTimeout(600)
        if (await radioInput.isChecked().catch(() => false) || await isAnyRadioChecked()) {
          log.info(`[ADV-RADIO] ✅ S3: Clicked visual element: ${sel}`)
          radioChecked = true
          break
        }
      }
    }
    if (!radioChecked) log.warn(`[ADV-RADIO] S3 faux/label loop — none worked`)
  }

  // ── Strategy 4: Click the first <td> cell (radio column) ────────────────
  // In SF Advanced Search, the first <td> in each row contains the radio.
  // Clicking the <td> itself can trigger the radio via event bubbling.
  if (!radioChecked) {
    try {
      const firstTd = row.locator('td').first()
      if (await firstTd.count().catch(() => 0) > 0) {
        await firstTd.click({ force: true, timeout: 4_000 }).catch(() => { })
        await page.waitForTimeout(600)
        if (await radioInput.isChecked().catch(() => false) || await isAnyRadioChecked()) {
          log.info(`[ADV-RADIO] ✅ S4: Clicked first <td> cell`)
          radioChecked = true
        }
      }
    } catch (e) {
      log.warn(`[ADV-RADIO] S4 td click failed: ${(e as Error).message}`)
    }
  }

  // ── Strategy 5: NUCLEAR JS — targets TOPMOST dialog (Advanced Search) ───
  // CRITICAL FIX: Previous code used document.querySelector('[role="dialog"]')
  // which returns the FIRST dialog (parent form), not the Advanced Search.
  // The Advanced Search is always the LAST/TOPMOST dialog. We must use
  // querySelectorAll and target the last one.
  if (!radioChecked) {
    try {
      radioChecked = await page.evaluate((sv: string) => {
        // Get ALL dialogs and target the LAST one (topmost = Advanced Search)
        const dialogs = document.querySelectorAll('[role="dialog"]')
        if (dialogs.length === 0) return false
        const dialog = dialogs[dialogs.length - 1] as HTMLElement

        const allRows = Array.from(dialog.querySelectorAll('tbody tr'))
        // Try exact text match first, then any row with the text
        for (const r of allRows) {
          if (!r.textContent?.includes(sv)) continue
          const radio = r.querySelector('input[type="radio"]') as HTMLInputElement | null
          if (!radio) continue

          radio.checked = true
          const opts = { bubbles: true, composed: true, cancelable: true }
          radio.dispatchEvent(new Event('focusin', opts))
          radio.dispatchEvent(new Event('focus', opts))
          radio.dispatchEvent(new Event('input', opts))
          radio.dispatchEvent(new Event('change', opts))
          radio.dispatchEvent(new MouseEvent('click', opts))
          return true
        }

        // Fallback: select the first radio in the topmost dialog regardless
        const firstRadio = dialog.querySelector('tbody tr input[type="radio"]') as HTMLInputElement | null
        if (firstRadio) {
          firstRadio.checked = true
          const opts = { bubbles: true, composed: true, cancelable: true }
          firstRadio.dispatchEvent(new Event('focusin', opts))
          firstRadio.dispatchEvent(new Event('focus', opts))
          firstRadio.dispatchEvent(new Event('input', opts))
          firstRadio.dispatchEvent(new Event('change', opts))
          firstRadio.dispatchEvent(new MouseEvent('click', opts))
          return true
        }
        return false
      }, searchValue)
      if (radioChecked) log.info(`[ADV-RADIO] ✅ S5: Nuclear JS (topmost dialog) succeeded`)
    } catch (e) {
      log.warn(`[ADV-RADIO] S5 nuclear JS failed: ${(e as Error).message}`)
    }
  }

  // ── Strategy 6: Keyboard navigation — ArrowDown + Space ─────────────────
  // Focus the table/first row and use keyboard to select.
  if (!radioChecked) {
    try {
      // Focus the table body area
      const tableBody = modal.locator('table tbody, table').first()
      await tableBody.click({ force: true, timeout: 3_000 }).catch(() => { })
      await page.waitForTimeout(300)
      await page.keyboard.press('ArrowDown')
      await page.waitForTimeout(300)
      await page.keyboard.press('Space')
      await page.waitForTimeout(600)
      if (await isAnyRadioChecked()) {
        log.info(`[ADV-RADIO] ✅ S6: Keyboard ArrowDown + Space succeeded`)
        radioChecked = true
      }
    } catch (e) {
      log.warn(`[ADV-RADIO] S6 keyboard nav failed: ${(e as Error).message}`)
    }
  }

  // ── Final verification ───────────────────────────────────────────────────
  if (!radioChecked) {
    if (await isAnyRadioChecked()) {
      log.info(`[ADV-RADIO] Final check: found checked radio(s) — proceeding`)
      radioChecked = true
    }
  }

  if (!radioChecked) {
    log.warn(`[ADV-RADIO] ⚠ All radio strategies failed for "${searchValue}"`)
    const debugPath = path.join(SCREENSHOTS_DIR, `debug-radio-fail-${Date.now()}.png`)
    await page.screenshot({ path: debugPath }).catch(() => { })
    log.info(`[ADV-RADIO] Debug screenshot saved: ${debugPath}`)
    return false
  }

  // ── 3. Critical wait — SF needs time to enable Select button ─────────────
  log.info(`[ADV-RADIO] Radio selected ✅. Waiting 2.5s for Select button...`)
  await page.waitForTimeout(2_500)

  // ── 4. Click Select button ───────────────────────────────────────────────
  // IMPORTANT: Scope Select button to the modal (Advanced Search) to avoid
  // accidentally clicking a "Select" button in the parent form modal.
  let selectClicked = false
  const selectLocators = [
    modal.locator('.slds-modal__footer button, footer button, .modal-footer button').filter({ hasText: /^Select$/i }),
    modal.locator('button').filter({ hasText: /^Select$/i }),
    page.locator('.slds-modal__footer button:has-text("Select")').last(),  // last = topmost modal's footer
  ]

  for (const loc of selectLocators) {
    if (await loc.count().catch(() => 0) > 0) {
      const btn = loc.first()
      // Force-enable the button (SF disables it until radio state propagates through LWC)
      await btn.evaluate((b: HTMLElement) => {
        (b as HTMLButtonElement).disabled = false
        b.removeAttribute('disabled')
      }).catch(() => { })
      await page.waitForTimeout(300)
      await btn.click({ force: true, timeout: 5_000 }).catch(() => { })
      selectClicked = true
      log.info(`[ADV-RADIO] ✅ Clicked Select button`)
      break
    }
  }

  // JS fallback — target the TOPMOST dialog's Select button
  if (!selectClicked) {
    try {
      selectClicked = await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"]')
        if (dialogs.length === 0) return false
        const topDialog = dialogs[dialogs.length - 1]

        // First try footer-scoped
        const footer = topDialog.querySelector('.slds-modal__footer, .modal-footer, footer')
        const footerBtns = footer
          ? Array.from(footer.querySelectorAll('button')) as HTMLButtonElement[]
          : []
        for (const b of footerBtns) {
          if (b.textContent?.trim() === 'Select') {
            b.disabled = false
            b.removeAttribute('disabled')
            b.click()
            return true
          }
        }

        // Broader fallback within the topmost dialog
        const allBtns = Array.from(topDialog.querySelectorAll('button')) as HTMLButtonElement[]
        for (const b of allBtns) {
          if (b.textContent?.trim() === 'Select' && b.offsetParent !== null) {
            b.disabled = false
            b.removeAttribute('disabled')
            b.click()
            return true
          }
        }
        return false
      })
      if (selectClicked) log.info(`[ADV-RADIO] ✅ Select clicked via JS fallback (topmost dialog)`)
    } catch (e) {
      log.warn(`[ADV-RADIO] JS Select fallback failed: ${(e as Error).message}`)
    }
  }

  if (!selectClicked) {
    log.warn(`[ADV-RADIO] ⚠ Could not click Select button`)
    return false
  }

  // ── 5. Verify modal closed ───────────────────────────────────────────────
  await page.waitForTimeout(1_500)
  const closed = await modal.waitFor({ state: 'hidden', timeout: 8_000 })
    .then(() => true).catch(() => false)

  if (!closed) {
    const dialogCount = await page.locator('[role="dialog"]').count().catch(() => 0)
    if (dialogCount <= 1) {
      log.info(`[ADV-RADIO] ✅ Modal closed (dialog count dropped to ${dialogCount})`)
      return true
    }
  }

  log.info(`[ADV-RADIO] ${closed ? '✅' : '⚠'} After Select: modal closed=${closed}`)
  return closed
}


/**
 * Opens the SF Lookup Advanced Search modal, searches, and clicks the matching row.
 *
 * Selection uses a 4-strategy cascade (tries each in order):
 *
 * | Strategy        | How it works                          | Why it helps                             |
 * |-----------------|---------------------------------------|------------------------------------------|
 * | 1. Keyboard     | ArrowDown → Enter                     | No click — bypasses overlay/stale issues |
 * | 2. Fresh locator| Re-queries DOM right before clicking  | Never holds a stale reference            |
 * | 3. JS dispatch  | dispatchEvent via page.evaluate       | Bypasses CSS pointer-events overlays     |
 * | 4. Force click  | click({ force: true })                | Ignores visibility/intercept checks      |
 *
 * The key fix is waitForDOMStability() — it polls the option count every 200ms
 * and only proceeds once the count has been stable for 500ms. This prevents
 * clicking a node that's about to be detached by an LWC re-render.
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
  // IMPORTANT: The Advanced Search modal has an <h2> with text "Advanced Search".
  // Using that heading as the anchor is the most reliable discriminator — it avoids
  // accidentally matching the parent create/edit form which also has role="dialog".
  //
  // IMPROVED DETECTION (Spring '25+):
  //   1. Heading-anchored: h1/h2/h3 with "Advanced Search" text (case-insensitive)
  //   2. Dialog-level: filter dialog by hasText /Advanced Search/i
  //   3. Fallback: topmost dialog (.last())
  let modal = page.locator('[role="dialog"]').filter({
    has: page.locator('h1, h2, h3, .modal-title, .slds-modal__header h2, .slds-modal__title').filter({ hasText: /Advanced Search/i })
  }).first()

  // If heading-anchored locator isn't visible, try dialog-level text filter
  let modalByHeading = await modal.isVisible({ timeout: 4_000 }).catch(() => false)
  if (!modalByHeading) {
    log.info(`[SF-LOOKUP-ADV] Heading-anchored modal not found — trying dialog-level hasText filter`)
    modal = page.locator('[role="dialog"]').filter({ hasText: /Advanced Search/i }).first()
    modalByHeading = await modal.isVisible({ timeout: 2_000 }).catch(() => false)
  }
  if (!modalByHeading) {
    log.warn(`[SF-LOOKUP-ADV] No Advanced Search heading/text detected — falling back to .last() dialog`)
    modal = page.locator('[role="dialog"]').last()
  }

  await modal.waitFor({ state: 'visible', timeout: 10_000 })
  log.info(`[SF-LOOKUP-ADV] Modal is visible (heading-matched=${modalByHeading}). Searching for "${searchValue}"...`)

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

  // ── Wait for search results to load + stabilize ──────────────────────────────
  // After submitting the search, SF needs time to:
  //   1. Fetch results from the server
  //   2. Render the table (initial render)
  //   3. LWC re-renders the table 1-2 times after search completes
  // We wait for initial render, then poll for at least 1 row, then stabilize.
  log.info(`[SF-LOOKUP-ADV] Waiting for results to load and stabilize...`)
  await page.waitForTimeout(1_500)  // initial render time

  // Poll until at least 1 result row appears (handles slow data loads)
  const resultRowsLoc = modal.locator('table tbody tr, [role="row"]:not(:first-child)')
  const pollStart = Date.now()
  let foundRows = false
  while (Date.now() - pollStart < 15_000) {
    const rc = await resultRowsLoc.count().catch(() => 0)
    if (rc > 0) { foundRows = true; break }
    await page.waitForTimeout(300)
  }
  if (foundRows) {
    // Wait for row count to stabilize (prevents stale DOM node interactions)
    const stableResultCount = await waitForDOMStability(resultRowsLoc, {
      timeoutMs: 12_000, stableMs: 800, pollMs: 150,
    })
    log.info(`[SF-LOOKUP-ADV] Results stabilized: ${stableResultCount} rows`)
  } else {
    log.warn(`[SF-LOOKUP-ADV] No result rows appeared after 15s — proceeding anyway`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM DIAGNOSTICS — Capture the actual modal HTML structure so we can
  // understand why strategies fail. This runs ONCE before any interactions.
  // ═══════════════════════════════════════════════════════════════════════════
  const diagnostics = await page.evaluate(() => {
    try {
      const dialogs = document.querySelectorAll('[role="dialog"]')
      const info: Record<string, unknown> = {
        totalDialogs: dialogs.length,
      }

      // Examine the last (topmost) dialog
      const d = dialogs[dialogs.length - 1]
      if (!d) return JSON.stringify(info)

      // Check for iframes inside the dialog
      const iframes = d.querySelectorAll('iframe')
      info.iframeCount = iframes.length
      if (iframes.length > 0) {
        info.iframeSrcs = Array.from(iframes).map(f => f.src || f.getAttribute('src') || '(no src)')
      }

      // Count key interactive elements
      info.radioInputs = d.querySelectorAll('input[type="radio"]').length
      info.checkboxInputs = d.querySelectorAll('input[type="checkbox"]').length
      info.buttons = Array.from(d.querySelectorAll('button')).map(b => b.textContent?.trim().slice(0, 30) || '')
      info.links = d.querySelectorAll('a').length
      info.tableTrs = d.querySelectorAll('table tbody tr').length
      info.roleRows = d.querySelectorAll('[role="row"]').length

      // SLDS faux elements
      info.sldsFaux = d.querySelectorAll('span.slds-radio_faux, span.slds-radio--faux, span.slds-checkbox_faux').length

      // Shadow DOM elements
      let shadowHosts = 0
      const allEls = d.querySelectorAll('*')
      for (let i = 0; i < allEls.length; i++) {
        if (allEls[i].shadowRoot) shadowHosts++
      }
      info.shadowHosts = shadowHosts

      // Dump first 2000 chars of innerHTML to understand the structure
      info.modalHTML = d.innerHTML.slice(0, 3000)

      return JSON.stringify(info)
    } catch (err) {
      return `diagnostic-error: ${(err as Error).message}`
    }
  })
  log.info(`[SF-LOOKUP-ADV] 🔍 DOM DIAGNOSTICS: ${diagnostics}`)

  // ── Detect iframes (SF Advanced Search often renders results in an iframe) ─
  const modalFrames = modal.frameLocator('iframe')
  let workingFrame: ReturnType<typeof modal.locator> | null = null
  let modalClosed = false

  // Check if results are inside an iframe
  const iframeCount = await modal.locator('iframe').count().catch(() => 0)
  log.info(`[SF-LOOKUP-ADV] Found ${iframeCount} iframe(s) in modal`)

  if (iframeCount > 0) {
    // Results are INSIDE an iframe — this is why all strategies failed!
    // None of them were switching frame context.
    log.info(`[SF-LOOKUP-ADV] ⚡ Results are in an IFRAME — switching frame context`)
    try {
      const iframe = modalFrames.first()
      // Try to find rows inside the iframe
      const iframeRows = iframe.locator('table tbody tr, tr.dataRow, .x-grid-row')
      const iframeRowCount = await iframeRows.count().catch(() => 0)
      log.info(`[SF-LOOKUP-ADV] Found ${iframeRowCount} rows inside iframe`)

      if (iframeRowCount > 0) {
        // ── Strategy IFRAME-A: Click radio inside iframe ──────────────────
        const iframeRadio = iframe.locator('input[type="radio"], span.slds-radio_faux, [role="radio"]').first()
        if (await iframeRadio.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await iframeRadio.click({ force: true, timeout: 3_000 }).catch(() => { })
          log.info(`[SF-LOOKUP-ADV] Clicked radio inside iframe`)
          await page.waitForTimeout(1_000)
        }

        // ── Strategy IFRAME-B: Click the row or first link in iframe ──────
        const iframeRow = iframeRows.filter({ hasText: searchValue }).first()
        const iframeRowAlt = iframeRows.first()
        const activeRow = await iframeRow.isVisible({ timeout: 1_000 }).catch(() => false)
          ? iframeRow : iframeRowAlt

        const iframeLink = activeRow.locator('a, th a').first()
        if (await iframeLink.isVisible({ timeout: 1_500 }).catch(() => false)) {
          await iframeLink.click({ force: true, timeout: 3_000 })
          log.info(`[SF-LOOKUP-ADV] Clicked link inside iframe row`)
          await page.waitForTimeout(2_000)
          modalClosed = await modal.waitFor({ state: 'hidden', timeout: 6_000 })
            .then(() => true).catch(() => false)
          if (modalClosed) log.info(`[SF-LOOKUP-ADV] ✅ IFRAME link click succeeded`)
        }

        // ── Strategy IFRAME-C: Click the row itself ───────────────────────
        if (!modalClosed) {
          await activeRow.click({ force: true, timeout: 3_000 }).catch(() => { })
          log.info(`[SF-LOOKUP-ADV] Clicked row inside iframe`)
          await page.waitForTimeout(1_500)
          modalClosed = await modal.waitFor({ state: 'hidden', timeout: 4_000 })
            .then(() => true).catch(() => false)
          if (modalClosed) log.info(`[SF-LOOKUP-ADV] ✅ IFRAME row click succeeded`)
        }
      }
    } catch (e) {
      log.warn(`[SF-LOOKUP-ADV] iframe strategy error: ${(e as Error).message}`)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RESULT SELECTION — radio-first strategy for Spring '25 / Summer '25+
  //
  // In newer Lightning releases, the Advanced Search modal no longer makes
  // the record name a clickable <a> link. The radio button is the ONLY
  // reliable selection mechanism. We try radio FIRST, then fall back to
  // link clicking for older orgs.
  //
  // CRITICAL: We track `selectionSucceeded` separately from `modalClosed`.
  //   `modalClosed` becomes true when Escape closes the modal — but that does
  //   NOT mean the field got a value. Only the strategies below set
  //   `selectionSucceeded = true` on a REAL, verified selection.
  // ═══════════════════════════════════════════════════════════════════════════
  let selectionSucceeded = false

  // ── Strategy 1 (PRIMARY): Row-based radio selection ──────────────────────
  // This is the MOST RELIABLE method for current SF Lightning (Spring '25+).
  // The selectAdvancedSearchRadio function uses 7 cascading strategies.
  if (!modalClosed) {
    log.info(`[SF-LOOKUP-ADV] Strategy 1: Radio selection (primary — Spring '25+ compatible)`)
    const radioResult = await selectAdvancedSearchRadio(page, modal, searchValue)
    if (radioResult) {
      modalClosed = true
      selectionSucceeded = true
      log.info(`[SF-LOOKUP-ADV] ✅ Strategy 1 (radio) succeeded`)
    }
  }

  // ── Strategy 2 (FALLBACK): Click result LINK directly ────────────────────
  // For older SF orgs where the record name is still a clickable <a> link.
  // DEMOTED from Strategy 1 because Spring '25+ removed clickable links.
  if (!modalClosed && !selectionSucceeded) {
    log.info(`[SF-LOOKUP-ADV] Strategy 2: Link click (fallback for older orgs)`)
    const resultSelectors = [
      `a:has-text("${searchValue}")`,
      `th a:has-text("${searchValue}")`,
      `td a:has-text("${searchValue}")`,
      `[role="row"] a:has-text("${searchValue}")`,
      `lightning-base-formatted-text:has-text("${searchValue}")`,
    ]

    for (const rs of resultSelectors) {
      try {
        const resultLoc = modal.locator(rs)
        const count = await resultLoc.count().catch(() => 0)
        if (count > 0) {
          for (let i = 0; i < Math.min(count, 5); i++) {
            if (await resultLoc.nth(i).isVisible({ timeout: 1_000 }).catch(() => false)) {
              await resultLoc.nth(i).click({ timeout: 5_000 })
              log.info(`[SF-LOOKUP-ADV] Clicked result link: ${rs} (item ${i})`)
              await page.waitForTimeout(1_000)

              // Try clicking Select button (if present — some SF modals auto-close on link click)
              try {
                const selectBtn = modal.locator("button:has-text('Select')")
                if (await selectBtn.count().catch(() => 0) > 0 &&
                    await selectBtn.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
                  await selectBtn.first().click({ force: true, timeout: 3_000 })
                  log.info(`[SF-LOOKUP-ADV] ✅ Clicked Select button after link click`)
                }
              } catch { /* Select button optional */ }

              // Check if modal closed
              await page.waitForTimeout(500)
              modalClosed = await modal.waitFor({ state: 'hidden', timeout: 5_000 })
                .then(() => true).catch(() => false)
              if (modalClosed) {
                selectionSucceeded = true
                log.info(`[SF-LOOKUP-ADV] ✅ Strategy 2 (link click) succeeded — modal closed`)
              }
              break
            }
          }
          if (selectionSucceeded) break
        }
      } catch { continue }
    }
  }

  // ── Strategy 3: RETRY radio selection (second attempt) ───────────────────
  // If first radio attempt failed (possibly due to timing / partial DOM render),
  // wait a bit longer and try again.
  if (!modalClosed && !selectionSucceeded) {
    log.warn(`[SF-LOOKUP-ADV] Strategy 3: Retrying radio selection (second attempt, longer wait)`)
    await page.waitForTimeout(2_000)  // extra stabilization time
    const radioRetry = await selectAdvancedSearchRadio(page, modal, searchValue)
    if (radioRetry) {
      modalClosed = true
      selectionSucceeded = true
      log.info(`[SF-LOOKUP-ADV] ✅ Strategy 3 (radio retry) succeeded`)
    }
  }

  // ── FINAL SAFEGUARD: Escape + clear error for HITL pause ─────────────────
  // If after 2 radio attempts + link click the selection still failed,
  // press Escape to close the modal and throw a clear error so HITL
  // pauses at THIS lookup step, not at Save.
  if (!selectionSucceeded) {
    log.warn(`[SF-LOOKUP-ADV] ⚠ ALL strategies failed (2x radio + link click). Pressing Escape...`)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(1_000)
    modalClosed = await modal.waitFor({ state: 'hidden', timeout: 5_000 })
      .then(() => true).catch(() => false)

    if (!modalClosed) {
      // Force-close via DOM removal
      log.warn(`[SF-LOOKUP-ADV] Modal STILL open after Escape — force-removing topmost dialog`)
      await page.evaluate(() => {
        const dialogs = document.querySelectorAll('lightning-overlay-container section[role="dialog"], [role="dialog"]')
        const backdrops = document.querySelectorAll('lightning-overlay-container .slds-backdrop')
        if (dialogs.length > 1) {
          dialogs[dialogs.length - 1].remove()
          if (backdrops.length > 0) backdrops[backdrops.length - 1].remove()
        }
      })
      await page.waitForTimeout(500)
    }

    throw new Error(
      `[SF-LOOKUP-ADV] Advanced Search FAILED to select "${searchValue}" — ` +
      `all strategies exhausted (2x radio selection + link click fallback). ` +
      `The lookup field is NOT populated. Manual intervention required.`
    )
  }

  await page.waitForTimeout(800)
  log.info(`[SF-LOOKUP-ADV] ✅ Selected "${searchValue}" via advanced search`)
}
// ─── SF Lookup — Production-grade entry point ─────────────────────────────────

/**
 * Robust, production-grade lookup field handler for Salesforce Lightning.
 *
 * This is the PRIMARY entry point for `action: "lookup"` steps.
 * It wraps the entire lookup selection flow with resilient error recovery:
 *
 *   1. Fill the lookup field with the search value (JS focus + pressSequentially
 *      to bypass overlay interception).
 *   2. Click the magnifying glass / search icon if present.
 *   3. Wait for inline dropdown results.
 *   4. If inline dropdown appears → try to click the correct result.
 *   5. If inline fails → open Advanced Search modal.
 *   6. In Advanced Search → search → wait for DOM stability (800ms) →
 *      resilient 3-attempt click with fresh locators + force + dispatchEvent.
 *
 * The inline dropdown path delegates to selectSFLookup() which already has
 * comprehensive handling. This wrapper adds:
 *   • Explicit Advanced Search escalation if selectSFLookup throws
 *   • Overlay dismissal before each attempt
 *   • Clear logging for debugging
 *
 * Example step: {"action":"lookup","target":"Pay To","value":"Test Account - 1","locator_type":"label"}
 *
 * @param page       — Playwright page instance
 * @param fieldLabel — The lookup field label (e.g. "Pay To", "Account Name")
 * @param searchValue — The value to search for and select (e.g. "Test Account - 1")
 */
async function selectLookupValue(
  page: Page,
  fieldLabel: string,
  searchValue: string,
): Promise<void> {
  const resolvedLabel = extractLabelFromTarget(fieldLabel)
  if (resolvedLabel !== fieldLabel) {
    log.info(`[SF-LOOKUP-VALUE] Resolved label: "${fieldLabel}" → "${resolvedLabel}"`)
  }
  log.info(`[SF-LOOKUP-VALUE] ═══ selectLookupValue("${resolvedLabel}", "${searchValue}") ═══`)

  // ── Dismiss stale overlays before starting ──────────────────────────────
  await dismissStaleOverlays(page)

  // ── Attempt 1: Delegate to selectSFLookup (inline dropdown + auto Advanced Search fallback)
  // selectSFLookup already has comprehensive handling for:
  //   • Finding the lookup input (multi-strategy: container→input, XPath, label variants)
  //   • Typing with JS focus (overlay-immune)
  //   • Inline dropdown option clicking
  //   • ArrowDown keyboard nav
  //   • Prefix retry
  //   • Automatic Advanced Search fallback (which now uses resilient 3-attempt clicking)
  try {
    await selectSFLookup(page, resolvedLabel, searchValue)
    log.info(`[SF-LOOKUP-VALUE] ✅ selectSFLookup succeeded for "${searchValue}" in "${resolvedLabel}"`)
    return
  } catch (inlineErr) {
    const errMsg = inlineErr instanceof Error ? inlineErr.message : String(inlineErr)
    log.warn(`[SF-LOOKUP-VALUE] selectSFLookup failed: ${errMsg}`)
    log.info(`[SF-LOOKUP-VALUE] Escalating to direct Advanced Search attempt...`)
  }

  // ── Attempt 2: Direct Advanced Search escalation ────────────────────────
  // If selectSFLookup threw (e.g. couldn't find the input, or dropdown + adv search
  // both failed in a way that didn't handle), we try Advanced Search one more time
  // with a clean slate: dismiss overlays, re-find the input, type, trigger adv search.
  await dismissStaleOverlays(page)
  await page.waitForTimeout(1_000)

  // Re-find the lookup input — use the same expanded strategies as selectSFLookup Strategy 2/3
  const label = resolvedLabel
  const variants = labelCandidates(label)
  let lookupInput: Locator | null = null

  for (const lbl of variants) {
    const xpLoc = page.locator(
      // lightning-lookup (classic)
      `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
      `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-lookup//input` +
      // c-lookup / custom lookup components
      `|//label[contains(normalize-space(),"${lbl}")]/ancestor::c-lookup//input` +
      `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::c-lookup//input` +
      // records-record-picker (newer SF UI)
      `|//label[contains(normalize-space(),"${lbl}")]/ancestor::records-record-picker//input` +
      `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::records-record-picker//input` +
      // Generic: label sibling div with text input
      `|//label[contains(normalize-space(),"${lbl}")]/following-sibling::div//input[@type="text"]` +
      // Generic: slds-form-element ancestor with visible input
      `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::div[contains(@class,"slds-form-element")]//input[not(@type="hidden")]`,
    ).first()
    if (await xpLoc.isVisible({ timeout: 3_000 }).catch(() => false)) {
      lookupInput = xpLoc
      break
    }
  }

  // sfFindFieldContainer fallback
  if (!lookupInput) {
    const container = await sfFindFieldContainer(page, label)
    if (container) {
      const inner = container.locator('input[type="text"], input:not([type="hidden"])').first()
      if (await inner.isVisible({ timeout: 2_000 }).catch(() => false)) {
        lookupInput = inner
      }
    }
  }

  // JS full-page scan — last resort (mirrors Strategy 3 in selectSFLookup)
  if (!lookupInput) {
    const lookupTag2 = `sf-lv-scan-${label.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}`
    const found2 = await page.evaluate(([vars, tag]: [string[], string]) => {
      const allInputs = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[type="text"][autocomplete], input[autocomplete="off"], ' +
        'input[aria-autocomplete], lightning-lookup input, c-lookup input, ' +
        'records-record-picker input, [class*="lookup"] input[type="text"]'
      )).filter(inp => (inp as HTMLElement).offsetParent !== null)

      for (const inp of allInputs) {
        let el: Element | null = inp
        let labelText = ''
        for (let depth = 0; depth < 10 && el; depth++) {
          el = el.parentElement
          if (!el) break
          const labelEl =
            el.querySelector('label, .slds-form-element__label, legend') ??
            el.closest('label')
          if (labelEl) { labelText = labelEl.textContent?.trim() ?? ''; break }
        }
        if (!labelText) labelText = inp.getAttribute('aria-label') ?? inp.getAttribute('placeholder') ?? ''
        if (vars.some(v => v && labelText.toLowerCase().includes(v.toLowerCase()))) {
          inp.setAttribute('data-autotest-lookup-target', tag)
          return true
        }
      }
      return false
    }, [variants, lookupTag2] as [string[], string])

    if (found2) {
      const scanned2 = page.locator(`[data-autotest-lookup-target="${lookupTag2}"]`).first()
      if (await scanned2.isVisible({ timeout: 1_000 }).catch(() => false)) {
        lookupInput = scanned2
        log.info(`[SF-LOOKUP-VALUE] ✅ JS scan found input for "${label}"`)
        await page.evaluate((t: string) => {
          document.querySelector(`[data-autotest-lookup-target="${t}"]`)?.removeAttribute('data-autotest-lookup-target')
        }, lookupTag2).catch(() => {})
      }
    }
  }

  if (!lookupInput) {
    throw new Error(`[SF-LOOKUP-VALUE] Could not find lookup input for "${label}" — both inline and advanced search failed.`)
  }

  // Type the search value using JS focus (overlay-immune)
  await lookupInput.scrollIntoViewIfNeeded()
  await lookupInput.evaluate((el: HTMLElement) => {
    const input = el as HTMLInputElement
    input.focus()
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }))
    input.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    input.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  })
  await page.waitForTimeout(300)
  await lookupInput.evaluate((el: HTMLElement) => { (el as HTMLInputElement).select() })
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(200)
  await lookupInput.pressSequentially(searchValue, { delay: 90 })
  await page.waitForTimeout(1_500)

  // Count dialogs before pressing Enter — detect the Advanced Search modal
  // as a NEW dialog (count increase), not by content filter which falsely
  // matches the parent form modal.
  const dialogCountBefore = await page.locator('[role="dialog"]').count().catch(() => 0)
  await lookupInput.press('Enter')
  await page.waitForTimeout(2_000)
  const dialogCountNow = await page.locator('[role="dialog"]').count().catch(() => 0)

  // Detect the Advanced Search modal:
  // 1. New dialog appeared (count increased)
  // 2. Heading-anchored: 'Advanced Search' in h1/h2
  const advByHeading = page.locator('[role="dialog"]').filter({
    has: page.locator('h1, h2, .slds-modal__title').filter({ hasText: /^Advanced Search$/i })
  }).first()
  const advByNew = dialogCountNow > dialogCountBefore
    ? page.locator('[role="dialog"]').nth(dialogCountNow - 1)
    : null

  const isAdvOpen =
    await advByHeading.isVisible({ timeout: 4_000 }).catch(() => false) ||
    (advByNew ? await advByNew.isVisible({ timeout: 1_000 }).catch(() => false) : false)

  if (isAdvOpen) {
    log.info(`[SF-LOOKUP-VALUE] Advanced Search modal detected (${dialogCountNow} dialogs) — delegating to selectSFLookupAdvanced`)
    await selectSFLookupAdvanced(page, label, searchValue, true)
    log.info(`[SF-LOOKUP-VALUE] ✅ Advanced Search completed for "${searchValue}" in "${label}"`)
  } else {
    throw new Error(
      `[SF-LOOKUP-VALUE] Could not select "${searchValue}" in lookup "${label}" — ` +
      `Advanced Search modal did not open (dialogs before=${dialogCountBefore}, after=${dialogCountNow}).`
    )
  }

  // ── Post-selection validation: verify the field is NOT showing a SF error ─
  // SF Lightning shows: "Select an option from the picklist or remove the search term."
  // when a lookup has unresolved typed text. If present, the value was NOT selected.
  await page.waitForTimeout(1_000)  // Allow SF to render any validation errors
  const sfValidationError = await page.locator(
    // Scoped to common SF error containers
    '.slds-form-element__help, .slds-has-error .slds-form-element__help, ' +
    'p.slds-form-element__help, [class*="fieldLevelHelp"], .helpTextLink'
  ).filter({ hasText: /select an option|remove the search term/i }).count().catch(() => 0)

  if (sfValidationError > 0) {
    throw new Error(
      `[SF-LOOKUP-VALUE] Lookup field "${label}" shows SF validation error after selection attempt: ` +
      `"Select an option from the picklist or remove the search term." ` +
      `Value "${searchValue}" was NOT successfully bound to the field.`
    )
  }

  log.info(`[SF-LOOKUP-VALUE] ✅ Field validation passed — "${searchValue}" is bound to "${label}"`)
}


// ─── SF Date Field handler ────────────────────────────────────────────────────


/**
 * Fills a Salesforce Lightning datepicker field.
 *
 * SF Lightning uses lightning-datepicker → input[type="text"] with MM/DD/YYYY format.
 * Standard Playwright .fill() often fails here because:
 *   1. The parent modal backdrop intercepts .click() without force:true
 *   2. LWC's datepicker needs proper focus+input events, not just a DOM value set
 *   3. The datepicker popup can open and block Tab confirmation
 *
 * Strategy cascade:
 *   1. JS focus + pressSequentially (bypasses overlay, fires proper keyboard events)
 *   2. Triple-click with force:true + pressSequentially
 *   3. Keyboard: Tab to field, clear, type
 *   4. selectAll + type via CDP keyboard
 */
async function fillSFDate(page: Page, rawLabel: string, dateValue: string): Promise<void> {
  const fieldLabel = extractLabelFromTarget(rawLabel)
  if (fieldLabel !== rawLabel) log.info(`[SF-DATE] Resolved label: "${rawLabel}" → "${fieldLabel}"`)
  log.info(`[SF-DATE] Setting date "${dateValue}" in "${fieldLabel}"`)

  // Dismiss any ghost overlays from previous steps before interacting
  await dismissStaleOverlays(page)

  // ── Normalize date value to MM/DD/YYYY ───────────────────────────────────
  // Accepts:  2025-12-31 (ISO 8601)         → 12/31/2025
  //           31/12/2025 (DD/MM/YYYY)       → 12/31/2025
  //           31-12-2025 (DD-MM-YYYY)       → 12/31/2025
  //           12/31/2025 (already correct)  → unchanged
  let formatted = dateValue.trim()
  const iso = formatted.match(/^(\d{4})[/-](\d{2})[/-](\d{2})$/)
  const dmy = formatted.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/)
  if (iso) {
    formatted = `${iso[2]}/${iso[3]}/${iso[1]}`        // YYYY-MM-DD → MM/DD/YYYY
  } else if (dmy) {
    // Heuristic: if first chunk > 12 it must be day; else ambiguous — treat as DD/MM/YYYY
    const maybeDay = parseInt(dmy[1], 10)
    if (maybeDay > 12) {
      formatted = `${dmy[2]}/${dmy[1]}/${dmy[3]}`      // DD/MM/YYYY → MM/DD/YYYY
    }
    // else: first part ≤ 12, could be MM/DD/YYYY already — leave unchanged
  }
  log.info(`[SF-DATE] Normalised date value: "${dateValue}" → "${formatted}"`)

  // ── Locate the datepicker input ──────────────────────────────────────────
  let dateInput: Locator | null = null
  const FIND_TIMEOUT = 15_000
  const start = Date.now()

  while (!dateInput && Date.now() - start < FIND_TIMEOUT) {
    // Strategy A: sfFindFieldContainer → inner input
    const container = await sfFindFieldContainer(page, fieldLabel)
    if (container) {
      const inner = container.locator(
        'input[type="text"], input[placeholder*="/"], input[placeholder*="MM"]'
      ).first()
      if (await inner.isVisible({ timeout: 1_000 }).catch(() => false)) {
        dateInput = inner
        break
      }
    }

    // Strategy B: XPath anchored on label → lightning-datepicker → input
    if (!dateInput) {
      const variants = labelCandidates(fieldLabel)
      for (const lbl of variants) {
        const xpLoc = page.locator(
          `xpath=//label[contains(normalize-space(),"${lbl}")]/ancestor::lightning-datepicker//input` +
          `|//span[contains(@class,"slds-form-element__label") and contains(normalize-space(),"${lbl}")]/ancestor::lightning-datepicker//input` +
          `|//label[contains(normalize-space(),"${lbl}")]/following::input[@type="text"][1]`,
        ).first()
        if (await xpLoc.isVisible({ timeout: 1_000 }).catch(() => false)) {
          dateInput = xpLoc
          break
        }
      }
    }

    if (!dateInput) await page.waitForTimeout(500)
  }

  if (!dateInput) {
    throw new Error(`[SF-DATE] Could not find date input for "${fieldLabel}" after ${FIND_TIMEOUT}ms`)
  }

  log.info(`[SF-DATE] ✅ Found date input for "${fieldLabel}"`)
  await dateInput.scrollIntoViewIfNeeded().catch(() => { })

  // ── Helper: verify the date was accepted (field shows expected text) ─────
  const verifyDate = async (): Promise<boolean> => {
    try {
      const val = await dateInput!.inputValue().catch(() => '')
      // Accept if the value contains the month or day from our formatted date
      const parts = formatted.split('/')
      return val.includes(parts[0]) || val.includes(formatted)
    } catch { return false }
  }

  // ── Strategy 1: JS focus + pressSequentially (primary) ──────────────────
  // JS focus fires SF's LWC event listeners WITHOUT needing a physical click.
  // pressSequentially sends CDP keyboard events — bypasses overlay interception.
  log.info(`[SF-DATE] Strategy 1: JS focus + pressSequentially`)
  try {
    await dateInput.evaluate((el: HTMLElement) => {
      const inp = el as HTMLInputElement
      inp.focus()
      inp.select()
      inp.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
      inp.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+A')        // select all existing text
    await page.keyboard.press('Backspace')         // clear it
    await page.waitForTimeout(100)
    await dateInput.pressSequentially(formatted, { delay: 60 })
    await page.waitForTimeout(300)

    // Close any datepicker popup that opened, then Tab to confirm
    await page.keyboard.press('Escape').catch(() => { })
    await page.waitForTimeout(150)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)

    if (await verifyDate()) {
      log.info(`[SF-DATE] ✅ Strategy 1 succeeded`)
      return
    }
    log.warn(`[SF-DATE] Strategy 1: value not confirmed — continuing`)
  } catch (e) {
    log.warn(`[SF-DATE] Strategy 1 failed: ${(e as Error).message}`)
  }

  // ── Strategy 2: force triple-click + pressSequentially ──────────────────
  // force:true bypasses Playwright's "element covered by parent backdrop" check.
  log.info(`[SF-DATE] Strategy 2: force triple-click + pressSequentially`)
  try {
    await dateInput.click({ clickCount: 3, force: true, timeout: 5_000 })
    await page.waitForTimeout(200)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await dateInput.pressSequentially(formatted, { delay: 60 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape').catch(() => { })
    await page.waitForTimeout(150)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)

    if (await verifyDate()) {
      log.info(`[SF-DATE] ✅ Strategy 2 succeeded`)
      return
    }
    log.warn(`[SF-DATE] Strategy 2: value not confirmed — continuing`)
  } catch (e) {
    log.warn(`[SF-DATE] Strategy 2 failed: ${(e as Error).message}`)
  }

  // ── Strategy 3: Playwright .fill() after forced focus ───────────────────
  // Some datepicker variants accept a plain fill() after focus is established.
  log.info(`[SF-DATE] Strategy 3: forced focus + .fill()`)
  try {
    await dateInput.focus().catch(() => { })
    await page.waitForTimeout(200)
    await dateInput.fill(formatted, { timeout: 5_000 })
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape').catch(() => { })
    await page.waitForTimeout(150)
    await dateInput.press('Tab')
    await page.waitForTimeout(500)

    if (await verifyDate()) {
      log.info(`[SF-DATE] ✅ Strategy 3 succeeded`)
      return
    }
    log.warn(`[SF-DATE] Strategy 3: value not confirmed — continuing`)
  } catch (e) {
    log.warn(`[SF-DATE] Strategy 3 failed: ${(e as Error).message}`)
  }

  // ── Strategy 4: page.mouse.click() at element center + keyboard type ────
  // Raw CDP mouse event at absolute viewport coordinates — cannot be blocked
  // by any overlay. After focus, type the date char-by-char.
  log.info(`[SF-DATE] Strategy 4: page.mouse.click() at element center + keyboard type`)
  try {
    const box = await dateInput.boundingBox().catch(() => null)
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    } else {
      await dateInput.click({ force: true }).catch(() => { })
    }
    await page.waitForTimeout(200)
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(100)
    await page.keyboard.type(formatted, { delay: 60 })
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape').catch(() => { })
    await page.waitForTimeout(150)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(500)

    if (await verifyDate()) {
      log.info(`[SF-DATE] ✅ Strategy 4 succeeded`)
      return
    }
    log.warn(`[SF-DATE] Strategy 4: value not confirmed — proceeding anyway`)
  } catch (e) {
    log.warn(`[SF-DATE] Strategy 4 failed: ${(e as Error).message}`)
  }

  log.info(`[SF-DATE] ✅ Date "${formatted}" fill attempted for "${fieldLabel}"`)
}

// ─── Smart locator resolver ───────────────────────────────────────────────────

function resolveLocator(page: Page, step: StepData): Locator {
  let target = step.target ?? ''
  let locatorType = (step.locator_type ?? '').toLowerCase().trim()
  const action = (step.action || '').toLowerCase().replace(/[-_\s]/g, '')

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
    if (/^(?:page\.)?getByLabel/i.test(raw)) locatorType = 'label'
    else if (/^(?:page\.)?getByText/i.test(raw)) locatorType = 'text'
    else if (/^(?:page\.)?getByPlaceholder/i.test(raw)) locatorType = 'placeholder'
    else if (isRole) locatorType = 'role'
    else if (/^(?:page\.)?getByTitle/i.test(raw)) locatorType = 'title'
    else if (/^(?:page\.)?getByAltText/i.test(raw)) locatorType = 'alt'
  }

  // API Name to Label Normalization (Custom_Field__c → Custom Field)
  if (/__(c|r|C|R)$/.test(target)) {
    target = target.slice(0, -3).replace(/_/g, ' ').trim()
  }

  // Auto-detect locator_type from target pattern
  if (!locatorType || locatorType === 'css') {
    if (/^role=\w+,\s*name=/.test(target)) locatorType = 'role'
    else if (target.startsWith('label=')) { locatorType = 'label'; target = target.slice(6) }
    else if (target.startsWith('text=')) { locatorType = 'text'; target = target.slice(5) }
    // For assertion actions, treat the target as plain text even if it contains dots
    // (e.g. version strings like "Administratorv0.1.0" must NOT be parsed as CSS selectors)
    else if (['assert', 'assertvisible', 'asserttext', 'verify', 'verifyvisible', 'verifytext'].includes(action) &&
             !target.match(/[\[\]>()#,]/) && target.length > 0) locatorType = 'text'
    else if (!target.match(/[.#\[\]>:=]/) && target.length > 0) locatorType = 'label'
  }

  // Normalise AI-generated variants
  if (['role_button', 'button_role', 'button', 'btn'].includes(locatorType)) {
    locatorType = 'role'
    if (!/^role=\w+,\s*name=/.test(target) && !target.includes(':')) target = `button:${target}`
  }
  if (['field_label', 'get_by_label', 'by_label', 'field_name'].includes(locatorType)) locatorType = 'label'
  if (['get_by_text', 'by_text', 'inner_text'].includes(locatorType)) locatorType = 'text'
  if (target.startsWith('getByRole(') || target.startsWith('page.getByRole(')) locatorType = 'role'

  switch (locatorType) {
    case 'label':
      if (action === 'click') {
        return page.getByLabel(target, { exact: false })
          .or(page.getByRole('link', { name: target, exact: false }))
          .or(page.getByRole('button', { name: target, exact: false }))
          .or(page.getByText(target, { exact: false }))
      }
      {
        // For input actions (enter, fill, type), broaden the search.
        // Many web apps don't properly link <label for="id"> and rely on placeholders,
        // name attributes, or visually adjacent text.
        const snakeTarget = target.toLowerCase().replace(/\s+/g, '_')
        const camelTarget = target.replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) => {
          return index === 0 ? word.toLowerCase() : word.toUpperCase()
        }).replace(/\s+/g, '')

        return page.getByLabel(target, { exact: false })
          .or(page.getByPlaceholder(target, { exact: false }))
          .or(page.locator(`input[name="${target}" i], textarea[name="${target}" i]`))
          .or(page.locator(`input[name="${snakeTarget}" i], textarea[name="${snakeTarget}" i]`))
          .or(page.locator(`input[name="${camelTarget}" i], textarea[name="${camelTarget}" i]`))
          .or(page.locator(`input[id="${target}" i], textarea[id="${target}" i]`))
          .or(page.locator(`input[id="${snakeTarget}" i], textarea[id="${snakeTarget}" i]`))
          .or(page.locator(`input[id="${camelTarget}" i], textarea[id="${camelTarget}" i]`))
          // Extreme fallback for visually adjacent labels in SPAs:
          // Find text that matches the label, then look for the next input
          .or(page.locator(`:text-is("${target}") + input, :text-is("${target}") + * input`))
      }


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
          const [tagName, inputType] = await labelLoc.evaluate(
            el => [(el as HTMLElement).tagName?.toUpperCase() ?? '', (el as HTMLInputElement).type?.toLowerCase() ?? ''],
          ).catch(() => ['', ''])
          // Skip range sliders, hidden inputs, and non-interactive elements
          // (Salesforce uses aria-label on <button> picklist triggers and icon buttons
          // that can match a field label — e.g. Company, Lead Source, etc.)
          if (inputType === 'range' || inputType === 'hidden') continue
          if (tagName === 'BUTTON') {
            log.info(`[MODAL-SCOPE] ⏭ Skipping <button> matched by getByLabel("${lbl}") nth(${li}) — not a fill target`)
            continue
          }
          // Skip <select> only when it is NOT a multi-select (multi-selects are our dual-listbox fallback)
          if (tagName === 'SELECT' && !(labelLoc as any).multiple) {
            const isMultiple = await labelLoc.evaluate(el => (el as HTMLSelectElement).multiple).catch(() => false)
            if (!isMultiple) {
              log.info(`[MODAL-SCOPE] ⏭ Skipping <select> matched by getByLabel("${lbl}") nth(${li})`)
              continue
            }
          }
          log.info(`[MODAL-SCOPE] ✅ Found "${extracted}" inside modal via getByLabel("${lbl}") (nth ${li}) [tag=${tagName}]`)
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
        const [pTagName, pInputType] = await loc.evaluate(
          el => [(el as HTMLElement).tagName?.toUpperCase() ?? '', (el as HTMLInputElement).type?.toLowerCase() ?? ''],
        ).catch(() => ['', ''])
        if (pInputType === 'range' || pInputType === 'hidden') continue
        // Skip buttons — SF renders aria-labeled buttons for picklist/lookup triggers
        // that substring-match field names (e.g. "Company" button inside a compound field).
        if (pTagName === 'BUTTON') {
          log.info(`[PAGE-SCOPE] ⏭ Skipping <button> matched by getByLabel("${lbl}") nth(${i}) — not a fill target`)
          continue
        }
        if (pTagName === 'SELECT') {
          const isMultiple = await loc.evaluate(el => (el as HTMLSelectElement).multiple).catch(() => false)
          if (!isMultiple) {
            log.info(`[PAGE-SCOPE] ⏭ Skipping <select> matched by getByLabel("${lbl}") nth(${i})`)
            continue
          }
        }
        const isGlobal = await loc.evaluate(
          el => !!el.closest('one-app-nav-bar, .slds-global-header_container'),
        ).catch(() => false)
        if (isGlobal) continue
        log.info(`[PAGE-SCOPE] ✅ Found "${extracted}" page-wide via getByLabel("${lbl}") (nth ${i}) [tag=${pTagName}]`)
        return loc
      }
    }
  }
  return getFirstVisibleLocator(resolveLocator(page, step), 10_000)
}

// ─── Smart Web App Click — navigation-menu aware ──────────────────────────────
//
// Used for all non-destructive, non-role-string click targets in web apps.
// Implements 8 progressive strategies so that navigation items like
// "Admin Panel", "Settings", sidebar links, etc. are found even when they are:
//  • Inside a <nav> / sidebar that requires scrolling
//  • Hidden behind a collapsed hamburger / toggle
//  • Only reachable via role="link" or aria-label
//  • Rendered as <li>, <a>, or custom SPA route components
//
// Returns true if the element was clicked, throws if all strategies fail.

async function smartWebAppClick(
  page: Page,
  target: string,
  logger: ReturnType<typeof createModuleLogger>,
): Promise<boolean> {
  const isSelector = target.startsWith('.') || target.startsWith('#') || target.startsWith('[')

  // ── Strategy 0: CSS / attribute selector (direct) ───────────────────────────
  if (isSelector) {
    try {
      const loc = page.locator(target).first()
      await loc.waitFor({ state: 'visible', timeout: 5_000 })
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 0 (CSS selector): "${target}"`)
      return true
    } catch { /* try next */ }
  }

  // ── Strategy 1: Exact text match (fastest) ───────────────────────────────────
  try {
    const loc = page.getByText(target, { exact: true }).first()
    if (await loc.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 1 (exact text): "${target}"`)
      return true
    }
  } catch { /* try next */ }

  // ── Strategy 2: Role=link (navigation menu items are almost always <a>) ──────
  try {
    const loc = page.getByRole('link', { name: target, exact: false }).first()
    if (await loc.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 2 (role=link): "${target}"`)
      return true
    }
  } catch { /* try next */ }

  // ── Strategy 2b: Scoped nav-container role=link (faster for sidebar items) ────
  // Searches role=link within <nav>/sidebar containers first, which is more
  // precise than page-wide and avoids false matches in main content areas.
  const NAV_CONTAINER_SELECTORS = [
    'nav', '[role="navigation"]', '[role="menubar"]',
    '[class*="sidebar"]', '[class*="sidenav"]', '[class*="side-nav"]',
    '[id*="sidebar"]', '[id*="side-nav"]',
  ]
  for (const navSel of NAV_CONTAINER_SELECTORS) {
    try {
      const container = page.locator(navSel).first()
      if (!await container.isVisible({ timeout: 500 }).catch(() => false)) continue
      const scopedLink = container.getByRole('link', { name: target, exact: false }).first()
      if (await scopedLink.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await scopedLink.scrollIntoViewIfNeeded().catch(() => {})
        await scopedLink.click()
        logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 2b (scoped nav ${navSel} + link): "${target}"`)
        return true
      }
    } catch { /* try next */ }
  }

  // ── Strategy 3: Role=menuitem (dropdown / sidebar nav items) ─────────────────
  try {
    const loc = page.getByRole('menuitem', { name: target, exact: false }).first()
    if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 3 (role=menuitem): "${target}"`)
      return true
    }
  } catch { /* try next */ }

  // ── Strategy 4: Role=button (some nav items render as buttons) ───────────────
  try {
    const loc = page.getByRole('button', { name: target, exact: false }).first()
    if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await loc.scrollIntoViewIfNeeded().catch(() => {})
      await loc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 4 (role=button): "${target}"`)
      return true
    }
  } catch { /* try next */ }

  // ── Strategy 5: aria-label attribute match ───────────────────────────────────
  try {
    const ariaLoc = page.locator(
      `[aria-label*="${target}" i], [title*="${target}" i], [data-title*="${target}" i]`
    ).first()
    if (await ariaLoc.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await ariaLoc.scrollIntoViewIfNeeded().catch(() => {})
      await ariaLoc.click()
      logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 5 (aria-label/title): "${target}"`)
      return true
    }
  } catch { /* try next */ }

  // ── Strategy 6: Collapsed nav — try to open hamburger / sidebar toggle first ─
  // Many SPAs hide their nav on smaller viewports / initial state.
  // Try toggling any hamburger, nav toggle, or sidebar opener, then retry.
  const HAMBURGER_SELECTORS = [
    'button[aria-label*="menu" i]',
    'button[aria-label*="navigation" i]',
    'button[aria-label*="sidebar" i]',
    'button[aria-label*="toggle" i]',
    '[class*="hamburger"]',
    '[class*="menu-toggle"]',
    '[class*="nav-toggle"]',
    '[class*="sidebar-toggle"]',
    '[class*="sidebar-open"]',
    '[id*="sidebar-toggle"]',
    '[id*="menu-toggle"]',
  ]
  for (const hamSel of HAMBURGER_SELECTORS) {
    try {
      const ham = page.locator(hamSel).first()
      if (!await ham.isVisible({ timeout: 500 }).catch(() => false)) continue

      await ham.click()
      await page.waitForTimeout(600)
      logger.info(`[WEBAPP-SMART-CLICK] Opened collapsed nav via "${hamSel}" — retrying target "${target}"`)

      // Retry link/text after expanding nav
      const retryLink = page.getByRole('link', { name: target, exact: false }).first()
      if (await retryLink.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await retryLink.scrollIntoViewIfNeeded().catch(() => {})
        await retryLink.click()
        logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 6 (hamburger expand + link): "${target}"`)
        return true
      }
      const retryText = page.getByText(target, { exact: false }).first()
      if (await retryText.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await retryText.scrollIntoViewIfNeeded().catch(() => {})
        await retryText.click()
        logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 6 (hamburger expand + text): "${target}"`)
        return true
      }

      // Close nav again if we didn't find it (undo toggle)
      await ham.click().catch(() => {})
      await page.waitForTimeout(300)
    } catch { /* try next hamburger */ }
  }

  // ── Strategy 7: Scroll nav to find hidden item ───────────────────────────────
  // Some sidebars have more items below the fold — scroll inside <nav> / sidebar
  const NAV_CONTAINERS = ['nav', '[role="navigation"]', '[class*="sidebar"]', '[class*="nav"]', '[id*="nav"]', '[id*="sidebar"]']
  for (const navSel of NAV_CONTAINERS) {
    try {
      const container = page.locator(navSel).first()
      if (!await container.isVisible({ timeout: 500 }).catch(() => false)) continue

      // Scroll the container down to reveal items
      await container.evaluate((el) => { el.scrollTop = el.scrollHeight }).catch(() => {})
      await page.waitForTimeout(400)

      const scrolledLink = page.getByRole('link', { name: target, exact: false }).first()
      if (await scrolledLink.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await scrolledLink.scrollIntoViewIfNeeded().catch(() => {})
        await scrolledLink.click()
        logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 7 (nav scroll + link): "${target}"`)
        return true
      }
    } catch { /* try next */ }
  }

  // ── Strategy 8: Partial text fallback (broadest, last resort) ────────────────
  try {
    const loc = page.getByText(target, { exact: false }).first()
    await loc.waitFor({ state: 'visible', timeout: 8_000 })
    await loc.scrollIntoViewIfNeeded().catch(() => {})
    await loc.click()
    logger.info(`[WEBAPP-SMART-CLICK] ✅ Strategy 8 (partial text fallback): "${target}"`)
    return true
  } catch { /* all strategies exhausted */ }

  throw new Error(
    `smartWebAppClick: all 8 strategies failed to locate "${target}". ` +
    `Tried: CSS selector, exact text, role=link, role=menuitem, role=button, ` +
    `aria-label, hamburger toggle, nav scroll, partial text.`
  )
}

// ─── Action executor ──────────────────────────────────────────────────────────

async function executeStep(
  page: Page,
  step: StepData,
  stepIndex: number,
  isLastStep: boolean,
  screenshotsDir: string,
  executionId: string,
  // SF + Web session recovery — passed from processExecution
  browserCtx?: BrowserContext,
  projectId?: string,
  projectCategory?: string,
  execJobContext?: ExecutionJob['context'],
): Promise<ExecutionStepResult> {
  const start = Date.now()
  const action = step.action.toLowerCase().replace(/[-_\s]/g, '')
  const target = step.target ?? ''
  const value = step.value ?? ''
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
            // Priority 1: use the project's configured baseUrl ORIGIN
            // IMPORTANT: baseUrl may be the LOGIN URL (e.g. https://crmd.datasirpi.com/login)
            // — we must extract just the origin to avoid producing /login/accounts/create
            const projectBase = execJobContext?.baseUrl
            if (projectBase && projectBase.startsWith('http')) {
              try {
                resolvedUrl = `${new URL(projectBase).origin}${navUrl}`
              } catch {
                resolvedUrl = `${projectBase.replace(/\/[^/]*$/, '')}${navUrl}`
              }
            } else {
              // Priority 2: derive origin from the current live page URL
              // NOTE: page.url() can be 'about:blank' before first navigation, in which case
              // new URL(...).origin === 'null' (the string). Guard against that.
              try {
                const origin = new URL(page.url()).origin
                if (origin && origin !== 'null') {
                  resolvedUrl = `${origin}${navUrl}`
                }
              } catch { /* remain as-is — page.goto will throw with a clear error */ }
            }
          }
          try {
            await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          } catch (navErr: unknown) {
            const msg = navErr instanceof Error ? navErr.message : String(navErr)
            if (!msg.includes('ERR_ABORTED')) throw navErr
            log.warn(`[EXEC] NAVIGATE: ERR_ABORTED ignored (SF SPA) at step ${stepIndex + 1}`)
          }
          // Clear frame context and field map on navigation
          frameRegistry.delete(executionId)
          sfFieldMapRegistry.delete(executionId)

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

          // ── Web App Session Guard ───────────────────────────────────────────
          // Web apps redirect unauthenticated users to /login (or similar).
          // If we detect such a redirect after navigation, re-run loginToWebApp
          // (which has full credentials via execJobContext) and retry navigation.
          if (isWebAppCategory(projectCategory) && projectId && browserCtx && execJobContext?.webLoginUrl) {
            await page.waitForTimeout(2_000)
            const postNavUrl = page.url().toLowerCase()
            const loginUrlLower = (execJobContext.webLoginUrl ?? '').toLowerCase()
            const loginIndicators = ['/login', '/signin', '/sign-in', '/auth', '/session/new']
            const redirectedToLogin =
              // URL-based: we ended up on a login-like path
              loginIndicators.some(p => postNavUrl.includes(p)) ||
              // Or we ended up exactly at the login URL we know about
              (loginUrlLower !== '' && postNavUrl.startsWith(loginUrlLower)) ||
              // DOM-based: a password field is visible on the page now
              await page.locator('input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false)

            // Also detect "silent redirects" — some apps send
            // unauthenticated users to /home or /dashboard instead of /login.
            // EXCEPTION: if the intended path IS a login/auth page (e.g. /login),
            // landing on /home or /dashboard is a SUCCESSFUL LOGIN — not a session expiry.
            const intendedPath = (() => { try { return new URL(resolvedUrl).pathname.replace(/\/$/, '') || '/' } catch { return '' } })()
            const actualPath   = (() => { try { return new URL(page.url()).pathname.replace(/\/$/, '') || '/' } catch { return '' } })()
            const IS_LOGIN_PATH = /\/(login|signin|sign-in|sign_in|auth|session|sso|oauth|authenticate|logon)(\/|$)/i
            const intendedIsLoginPage = IS_LOGIN_PATH.test(intendedPath)
            const silentRedirect =
              !redirectedToLogin &&
              !intendedIsLoginPage &&     // ← login→home is expected, not a session expiry
              intendedPath !== '' &&
              actualPath !== intendedPath &&
              !actualPath.startsWith(intendedPath + '/') &&
              !intendedPath.startsWith(actualPath + '/') &&
              /^\/(home|dashboard|index|main|app)(\/|$)/.test(actualPath)

            if ((redirectedToLogin || silentRedirect) && postNavUrl !== resolvedUrl.toLowerCase()) {
              log.warn(
                `[EXEC] NAVIGATE step ${stepIndex + 1}: Web app session expired — ` +
                `${redirectedToLogin ? 'login redirect' : `silent redirect to "${actualPath}"`} detected. ` +
                `Re-authenticating…`,
              )
              await loginToWebApp(page, browserCtx, execJobContext, projectId)
              log.info(`[EXEC] Web app re-auth OK — retrying navigation to ${resolvedUrl}`)
              try {
                await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
              } catch (retryErr: unknown) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
                if (!retryMsg.includes('ERR_ABORTED')) throw retryErr
              }
            }
          }

          // ── Web App URL Verification & Smart Retry ─────────────────────────
          // For web app projects, verify we landed on the intended page.
          // Special handling for form paths (/new, /create, /add) — these MUST
          // reach the actual form, not the list page.
          if (isWebAppCategory(projectCategory) && resolvedUrl.startsWith('http')) {
            await page.waitForTimeout(1_500)
            const finalUrl = page.url()
            try {
              const expectedPath = new URL(resolvedUrl).pathname.replace(/\/$/, '') || '/'
              const finalPath   = new URL(finalUrl).pathname.replace(/\/$/, '') || '/'
              const isFormPath = /\/(new|create|add|edit)$/.test(expectedPath)

              if (finalPath === expectedPath) {
                log.info(`[EXEC] NAVIGATE ✅ URL verified: "${expectedPath}"`)
              } else if (isFormPath) {
                // Form path redirect detected — try alternative URLs + button click
                const baseOrigin = new URL(resolvedUrl).origin
                const pathParts = expectedPath.split('/')
                const formAction = pathParts.pop()!
                const entityBase = pathParts.join('/')

                const altPaths = ['new', 'create', 'add']
                  .filter(p => p !== formAction)
                  .map(p => `${entityBase}/${p}`)

                let foundForm = false
                for (const altPath of altPaths) {
                  try {
                    log.info(`[EXEC] NAVIGATE: "${expectedPath}" redirected → trying "${altPath}"`)
                    await page.goto(`${baseOrigin}${altPath}`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
                    await page.waitForTimeout(1_500)
                    const newPath = new URL(page.url()).pathname.replace(/\/$/, '') || '/'
                    if (newPath === altPath) {
                      log.info(`[EXEC] NAVIGATE ✅ Alternative URL worked: "${altPath}"`)
                      foundForm = true
                      break
                    }
                  } catch { /* try next */ }
                }

                // If no direct URL works, click "New" button from the list page
                if (!foundForm) {
                  log.info(`[EXEC] NAVIGATE: No direct URL worked — clicking New button from list`)
                  await page.goto(`${baseOrigin}${entityBase}`, { waitUntil: 'domcontentloaded', timeout: 15_000 })
                  await page.waitForTimeout(2_000)

                  const entitySlug = entityBase.split('/').pop()?.replace(/s$/, '') || ''
                  const entityCap = entitySlug.charAt(0).toUpperCase() + entitySlug.slice(1)
                  const buttonNames = [
                    `New ${entityCap}`, `+ New ${entityCap}`, `Create ${entityCap}`,
                    `Add ${entityCap}`, 'New', '+ New', 'Create', 'Add',
                  ]

                  for (const btnText of buttonNames) {
                    const btn = page.getByRole('button', { name: btnText, exact: false })
                    const lnk = page.getByRole('link', { name: btnText, exact: false })
                    const el = (await btn.count() > 0) ? btn.first() :
                               (await lnk.count() > 0) ? lnk.first() : null
                    if (el && await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
                      await el.click()
                      await page.waitForTimeout(2_000)
                      log.info(`[EXEC] NAVIGATE ✅ Clicked "${btnText}" to reach form`)
                      foundForm = true
                      break
                    }
                  }

                  if (!foundForm) {
                    throw new Error(
                      `NAVIGATE failed: form page "${expectedPath}" redirected to "${finalPath}". ` +
                      `Tried alt URLs and button clicks — none reached the form.`
                    )
                  }
                }

                // Wait for form to render after arriving
                await page.locator(
                  'input:not([type="hidden"]), textarea, select, form',
                ).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
              } else {
                // Non-form path: accept flexible SPA parent-route matches
                const pathMatches =
                  finalPath.startsWith(expectedPath + '/') ||
                  expectedPath.startsWith(finalPath + '/')

                // ── Login → landing page is a SUCCESSFUL LOGIN, not a permission denial ──
                // When the test navigates to /login and after authentication the app
                // redirects to /home or /dashboard, that's normal successful behavior
                // for ALL web apps. Do NOT flag this as PERMISSION DENIED.
                const LOGIN_PAGE_PATTERNS = /\/(login|signin|sign-in|sign_in|auth|session|sso|oauth|authenticate|logon)(\/|$)/i
                const LANDING_PAGE_PATTERNS = /^\/(home|dashboard|index|main|app|welcome|overview|portal|console|workspace)(\/|$)/i
                const isLoginToLandingRedirect =
                  LOGIN_PAGE_PATTERNS.test(expectedPath) && LANDING_PAGE_PATTERNS.test(finalPath)

                if (isLoginToLandingRedirect) {
                  log.info(
                    `[EXEC] NAVIGATE ✅ Successful login redirect: "${expectedPath}" → "${finalPath}" (authenticated OK)`,
                  )
                } else if (!pathMatches) {
                  // Distinguish permission-denied from a normal unexpected redirect.
                  // If we end up on /home or /dashboard AFTER a valid re-auth,
                  // the account simply lacks access to this page.
                  const isPermissionDenied = /^\/(home|dashboard|index|main|app)(\/|$)/.test(finalPath)
                  const errMsg = isPermissionDenied
                    ? `NAVIGATE failed — PERMISSION DENIED: "${expectedPath}" redirected to "${finalPath}". ` +
                      `The logged-in account does not have access to this page. Grant the required role/permission in the app or use a privileged account.`
                    : `NAVIGATE failed: requested "${expectedPath}" but landed on "${finalPath}".`
                  throw new Error(errMsg)
                } else {
                  log.info(`[EXEC] NAVIGATE ✅ SPA parent route match: "${expectedPath}" → "${finalPath}"`)
                }
              }
            } catch (urlVerifyErr: unknown) {
              if (urlVerifyErr instanceof Error && urlVerifyErr.message.startsWith('NAVIGATE failed')) throw urlVerifyErr
              log.warn({ err: urlVerifyErr }, '[EXEC] URL verification parse error (non-fatal)')
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
          } else if (isWebAppCategory(projectCategory)) {
            // Web app SPA stabilization: React/Vue/Angular mount components AFTER domcontentloaded.
            // Wait up to 5s for any visible input or form element before proceeding.
            await page.locator(
              'input:not([type="hidden"]):not([type="range"]), textarea, select, form, [role="form"]',
            ).first().waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
              // Page may be a non-form page (e.g. dashboard) — that's fine, continue
            })
          }
          break
        }

        // ── Click ──────────────────────────────────────────
        case 'click': {
          // Dismiss any lingering SF error modals before clicking
          await dismissErrorModal(page)

          if (activeFrame) {
            const frameLoc = activeFrame.locator(target)
            await frameLoc.waitFor({ state: 'visible', timeout: 15_000 })
            await frameLoc.click()
          } else if (isWebAppCategory(projectCategory)) {
            // ── Web App click path ────────────────────────────────────────
            // Bypasses SF modal scoping. Uses smart fallback when button name
            // doesn't exactly match (e.g. AI generates "Save" but actual is "Create Account").
            const roleMatch = target.match(/role=(\w+),\s*name=(.+)/i)
            let clicked = false

            if (roleMatch) {
              const [, role, name] = roleMatch
              const btnName = name.trim()

              // Try 1: exact role match
              const exactLoc = page.getByRole(role as any, { name: btnName, exact: true })
              if (await exactLoc.count().catch(() => 0) > 0 &&
                  await exactLoc.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
                await exactLoc.first().scrollIntoViewIfNeeded().catch(() => {})
                await exactLoc.first().click()
                clicked = true
                log.info(`[WEBAPP-ENGINE] ✅ Clicked "${btnName}" (exact match)`)
              }

              // Try 2: partial/fuzzy role match (e.g. "Save" matches "Save & New")
              if (!clicked) {
                const partialLoc = page.getByRole(role as any, { name: btnName, exact: false })
                if (await partialLoc.count().catch(() => 0) > 0 &&
                    await partialLoc.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
                  await partialLoc.first().scrollIntoViewIfNeeded().catch(() => {})
                  await partialLoc.first().click()
                  clicked = true
                  log.info(`[WEBAPP-ENGINE] ✅ Clicked "${btnName}" (partial match)`)
                }
              }

              // Try 3: common submit button alternatives (Save→Create X, Submit, etc.)
              if (!clicked && ['save', 'submit'].includes(btnName.toLowerCase())) {
                // Look for any submit-like button: Create*, Submit, Save*, OK
                const submitPatterns = [
                  'Create', 'Submit', 'Save', 'Add', 'OK', 'Confirm', 'Done',
                ]
                for (const pattern of submitPatterns) {
                  const altLoc = page.getByRole('button', { name: new RegExp(pattern, 'i') })
                  const count = await altLoc.count().catch(() => 0)
                  for (let i = 0; i < count; i++) {
                    const btn = altLoc.nth(i)
                    const isVisible = await btn.isVisible({ timeout: 1_000 }).catch(() => false)
                    if (isVisible) {
                      const btnText = await btn.textContent().catch(() => '') || ''
                      // Skip navigation/sidebar buttons — look for primary action buttons
                      if (['cancel', 'back', 'close', 'collapse', 'expand'].some(
                        skip => btnText.toLowerCase().includes(skip))) continue
                      await btn.scrollIntoViewIfNeeded().catch(() => {})
                      await btn.click()
                      clicked = true
                      log.info(`[WEBAPP-ENGINE] ✅ Clicked submit alternative: "${btnText.trim()}" (looked for "${btnName}")`)
                      break
                    }
                  }
                  if (clicked) break
                }
              }

              // Try 4: visible text match
              if (!clicked) {
                const textLoc = page.getByText(btnName, { exact: true })
                if (await textLoc.count().catch(() => 0) > 0 &&
                    await textLoc.first().isVisible({ timeout: 2_000 }).catch(() => false)) {
                  await textLoc.first().click()
                  clicked = true
                  log.info(`[WEBAPP-ENGINE] ✅ Clicked by text: "${btnName}"`)
                }
              }
            }

            // Not a role locator — use smart click with action-menu awareness
            const isDestructiveAction = /^(delete|remove|archive|deactivate|trash)$/i.test(target.trim())
            if (!clicked) {

              if (isDestructiveAction) {
                // ── Destructive action strategy ─────────────────────────────
                // "Delete" is almost never a standalone visible button in CRMs.
                // It is typically hidden behind a context/action/kebab menu.
                // Strategy:
                //   1. Try direct visibility first (quick check, no long wait)
                //   2. Try action menu triggers (⋮, ▼, "Actions", "More") → open → click Delete
                //   3. Fall back to getByText with short timeout
                log.info(`[WEBAPP-ENGINE] Destructive action "${target}" — checking direct visibility first`)

                // Step 1: Quick check — is a Delete button directly visible?
                const DESTRUCTIVE_SELECTORS = [
                  `button:has-text("${target}")`,
                  `[role="menuitem"]:has-text("${target}")`,
                  `[role="option"]:has-text("${target}")`,
                  `a:has-text("${target}")`,
                  `li:has-text("${target}")`,
                ]
                let directlyVisible = false
                for (const sel of DESTRUCTIVE_SELECTORS) {
                  try {
                    const el = page.locator(sel).first()
                    if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) {
                      await el.scrollIntoViewIfNeeded().catch(() => {})
                      await el.click()
                      clicked = true
                      directlyVisible = true
                      log.info(`[WEBAPP-ENGINE] ✅ Clicked "${target}" directly via "${sel}"`)
                      break
                    }
                  } catch { /* try next */ }
                }

                if (!directlyVisible) {
                  // Step 2: Open action/context menu first, then click the destructive action
                  log.info(`[WEBAPP-ENGINE] "${target}" not directly visible — trying action menu triggers`)

                  // Common action menu trigger selectors in CRMs
                  const ACTION_MENU_TRIGGERS = [
                    // Kebab/three-dot menus
                    'button[aria-label*="more" i]',
                    'button[aria-label*="action" i]',
                    'button[aria-label*="option" i]',
                    'button[aria-label*="menu" i]',
                    'button[title*="more" i]',
                    'button[title*="action" i]',
                    '[role="button"][aria-label*="more" i]',
                    // Common icon buttons: ⋮ ⋯ ... ▾ ▼
                    'button:has(svg):not([aria-label*="search" i]):not([aria-label*="filter" i]):not([aria-label*="new" i])',
                    // Text-based triggers
                    'button:has-text("Actions")',
                    'button:has-text("More")',
                    'button:has-text("Options")',
                    '[role="button"]:has-text("Actions")',
                  ]

                  for (const triggerSel of ACTION_MENU_TRIGGERS) {
                    try {
                      const triggers = page.locator(triggerSel)
                      const count = await triggers.count().catch(() => 0)

                      for (let ti = 0; ti < Math.min(count, 5); ti++) {
                        const trigger = triggers.nth(ti)
                        if (!await trigger.isVisible({ timeout: 1_000 }).catch(() => false)) continue

                        // Click the trigger to open the menu
                        await trigger.click()
                        await page.waitForTimeout(500)

                        // Look for the destructive action in the opened menu
                        const menuItem = page.locator(
                          `[role="menu"] *:has-text("${target}"), ` +
                          `[role="menuitem"]:has-text("${target}"), ` +
                          `[role="listbox"] *:has-text("${target}"), ` +
                          `.dropdown-menu *:has-text("${target}"), ` +
                          `ul li:has-text("${target}")`,
                        ).first()

                        if (await menuItem.isVisible({ timeout: 2_000 }).catch(() => false)) {
                          await menuItem.click()
                          clicked = true
                          log.info(`[WEBAPP-ENGINE] ✅ Clicked "${target}" via action menu trigger "${triggerSel}"`)
                          break
                        }

                        // Menu didn't have Delete — close it and try next trigger
                        await page.keyboard.press('Escape').catch(() => {})
                        await page.waitForTimeout(200)
                      }
                      if (clicked) break
                    } catch { /* try next trigger */ }
                  }
                }

                if (!clicked) {
                  // Step 3: Last resort — standard text lookup with reduced timeout
                  log.warn(`[WEBAPP-ENGINE] Action menu strategies failed for "${target}" — falling back to getByText`)
                  const textLoc = page.getByText(target, { exact: false })
                  await textLoc.first().waitFor({ state: 'visible', timeout: 5_000 })
                  await textLoc.first().click()
                  clicked = true
                }

              } else {
                // ── Non-destructive: smart click with navigation-menu fast-path ──
                // Detect if this is a nav section click (e.g., "Users", "Accounts", "Dashboard").
                // Nav-section clicks go DIRECTLY to smartWebAppClick (bypassing getByText which
                // can match an inner <span> inside <li> that is not clickable).
                const NAV_SECTION_FAST_PATH_RE = /^(users|user|accounts|account|contacts|contact|leads|lead|opportunities|opportunity|dashboard|home|settings|setting|reports|report|products|product|orders|order|invoices|invoice|campaigns|campaign|tasks|task|cases|case|projects|project|customers|customer|vendors|vendor|employees|employee|admin|panel|modules|module|team|billing|analytics|calendar|messages|notifications|documents|integrations|permissions|roles|groups|categories|workflows|automation)s?$/i
                const isNavSectionClick = (
                  !target.includes('=') &&
                  !target.startsWith('.') &&
                  !target.startsWith('#') &&
                  !target.startsWith('[') &&
                  NAV_SECTION_FAST_PATH_RE.test(target.trim())
                )
                if (isNavSectionClick) {
                  log.info(`[WEBAPP-ENGINE] Nav-section fast-path: "${target}" → smartWebAppClick directly`)
                }
                clicked = await smartWebAppClick(page, target, log)
              }
            } // end if (!clicked)

            // ── Post-destructive-click: auto-handle confirmation dialog ───
            // Pattern: "Delete" (or Remove/Archive) click opens a modal that asks
            // "Are you sure?" with a confirm button (e.g. "Delete Contact").
            // If the LLM-generated steps don't include the confirmation click,
            // the engine must handle it automatically or the next step fails.
            if (isDestructiveAction && clicked) {
              await page.waitForTimeout(800)
              const confirmDialog = page.locator(
                '[role="dialog"], [aria-modal="true"], .modal, [class*="dialog"], [class*="modal"]'
              ).first()
              const dialogVisible = await confirmDialog.isVisible({ timeout: 2_000 }).catch(() => false)

              if (dialogVisible) {
                log.info(`[WEBAPP-ENGINE] Confirmation dialog detected after destructive action "${target}" — auto-confirming`)

                // Priority order: most specific (entity-specific Delete button) → generic confirm
                const CONFIRM_SELECTORS = [
                  // Entity-specific: "Delete Contact", "Delete Account", "Delete Record"
                  '[role="dialog"] button[class*="danger"]:not([class*="cancel"])',
                  '[role="dialog"] button[class*="destructive"]:not([class*="cancel"])',
                  '[role="dialog"] button[class*="red"]:not([class*="cancel"])',
                  // Text-based: match any button starting with "Delete" (not "Cancel Delete")
                  '[role="dialog"] button',
                  '.modal button',
                  '[aria-modal="true"] button',
                ]

                let confirmed = false
                // Get all buttons inside the dialog and find the confirm one
                const dialogBtns = confirmDialog.locator('button')
                const btnCount = await dialogBtns.count().catch(() => 0)
                for (let bi = 0; bi < btnCount; bi++) {
                  const btn = dialogBtns.nth(bi)
                  if (!await btn.isVisible({ timeout: 500 }).catch(() => false)) continue
                  const btnText = (await btn.textContent().catch(() => '') ?? '').trim()
                  // Skip Cancel/Close/No/Back/Dismiss buttons
                  if (/^(cancel|close|no|back|dismiss|keep)$/i.test(btnText)) continue
                  // Prefer buttons that start with "Delete", "Remove", "Confirm", "Yes", "Proceed"
                  if (/^(delete|remove|archive|confirm|yes|proceed|ok)/i.test(btnText)) {
                    await btn.scrollIntoViewIfNeeded().catch(() => {})
                    await btn.click()
                    confirmed = true
                    log.info(`[WEBAPP-ENGINE] ✅ Clicked confirmation button: "${btnText}"`)
                    await page.waitForTimeout(1_500)
                    break
                  }
                }

                // Fallback: click the last button in the dialog (usually the primary/confirm action)
                if (!confirmed && btnCount > 0) {
                  for (let bi = btnCount - 1; bi >= 0; bi--) {
                    const btn = dialogBtns.nth(bi)
                    if (!await btn.isVisible({ timeout: 500 }).catch(() => false)) continue
                    const btnText = (await btn.textContent().catch(() => '') ?? '').trim()
                    if (/^(cancel|close|no|back|dismiss|keep)$/i.test(btnText)) continue
                    await btn.click()
                    confirmed = true
                    log.info(`[WEBAPP-ENGINE] ✅ Fallback: clicked last dialog button "${btnText}"`)
                    await page.waitForTimeout(1_500)
                    break
                  }
                }

                if (!confirmed) {
                  log.warn(`[WEBAPP-ENGINE] Confirmation dialog found but could not identify confirm button — proceeding`)
                }
              }
            }

            // Web app post-click: brief wait for SPA state update
            await page.waitForTimeout(1_000)
          } else {
            // ── Salesforce click path ──────────────────────────────────────
            // Modal-scoped: find the element inside an open modal first
            const loc = await modalScopedResolve(page, step)
            await loc.waitFor({ state: 'visible', timeout: 15_000 })
            await loc.scrollIntoViewIfNeeded()
            await loc.click({ timeout: 15_000 })
          }

          // ── Post-click intelligence (SF Lightning) ───────────────────
          const targetLower = (target ?? '').toLowerCase()

          // After clicking New/Edit/Clone: wait for modal, scan field map
          if (!isWebAppCategory(projectCategory) && ['new', 'edit', 'create', 'clone', 'quick'].some((kw) => targetLower.includes(kw))) {
            log.info(`[SF-ENGINE] Post-click: waiting for modal after "${target}"`)

            const modalFound = await waitForSFModal(page)
            if (modalFound) {
              // Scan field map — this is the KEY step that enables correct fill routing
              const fieldMap = await scanFieldMap(page)
              if (Object.keys(fieldMap).length > 0) {
                sfFieldMapRegistry.set(executionId, fieldMap)
                log.info(`[SF-ENGINE] Field map stored for execution ${executionId}: ${Object.keys(fieldMap).length} fields`)
              }

              // Wait for spinner to clear
              await waitForSpinnerGone(page)
            } else {
              // Check for full-page record form (not a modal)
              try {
                await page.locator(
                  'records-record-edit-form, lightning-record-edit-form, ' +
                  '.slds-form, force-record-layout-section',
                ).first().waitFor({ state: 'visible', timeout: 10_000 })
                log.info('[SF-ENGINE] Full-page record form detected — scanning field map')
                const fieldMap = await scanFieldMap(page)
                if (Object.keys(fieldMap).length > 0) {
                  sfFieldMapRegistry.set(executionId, fieldMap)
                }
              } catch {
                await page.waitForTimeout(3_000)
              }
            }
          }

          // After clicking Save: check for errors, handle duplicates (SF only)
          if (!isWebAppCategory(projectCategory) && targetLower.includes('save')) {
            await waitForSpinnerGone(page)
            await handleDuplicatePopup(page)
            await page.waitForTimeout(3_000) // VF errors take 3-5s to appear

            const saveError = await detectPostSaveError(page)
            if (saveError) {
              throw new Error(`Save FAILED — Salesforce error: ${saveError.substring(0, 300)}`)
            }

            // Check for success toast
            try {
              const toast = page.locator(
                '.toastMessage, .forceToastMessage, .slds-notify__content, ' +
                'div[data-key="success"], div[data-key="error"]',
              ).first()
              await toast.waitFor({ state: 'visible', timeout: 5_000 })
              log.info('[SF-ENGINE] Toast notification detected after Save')
            } catch { /* no toast — continue */ }
          }

          break
        }

        // ── Fill / Type — Universal SF-aware Dispatcher ────
        // Port of Python salesforce_engine.py fill_field() + step dispatch logic.
        // Uses the 3-layer field type resolution strategy:
        //   1. Step-level sf_field_type (from AI generation)
        //   2. DOM field map (from scanFieldMap after modal opens)
        //   3. MCP metadata map (from DB)
        //   4. Real-time JS DOM probe (last resort)
        case 'type':
        case 'fill':
        case 'input': {
          if (activeFrame) {
            // Inside an iframe — use simple fill (VF page context)
            const frameLoc = activeFrame.locator(target)
            await frameLoc.waitFor({ state: 'visible', timeout: 12_000 })
            await frameLoc.fill(value)
            break
          }

          // ── Web App smart fill path ─────────────────────────────────────
          // Delegates to the webapp-field-handler microservice which probes the
          // DOM type (select, checkbox, date, text) and routes to the correct
          // handler — mirroring what SF-specific code does for Lightning fields.
          if (isWebAppCategory(projectCategory)) {
            await fillWebAppField(page, target, value)
            break
          }

          // ── Salesforce-specific fill/type path ────────────────────────────
          // Resolve the field label from Playwright expressions
          const resolvedFillLabel = extractLabelFromTarget(target)
          log.info(`[SF-ENGINE] fill/type: "${resolvedFillLabel}" = "${value}"`)

          // Correct the label by fuzzy-matching against visible page labels
          const correctedLabel = await correctLabel(page, resolvedFillLabel)
          const fillLabel = correctedLabel !== resolvedFillLabel ? correctedLabel : resolvedFillLabel

          // Scroll modal to bring field into view
          await scrollModalToField(page, fillLabel)

          // ── Resolve field type using 4-layer strategy ────────────────
          const sfFillType = (step as any).sf_field_type as string | undefined
          const resolvedType = await resolveFieldType(page, fillLabel, sfFillType, executionId)
          log.info(`[SF-ENGINE] fill/type: "${fillLabel}" resolved type = "${resolvedType}"`)

          // ── Route to specialized handler based on resolved type ──────
          switch (resolvedType) {
            case 'lookup':
            case 'lookup_advanced':
            case 'reference': {
              log.info(`[SF-ENGINE] Routing "${fillLabel}" → selectSFLookup (type=${resolvedType})`)
              await selectSFLookup(page, fillLabel, value)
              break
            }

            case 'picklist':
            case 'combobox': {
              log.info(`[SF-ENGINE] Routing "${fillLabel}" → selectSFPicklist (type=${resolvedType})`)
              await selectSFPicklist(page, fillLabel, value, executionId)
              break
            }

            case 'multipicklist': {
              log.info(`[SF-ENGINE] Routing "${fillLabel}" → selectSFPicklist multi-select (type=${resolvedType})`)
              // Multi-select: split by semicolons and select each value
              const multiValues = value.split(';').map((v) => v.trim()).filter(Boolean)
              for (const mv of multiValues) {
                await selectSFPicklist(page, fillLabel, mv, executionId)
              }
              break
            }

            case 'date':
            case 'datetime': {
              log.info(`[SF-ENGINE] Routing "${fillLabel}" → fillSFDate (type=${resolvedType})`)
              await fillSFDate(page, fillLabel, value)
              break
            }

            case 'checkbox':
            case 'boolean': {
              log.info(`[SF-ENGINE] Routing "${fillLabel}" → checkbox toggle (type=${resolvedType})`)
              // Try lightning-input-field checkbox / toggle
              const cbSelectors = [
                `lightning-input-field:has-text("${fillLabel}") input[type="checkbox"]`,
                `lightning-input:has-text("${fillLabel}") input[type="checkbox"]`,
                `.slds-form-element:has-text("${fillLabel}") input[type="checkbox"]`,
              ]
              let cbHandled = false
              for (const cbSel of cbSelectors) {
                try {
                  const cbLoc = page.locator(cbSel).first()
                  if (await cbLoc.isVisible({ timeout: 2_000 }).catch(() => false)) {
                    const shouldCheck = ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
                    if (shouldCheck) {
                      await cbLoc.check({ timeout: 5_000 })
                    } else {
                      await cbLoc.uncheck({ timeout: 5_000 })
                    }
                    cbHandled = true
                    log.info(`[SF-ENGINE] Checkbox "${fillLabel}" ${shouldCheck ? 'checked' : 'unchecked'} via ${cbSel}`)
                    break
                  }
                } catch { continue }
              }
              if (!cbHandled) {
                // Fallback: try getByLabel
                try {
                  const cbByLabel = page.getByLabel(fillLabel, { exact: false }).first()
                  if (await cbByLabel.isVisible({ timeout: 2_000 }).catch(() => false)) {
                    const shouldCheck = ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
                    if (shouldCheck) await cbByLabel.check(); else await cbByLabel.uncheck()
                    cbHandled = true
                  }
                } catch { /* try next */ }
              }
              if (!cbHandled) {
                log.warn(`[SF-ENGINE] Checkbox handler failed for "${fillLabel}" — falling through to generic fill`)
                // Fall through to generic text fill below
                const loc = await modalScopedResolve(page, step)
                await loc.waitFor({ state: 'visible', timeout: 15_000 })
                await loc.click()
                await page.keyboard.type(value)
              }
              break
            }

            default: {
              // ── Generic text fill ──────────────────────────────────────
              // Before filling, one final safety check: is the resolved
              // element actually inside a lookup component?
              const loc = await modalScopedResolve(page, step)
              await loc.waitFor({ state: 'visible', timeout: 15_000 })

              // POST-RESOLVE SAFETY NET: check if element is inside a lookup
              const isInsideLookup = await loc.evaluate((el: Element) =>
                !!el.closest('lightning-lookup, c-lookup, records-record-picker, lightning-grouped-combobox[class*="lookup"]'),
              ).catch(() => false)

              if (isInsideLookup) {
                log.info(`[SF-ENGINE] POST-RESOLVE safety net: "${fillLabel}" is inside lookup. Routing to selectSFLookup.`)
                await selectSFLookup(page, fillLabel, value)
                break
              }

              // Check if element is inside a picklist/combobox
              const isInsidePicklist = await loc.evaluate((el: Element) =>
                !!el.closest('lightning-combobox, lightning-picklist'),
              ).catch(() => false)

              if (isInsidePicklist) {
                log.info(`[SF-ENGINE] POST-RESOLVE safety net: "${fillLabel}" is inside picklist. Routing to selectSFPicklist.`)
                await selectSFPicklist(page, fillLabel, value, executionId)
                break
              }

              // Standard text fill with Tab commit (Lightning commit pattern)
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
              // Press Tab to commit the value in Lightning
              await page.keyboard.press('Tab')
              await page.waitForTimeout(500)
              break
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

          // ── Web App early branch ────────────────────────────────────────
          // Web apps use standard <select>, role=combobox, and custom dropdowns.
          // Route to the webapp-field-handler BEFORE any SF-specific logic fires.
          if (isWebAppCategory(projectCategory)) {
            await selectWebAppPicklist(page, resolvedTarget, value)
            break
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

                await cb.scrollIntoViewIfNeeded().catch(() => { })
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
        // Routes through selectLookupValue() which wraps the entire
        // lookup flow with robust Advanced Search fallback and
        // resilient 3-attempt result clicking.
        case 'lookup':
        case 'sflookup': {
          await selectLookupValue(page, target, value)
          break
        }

        // ── SF / Web App Picklist (explicit action) ────────
        case 'picklist':
        case 'sfpicklist': {
          if (isWebAppCategory(projectCategory)) {
            await selectWebAppPicklist(page, target, value)
          } else {
            await selectSFPicklist(page, target, value, executionId)
          }
          break
        }

        // ── SF / Web App Date ──────────────────────────────
        case 'date':
        case 'sfdate':
        case 'setdate': {
          if (isWebAppCategory(projectCategory)) {
            await fillWebAppDateField(page, target, value)
          } else {
            await fillSFDate(page, target, value)
          }
          break
        }

        // ── Web App Checkbox (explicit action) ─────────────
        case 'checkbox':
        case 'check':
        case 'toggle': {
          if (isWebAppCategory(projectCategory)) {
            await fillWebAppCheckbox(page, target, value)
          } else {
            // SF: route through generic fill which detects checkbox type
            const cbSel = page.getByLabel(extractLabelFromTarget(target), { exact: false })
            const shouldCheck = ['true', '1', 'yes', 'on'].includes(value.toLowerCase())
            if (await cbSel.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
              if (shouldCheck) { await cbSel.first().check() } else { await cbSel.first().uncheck() }
            }
          }
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
            const rtNormSpace = rtName.replace(/_+/g, ' ')

            // Strategy 1a: [data-value="Damage"] exact
            // Strategy 1b: [data-value="Damage_Type"] (underscore variant)
            // Strategy 1c: [data-value] case-insensitive via XPath attr match
            for (const dv of [rtName, rtNormUnderscore, rtNormSpace]) {
              const loc = page.locator(`[data-value="${dv}"]`).first()
              if (await loc.isVisible({ timeout: 1_500 }).catch(() => false)) {
                await loc.scrollIntoViewIfNeeded().catch(() => { })
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
                await lbl.scrollIntoViewIfNeeded().catch(() => { })
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
              await inDialog.scrollIntoViewIfNeeded().catch(() => { })
              await inDialog.click()
              log.info(`[SF-RT] ✅ Selected via dialog regex match`)
              await page.waitForTimeout(500)
              return true
            }

            // Strategy 4: page-wide text match (full-page RT selector, not a dialog)
            const pageWide = page.getByText(rtNameRegex).first()
            if (await pageWide.isVisible({ timeout: 1_500 }).catch(() => false)) {
              await pageWide.scrollIntoViewIfNeeded().catch(() => { })
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
          // ── Multi-strategy visibility assertion ─────────────────────────────
          // The target is plain text (e.g. "Administratorv0.1.0") that must be
          // visible somewhere on the page. Version strings with dots must NEVER
          // be passed to page.locator() as-is because '.' is a CSS class token
          // and will throw: "Unexpected token '.' while parsing css selector".
          //
          // Strategy:
          //   1. page.getByText(target, exact:false) — fastest, covers partial text
          //   2. XPath contains() — handles text split across child elements
          //   3. resolveLocator fallback — for properly structured locators
          //
          // Value semantics:
          //   - 'assertvisible': value is ignored — element visibility is the only assertion.
          //   - 'asserttext':    value is always checked as a literal DOM text substring.
          //   - 'assert':        value is checked as a text substring ONLY when it appears to
          //                      be a literal match candidate (not a human-readable description).
          //                      Detection heuristic: skip the contains check when value is
          //                      significantly longer than target (> 2×) OR contains common
          //                      description phrases like "is displayed", "is shown", "is loaded",
          //                      "is visible", "page is", "tab is", "successfully".
          const assertTarget = target

          // Determine whether the value field should be applied as a strict DOM text check.
          // `assertvisible` → never (visibility-only).
          // `asserttext`    → always.
          // `assert`        → only for short, literal-looking values.
          const isDescriptiveValue = (v: string): boolean => {
            if (!v) return false
            const lower = v.toLowerCase()
            // Common AI-generated description patterns that are NOT literal DOM text:
            const descriptionPatterns = [
              'is displayed', 'is shown', 'is loaded', 'is visible', 'is active',
              'tab is', 'page is', 'successfully', 'has been', 'should be',
              'appears', 'loads with', 'shows', 'displays',
            ]
            if (descriptionPatterns.some((p) => lower.includes(p))) return true
            // Value much longer than target is likely a description, not a DOM fragment
            if (assertTarget && v.length > assertTarget.length * 2) return true
            return false
          }

          const shouldCheckValue = (
            action === 'asserttext' ||
            (action !== 'assertvisible' && !!value && !isDescriptiveValue(value))
          )

          // Strategy 1: getByText (safe for any string including dots)
          const byText = page.getByText(assertTarget, { exact: false })
          const byTextCount = await byText.count().catch(() => 0)
          if (byTextCount > 0) {
            const firstVisible = await (async () => {
              for (let i = 0; i < byTextCount; i++) {
                const el = byText.nth(i)
                if (await el.isVisible({ timeout: 2_000 }).catch(() => false)) return el
              }
              return null
            })()
            if (firstVisible) {
              if (shouldCheckValue) {
                const text = await firstVisible.textContent().catch(() => '')
                if (!text?.includes(value)) {
                  throw new Error(`Assertion failed: "${assertTarget}" text "${text}" does not contain "${value}"`)
                }
              }
              log.info(`[ASSERT] ✅ "${assertTarget}" found via getByText`)
              break
            }
          }

          // Strategy 2: XPath contains() — handles text split across nodes
          const xpathLoc = page.locator(`xpath=//*[contains(normalize-space(.), '${assertTarget.replace(/'/g, "'\"'\"'")}')]`).first()
          if (await xpathLoc.isVisible({ timeout: 5_000 }).catch(() => false)) {
            log.info(`[ASSERT] ✅ "${assertTarget}" found via XPath contains()`)
            break
          }

          // Strategy 3: resolveLocator fallback (for structured targets like role=, label=, etc.)
          const loc = await getFirstVisibleLocator(resolveLocator(page, step))
          await loc.waitFor({ state: 'visible', timeout: 10_000 })
          if (shouldCheckValue) {
            const text = await loc.textContent()
            if (!text?.includes(value)) {
              throw new Error(`Assertion failed: "${assertTarget}" text "${text}" does not contain "${value}"`)
            }
          }
          log.info(`[ASSERT] ✅ "${assertTarget}" found via resolveLocator fallback`)
          break
        }

        case 'asserturl': {
          // ASSERT_URL: value = expected URL path fragment (e.g. "/products")
          // Uses STRICT pathname-level matching so /products/new does NOT satisfy /products.
          const urlFragment = value || target
          if (!urlFragment) {
            log.warn(`[EXEC] ASSERT_URL step ${stepIndex + 1} has no value/target — skipping`)
            break
          }

          // ── Helper: normalise any URL string to just its pathname ───────────
          const toPathname = (raw: string): string => {
            try { return new URL(raw).pathname.replace(/\/$/, '') || '/' } catch { return raw }
          }
          // Build the expected pathname even if urlFragment is a bare path like "/products"
          const expectedPathname = toPathname(
            urlFragment.startsWith('http')
              ? urlFragment
              : `http://placeholder${urlFragment.startsWith('/') ? '' : '/'}${urlFragment}`
          )

          // ── Strict URL matcher ───────────────────────────────────────────────
          // Accepts:
          //   /products        === /products          (exact list page)
          //   /products/123    satisfies /products    (detail page redirect)
          // Rejects:
          //   /products/new    does NOT satisfy /products  (still on form!)
          const urlSatisfiesExpected = (url: string): boolean => {
            const currentPath = toPathname(url)
            if (currentPath === expectedPathname) return true
            if (currentPath.startsWith(expectedPathname + '/')) {
              const subPath = currentPath.slice(expectedPathname.length)  // e.g. "/new" or "/123"
              // Reject if the child segment is a creation/edit route
              return !/^\/(new|create|add|edit)(\/$|$)/i.test(subPath)
            }
            return false
          }

          // Wait for the SPA redirect to settle (up to 8 seconds)
          const urlDeadline = Date.now() + 8_000
          let currentUrl = page.url()
          while (!urlSatisfiesExpected(currentUrl) && Date.now() < urlDeadline) {
            await page.waitForTimeout(500)
            currentUrl = page.url()
          }

          if (!urlSatisfiesExpected(currentUrl)) {
            // ── Scan for form validation errors before reporting URL failure ─────
            // If the form stayed open due to a required-field error (e.g. "Currency is
            // required"), surface THAT message rather than a generic URL mismatch.
            const FORM_ERROR_SELECTORS = [
              '[role="alert"]',
              '[aria-live="assertive"]',
              '.alert-danger', '.alert-error', '.alert-destructive',
              '[class*="error-message"]', '[class*="form-error"]', '[class*="field-error"]',
              '[class*="validation-error"]', '[class*="validation-message"]',
              '.invalid-feedback', '.field-validation-error',
              // Tailwind / shadcn red-text patterns
              'p.text-red-500', 'span.text-red-500', 'div.text-red-500',
              '[class*="text-red-"]', '[class*="text-destructive"]',
              // Banner-style error summaries at top of form
              '[class*="error-banner"]', '[class*="form-errors"]',
            ].join(', ')

            const validationErrors: string[] = []
            try {
              const errEls = page.locator(FORM_ERROR_SELECTORS)
              const count  = await errEls.count()
              for (let ei = 0; ei < Math.min(count, 8); ei++) {
                const txt = (await errEls.nth(ei).textContent())?.trim()
                if (txt && txt.length > 1 && txt.length < 400) validationErrors.push(txt)
              }
            } catch { /* non-critical — swallow so the real error is still thrown */ }

            if (validationErrors.length > 0) {
              const unique = [...new Set(validationErrors)]
              throw new Error(
                `Form submission failed — validation error(s) detected on page: ${unique.slice(0, 4).join(' | ')}. ` +
                `The URL is still "${currentUrl}" (expected "${urlFragment}"). ` +
                `Ensure all required fields are filled in the test steps.`
              )
            }

            throw new Error(
              `URL assertion failed: expected path "${expectedPathname}" but got "${currentUrl}". ` +
              `The form may still be open — verify all required fields are filled.`
            )
          }
          log.info(`[EXEC] ASSERT_URL ✅ URL "${currentUrl}" satisfies expected path "${urlFragment}"`)
          break
        }


        // ── Assert Toast (validation rule / flow / trigger / web app snackbar) ─
        case 'asserttoast':
        case 'asserterror':
        case 'assertsuccess': {
          // Combines SF Lightning toast selectors with common web-app toast/snackbar
          // libraries so the same handler works for both Salesforce and Web App projects.
          const toastSelectors = [
            // ── Salesforce Lightning ──────────────────────────────────────────
            '.slds-notify .slds-notify__content',           // Classic/Aura toast
            '[data-key="success"] .toastMessage',           // LWC success toast
            '[data-key="error"] .toastMessage',             // LWC error toast
            '[data-key="warning"] .toastMessage',           // LWC warning toast
            '[data-key="info"] .toastMessage',              // LWC info toast
            '.forceActionsText',                            // force:showToast legacy
            'force-toast .toastMessage',                    // web component variant
            '.toastMessage',                                // catch-all Salesforce
            'lightning-toast .slds-notify__content',        // LWC lightning-toast
            '.slds-notify[role="status"] .slds-notify__content', // Scoped ARIA status

            // ── Common Web App toast/snackbar libraries ────────────────────────
            '[data-sonner-toast]',                          // Sonner (Next.js default)
            '[data-sonner-toast] [data-title]',             // Sonner title
            '[role="status"][aria-live]',                   // Generic ARIA live region
            '[aria-live="polite"]',                         // Polite live region
            '[aria-live="assertive"]',                      // Assertive live region
            '.Toastify__toast-body',                        // react-toastify
            '.react-hot-toast',                             // react-hot-toast
            '.chakra-toast__inner',                         // Chakra UI
            '.MuiSnackbarContent-message',                  // MUI Snackbar
            '.mantine-Notification-description',            // Mantine
            '.alert.alert-success',                         // Bootstrap success alert
            '.alert.alert-danger',                          // Bootstrap error alert
            '.notification-message',                        // Generic notification
            '[class*="toast"][class*="message"]',           // Broad toast message
            '[class*="snackbar"]',                          // Generic snackbar
            '[class*="notification"]',                      // Generic notification
          ]
          const toastLoc = page.locator(toastSelectors.join(', ')).first()

          let toastText: string | null = null
          try {
            await toastLoc.waitFor({ state: 'visible', timeout: 12_000 })
            toastText = await toastLoc.textContent()
          } catch {
            // Toast may have already auto-dismissed or the app uses URL redirect instead of toast.
            const pageText = await page.title().catch(() => '')
            const url = page.url()
            if (value) {
              const lv = value.toLowerCase()
              // SF: definitive record view URLs: /lightning/r/{ObjectId}/view
              const isRecordViewUrl = /\/lightning\/r\/[a-zA-Z0-9]+\/view/i.test(url)
              // Web App: URL changed away from /create, /new, /add paths (redirect after save)
              const wasCreatePage = /\/(create|new|add)(\/|$|\?)/i.test(url)
              const urlChangedFromCreate = !wasCreatePage && !/\/(create|new|add)(\/|$|\?)/i.test(url)
              if (pageText.toLowerCase().includes(lv) || isRecordViewUrl || urlChangedFromCreate) {
                log.info(`[EXEC] Toast auto-dismissed but page confirms save: title="${pageText}" url="${url}"`)
                break
              }
            } else {
              // No expected value — just check if we navigated somewhere meaningful
              const isOnCreatePage = /\/(create|new|add)(\/|$|\?)/i.test(url)
              if (!isOnCreatePage) {
                log.info(`[EXEC] Toast not found but URL indicates redirect to: "${url}" — treating as pass`)
                break
              }
            }
            throw new Error(`Toast/notification not found after 12s and no page-state fallback matched. Current URL: ${url}`)
          }

          if (value) {
            if (!toastText || !toastText.trim()) {
              throw new Error(`Toast assertion failed: toast element found but had no text content. Expected to contain "${value}"`)
            }
            if (!toastText.toLowerCase().includes(value.toLowerCase())) {
              throw new Error(`Toast assertion failed: got "${toastText.trim()}", expected to contain "${value}"`)
            }
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

        // ── Scroll ──────────────────────────────────────────────────
        case 'scroll': {
          if (target) {
            await (await getFirstVisibleLocator(resolveLocator(page, step))).scrollIntoViewIfNeeded()
          } else {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
          }
          break
        }

        // ── Explicit screenshot ───────────────────────────────────────
        case 'screenshot': {
          const ssFile = `step-${stepIndex}-explicit-${Date.now()}.png`
          const ssPath = path.join(screenshotsDir, ssFile)
          await page.screenshot({ path: ssPath, fullPage: false })
          screenshotPath = `/screenshots/${executionId}/${ssFile}`
          break
        }

        // ── Clear cookies ──────────────────────────────────────────────
        case 'clearcookies': {
          await page.context().clearCookies()
          break
        }

        // ── Unknown action ──────────────────────────────────────────────
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
        const ssFile = `step-${stepIndex + 1}-FINAL-${Date.now()}.png`
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
        await dismissStaleOverlays(page).catch(() => { })
        await page.waitForTimeout(2_000)
        // Continue to attempt 2
        continue
      }

      // All attempts exhausted — capture failure screenshot and return failed result
      const errMsg = lastStepError.message
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
  page: Page,
  browserCtx: BrowserContext,
  projectId: string,
): Promise<void> {
  log.info(`[EXEC-SF] Getting JSForce connection for project ${projectId}...`)
  try {
    const conn = await getConnection(projectId)

    if (!conn.accessToken || !conn.instanceUrl) {
      throw new Error('JSForce connection missing accessToken or instanceUrl')
    }

    log.info('[EXEC-SF] Attempting silent login via frontdoor.jsp (attempt 1)')

    const instanceUrl = conn.instanceUrl.startsWith('http')
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
    const freshUrl = `${freshConn.instanceUrl}/secur/frontdoor.jsp?sid=${freshConn.accessToken}`

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
  page: Page,
  browserCtx: BrowserContext,
  context: ExecutionJob['context'],
  projectId: string,
): Promise<void> {
  if (!context.webLoginUrl || !context.webUsername || !context.webPassword) {
    log.info('[EXEC-WEB] No web credentials configured — skipping login')
    return
  }

  const strategy = context.webLoginStrategy ?? 'form'
  log.info(`[EXEC-WEB] Logging in via strategy="${strategy}" to ${context.webLoginUrl}`)

  if (strategy === 'basic_auth') {
    const url = new URL(context.webLoginUrl)
    url.username = context.webUsername
    url.password = context.webPassword
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForTimeout(2_000)
    await saveSession(projectId, browserCtx)
    log.info('[EXEC-WEB] ✅ Basic auth login complete')
    return
  }

  // ── Form-based login ────────────────────────────────────────────────────────
  await page.goto(context.webLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // Give SPAs (React/Vue/Angular) extra time to mount the login form in the DOM
  await page.waitForTimeout(3_000)

  // ── Already logged in guard ─────────────────────────────────────────────
  // If the login URL redirected to the home/dashboard (valid session), there
  // will be NO password field. Check this FIRST before filling any input —
  // otherwise the generic 'input[type="text"]' fallback fills the global
  // search bar with the email address.
  const alreadyLoggedIn = !(await page.locator('input[type="password"]').first().isVisible({ timeout: 3_000 }).catch(() => false))
  if (alreadyLoggedIn) {
    log.info('[EXEC-WEB] ✅ Already authenticated (no password field) — skipping login')
    return
  }

  // Broad locator covering all common login field patterns.
  // input[type="text"] is the last fallback — catches generic CRM/SaaS text inputs
  // that don’t declare type="email" or a recognised name/id attribute.
  const usernameSelectors = [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="user"]',
    'input[name="login"]',
    'input[id="email"]',
    'input[id="username"]',
    'input[id="user"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="username" i]',
    'input[placeholder*="user" i]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    // Generic text input — last resort, picks the first visible text field on the page
    'input[type="text"]',
  ]
  const passwordSelectors = [
    'input[type="password"]',
  ]

  const usernameInput = page.locator(usernameSelectors.join(', ')).first()
  const passwordInput = page.locator(passwordSelectors.join(', ')).first()

  const formFound = await usernameInput.isVisible({ timeout: 10_000 }).catch(() => false)
  if (!formFound) {
    // Non-fatal: stored session cookies may still be valid from a previous run.
    // The test steps will fail with a meaningful error at the right step if login is truly required.
    log.warn(
      `[EXEC-WEB] ⚠️  Login form not detected at ${context.webLoginUrl} after 10s. ` +
      'Continuing with stored session (if any). ' +
      'If tests fail, verify the Login URL in Integration → Session & Login settings.'
    )
    return
  }

  await usernameInput.fill(context.webUsername)
  log.info('[EXEC-WEB] Filled username/email')

  const pwdVisible = await passwordInput.isVisible({ timeout: 5_000 }).catch(() => false)
  if (!pwdVisible) {
    // Some apps render password field after username submit (e.g. Google-style)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1_500)
  }

  const pwdFound = await passwordInput.isVisible({ timeout: 8_000 }).catch(() => false)
  if (pwdFound) {
    await passwordInput.fill(context.webPassword)
    log.info('[EXEC-WEB] Filled password')
  } else {
    log.warn('[EXEC-WEB] ⚠️  Password field not visible after 8s — skipping password fill')
  }

  // Submit — prefer explicit submit button, fall back to Enter
  const submitBtn = page.locator(
    'button[type="submit"], input[type="submit"], ' +
    'button:has-text("Sign in"), button:has-text("Log in"), ' +
    'button:has-text("Login"), button:has-text("Sign In"), ' +
    'button:has-text("Continue"), button:has-text("Next")'
  ).first()
  const submitVisible = await submitBtn.isVisible({ timeout: 3_000 }).catch(() => false)
  if (submitVisible) {
    await submitBtn.click()
  } else {
    await page.keyboard.press('Enter')
  }

  // Wait for navigation (post-login redirect)
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => { })
  await page.waitForTimeout(2_000)

  // Verify we actually left the login page
  const currentUrl = page.url()
  const loginHostname = (() => { try { return new URL(context.webLoginUrl).hostname } catch { return '' } })()
  const isStillOnLoginPage = currentUrl === context.webLoginUrl ||
    (currentUrl.includes('/login') && loginHostname !== '' && currentUrl.includes(loginHostname))
  if (isStillOnLoginPage) {
    log.warn(`[EXEC-WEB] ⚠️  Still on login URL after submit: ${currentUrl}. Credentials may be invalid.`)
  } else {
    log.info(`[EXEC-WEB] ✅ Form login succeeded → ${currentUrl}`)
  }

  await saveSession(projectId, browserCtx)
}

// ─── Keycloak / OAuth Custom Token Login ───────────────────────────────────

/**
 * Keycloak / OAuth Custom Token authentication.
 *
 * This function handles apps that use Keycloak as their Identity Provider
 * and issue a custom HMAC-signed token (not a standard JWT) after SSO login.
 *
 * Auth flow:
 *  1. Token expiry check — if the stored token is expired or < 2 min away,
 *     attempt a silent refresh via keycloakRefreshUrl (if configured).
 *  2. Both tokens are injected into every browser page via addInitScript():
 *       sessionStorage["auth_token"] = keycloakAuthToken  (Bearer token for API calls)
 *       sessionStorage["id_token"]   = keycloakIdToken    (Keycloak id token for logout)
 *  3. The current page is reloaded so the app initialises with the injected session.
 *  4. A Playwright storageState snapshot is saved for session reuse.
 *
 * Token storage: DS Logistics App (and similar Keycloak apps) read their
 * tokens from sessionStorage, not from cookies.  addInitScript() runs
 * the injection script before EVERY subsequent page.goto() so the tokens
 * are always present — even after SPAs perform client-side navigation.
 */
async function loginWithKeycloak(
  page: Page,
  browserCtx: BrowserContext,
  context: ExecutionJob['context'],
  projectId: string,
): Promise<void> {
  const {
    keycloakAuthToken,
    keycloakIdToken,
    keycloakRefreshUrl,
    keycloakTokenExpiresAt,
    webLoginUrl,
  } = context

  if (!keycloakAuthToken) {
    log.warn('[KEYCLOAK] No auth_token configured — skipping Keycloak session injection')
    return
  }

  // ── Token expiry guard ─────────────────────────────────────────────────
  let activeAuthToken = keycloakAuthToken
  let activeIdToken = keycloakIdToken

  const now = Date.now()
  const expiresAt = keycloakTokenExpiresAt ?? now
  const msRemaining = expiresAt - now

  if (msRemaining < 2 * 60 * 1000) {
    // Token is expired or expiring in < 2 minutes — attempt silent refresh
    if (keycloakRefreshUrl) {
      log.info(`[KEYCLOAK] Token near/past expiry — attempting refresh via ${keycloakRefreshUrl}`)
      try {
        const refreshResp = await fetch(keycloakRefreshUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${activeAuthToken}`,
          },
          body: JSON.stringify({ id_token: activeIdToken }),
        })
        if (refreshResp.ok) {
          const data = await refreshResp.json() as Record<string, string>
          const newAuthToken = data.auth_token ?? data.token ?? data.access_token
          const newIdToken = data.id_token ?? data.idToken
          if (newAuthToken) {
            activeAuthToken = newAuthToken
            if (newIdToken) activeIdToken = newIdToken
            log.info('[KEYCLOAK] ✅ Token refreshed successfully')
          } else {
            log.warn('[KEYCLOAK] ⚠️ Refresh response did not contain a new token — proceeding with stored token')
          }
        } else {
          log.warn(
            { status: refreshResp.status },
            '[KEYCLOAK] ⚠️ Token refresh request failed — proceeding with stored (possibly expired) token',
          )
        }
      } catch (refreshErr) {
        log.warn({ refreshErr }, '[KEYCLOAK] Token refresh error (non-fatal) — continuing with stored token')
      }
    } else {
      log.warn(
        { msRemaining },
        '[KEYCLOAK] ⚠️ Token near/past expiry and no refresh URL configured — test may fail on auth checks. ' +
        'Configure keycloak_refresh_url in project integration settings or re-save fresh tokens.',
      )
    }
  } else {
    log.info(
      { expiresIn: Math.round(msRemaining / 60_000) + 'm' },
      '[KEYCLOAK] Token is valid — injecting into browser context',
    )
  }

  // ── Inject tokens via addInitScript (runs before every page load) ────────
  //
  // addInitScript() is the correct approach for sessionStorage because:
  //  a) sessionStorage is per-tab, not shared across contexts like cookies.
  //  b) It runs before the page's own JS, ensuring the tokens are available
  //     the instant the app script checks sessionStorage on load.
  //  c) It persists across client-side navigations (SPA routing) within
  //     the same tab without needing an extra evaluate() after each goto().
  const authTokenVal = activeAuthToken
  const idTokenVal = activeIdToken ?? ''

  await browserCtx.addInitScript(
    ({ authToken, idToken }: { authToken: string; idToken: string }) => {
      // Inject into sessionStorage on every page load.
      // This runs in the browser context — window / sessionStorage are available.
      try {
        sessionStorage.setItem('auth_token', authToken)
        if (idToken) sessionStorage.setItem('id_token', idToken)
      } catch {
        // sessionStorage may be blocked in sandboxed iframes — safe to ignore
      }
    },
    { authToken: authTokenVal, idToken: idTokenVal },
  )
  log.info('[KEYCLOAK] 🔑 addInitScript registered — sessionStorage[auth_token] and [id_token] will be set on every page load')

  // ── Navigate to base URL so the app initialises with the injected session ───
  const targetUrl = webLoginUrl ?? context.baseUrl
  if (targetUrl) {
    log.info(`[KEYCLOAK] Navigating to ${targetUrl} to initialise authenticated session`)
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForTimeout(2_000)

      // Verify session storage was injected on this page
      const injectedToken = await page.evaluate(() => sessionStorage.getItem('auth_token')).catch(() => null)
      if (injectedToken) {
        log.info('[KEYCLOAK] ✅ sessionStorage[auth_token] confirmed on page')
      } else {
        // This can happen on pages that clear sessionStorage on load — log and continue
        log.warn('[KEYCLOAK] ⚠️ sessionStorage[auth_token] not detected after navigation — app may clear storage on load')
        // Fallback: inject directly on current page
        await page.evaluate(
          ({ authToken, idToken }: { authToken: string; idToken: string }) => {
            try {
              sessionStorage.setItem('auth_token', authToken)
              if (idToken) sessionStorage.setItem('id_token', idToken)
            } catch { /* blocked */ }
          },
          { authToken: authTokenVal, idToken: idTokenVal },
        )
        log.info('[KEYCLOAK] Direct sessionStorage injection applied as fallback')
      }
    } catch (navErr) {
      log.warn({ navErr }, '[KEYCLOAK] Navigation to target URL failed (non-fatal) — tokens still registered for subsequent navigations')
    }
  }

  // Save a Playwright storageState snapshot for session reuse
  await saveSession(projectId, browserCtx)
  log.info('[KEYCLOAK] ✅ Keycloak session injected and saved')
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
  aiFailureType?: string,
  aiFailureReason?: string,
): Promise<void> {
  try {
    await page.evaluate(
      ({ stepNum, stepAction, stepTarget, stepValue, errorMsg, timeoutMs, aiFailureType, aiFailureReason }: {
        stepNum: number; stepAction: string; stepTarget: string;
        stepValue: string; errorMsg: string; timeoutMs: number;
        aiFailureType?: string; aiFailureReason?: string
      }) => {
        // Remove any existing overlay
        document.getElementById('autotest-pause-overlay')?.remove()
        // Clear stale signals
        document.body.removeAttribute('data-autotest-hitl-action')
        try { sessionStorage.removeItem('autotest-hitl-action') } catch { }

        const TIMEOUT_SECS = Math.floor(timeoutMs / 1000)
        const overlay = document.createElement('div')
        overlay.id = 'autotest-pause-overlay'
        overlay.style.cssText = 'position:fixed;top:auto;bottom:24px;right:24px;left:auto;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:auto'

        const tgt = stepTarget ? stepTarget.replace(/</g, '&lt;') : stepAction
        const val = stepValue ? stepValue.replace(/</g, '&lt;') : ''
        const errTxt = (errorMsg || 'Failed \u2014 please complete this step manually.').replace(/</g, '&lt;')

        // ── Overlay HTML ────────────────────────────────────────────────
        // Resume/Skip/Stop are <a> tags targeting a hidden <iframe>.
        // Clicking a native link is pure HTML — no JS event handlers needed.
        // Playwright's page.route() intercepts the iframe request at CDP level.
        // AI Diagnosis card (shown only when agent classified the failure)
        // INVALID_FIELD gets a distinct orange/red warning card; other failures get the standard blue card
        let aiCard = ''
        if (aiFailureType === 'INVALID_FIELD') {
          aiCard = `<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.4);border-radius:10px;padding:10px 12px;margin-bottom:16px;display:flex;gap:8px;align-items:flex-start">
              <span style="font-size:16px;flex-shrink:0">⚠️</span>
              <div style="flex:1;min-width:0">
                <div style="color:#fbbf24;font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">AI Diagnosis</div>
                <div style="color:#fef3c7;font-size:12px;font-weight:600;margin-bottom:2px">INVALID FIELD FOR ENTITY</div>
                <div style="color:#fde68a;font-size:11px;line-height:1.4;margin-bottom:4px">The field "${(stepTarget || '').replace(/</g, '&lt;')}" does not exist on this form.</div>
                <div style="color:#d97706;font-size:10px;line-height:1.4">This step was incorrectly generated by AI and should be removed from the test case.</div>
                ${aiFailureReason ? `<div style="color:#94a3b8;font-size:10px;line-height:1.4;margin-top:4px">${aiFailureReason.replace(/</g, '&lt;').slice(0, 180)}</div>` : ''}
              </div>
            </div>`
        } else if (aiFailureType) {
          aiCard = `<div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:10px;padding:10px 12px;margin-bottom:16px;display:flex;gap:8px;align-items:flex-start">
              <span style="font-size:16px;flex-shrink:0">🤖</span>
              <div style="flex:1;min-width:0">
                <div style="color:#a5b4fc;font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px">AI Diagnosis</div>
                <div style="color:#e0e7ff;font-size:12px;font-weight:600;margin-bottom:2px">${aiFailureType.replace(/_/g, ' ')}</div>
                ${aiFailureReason ? `<div style="color:#94a3b8;font-size:11px;line-height:1.4">${aiFailureReason.replace(/</g, '&lt;').slice(0, 120)}</div>` : ''}
              </div>
            </div>`
        }

        overlay.innerHTML = `<div id="autotest-pause-card" style="background:linear-gradient(135deg,#1a1f2e 0%,#232941 100%);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:28px 32px;width:420px;box-shadow:0 32px 80px rgba(0,0,0,0.6);position:relative;pointer-events:auto">
          <style>@keyframes at-slide{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}} #autotest-pause-card{animation:at-slide .3s ease both} #autotest-pause-card a.at-btn:hover{filter:brightness(1.15)} #autotest-pause-card a.at-btn:active{transform:scale(.97);opacity:.8} #autotest-drag-handle:hover{background:rgba(255,255,255,0.06);border-radius:8px}</style>
          <div id="autotest-drag-handle" style="display:flex;align-items:center;gap:10px;margin-bottom:16px;cursor:grab;user-select:none;-webkit-user-select:none;padding:4px 0;touch-action:none" title="Drag to move">
            <div style="width:40px;height:40px;border-radius:10px;background:linear-gradient(135deg,#f59e0b,#fbbf24);display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;pointer-events:none">\u23F8</div>
            <div style="flex:1;pointer-events:none">
              <div style="color:#fff;font-size:16px;font-weight:700">Test Paused</div>
              <div style="color:#94a3b8;font-size:11px">AutoTest AI \u2022 Human-in-the-Loop</div>
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;padding:4px;opacity:0.4;flex-shrink:0;pointer-events:none" title="Drag to move">
              <div style="display:flex;gap:3px"><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div></div>
              <div style="display:flex;gap:3px"><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div></div>
              <div style="display:flex;gap:3px"><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div><div style="width:4px;height:4px;background:#94a3b8;border-radius:50%"></div></div>
            </div>
          </div>
          <div style="height:1px;background:rgba(255,255,255,0.08);margin-bottom:16px"></div>
          ${aiCard}
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
          <input type="checkbox" id="autotest-stop-chk" style="display:none;position:absolute" aria-hidden="true">
          <div style="display:flex;gap:10px;margin-bottom:10px">
            <a id="autotest-resume-btn" class="at-btn" href="/autotest-hitl-signal?action=resume" target="autotest-hitl-frame" style="flex:1;padding:12px 0;border-radius:10px;border:none;cursor:pointer;background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;font-size:14px;font-weight:700;box-shadow:0 4px 12px rgba(34,197,94,.3);transition:filter .15s,transform .15s;pointer-events:auto;text-decoration:none;text-align:center;display:block;user-select:none;-webkit-user-select:none;line-height:1.2">\u25B6 Resume</a>
            <a id="autotest-skip-btn" class="at-btn" href="/autotest-hitl-signal?action=skip" target="autotest-hitl-frame" style="flex:1;padding:12px 0;border-radius:10px;cursor:pointer;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:#cbd5e1;font-size:14px;font-weight:600;transition:filter .15s,transform .15s;pointer-events:auto;text-decoration:none;text-align:center;display:block;user-select:none;-webkit-user-select:none;line-height:1.2">\u23ED Skip Step</a>
          </div>
          <a id="autotest-stop-btn" class="at-btn" href="/autotest-hitl-signal?action=stop" target="autotest-hitl-frame" style="display:block;width:100%;padding:10px 0;border-radius:10px;cursor:pointer;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:#fca5a5;font-size:13px;font-weight:700;transition:filter .15s,transform .15s;pointer-events:auto;text-decoration:none;text-align:center;user-select:none;-webkit-user-select:none;line-height:1.2;box-sizing:border-box">\u23F9 Stop Testing</a>
          <div style="margin-top:12px;text-align:center">
            <span style="color:#475569;font-size:11px">Auto-timeout in </span><span id="autotest-timer" style="color:#64748b;font-size:11px;font-weight:600">${Math.floor(TIMEOUT_SECS / 60)}:${String(TIMEOUT_SECS % 60).padStart(2, '0')}</span>
          </div>
        </div>`

        document.body.appendChild(overlay)

        // ── Drag-to-move logic (Pointer Capture API) ─────────────────────────
        // Uses setPointerCapture so ALL pointer events route directly to the
        // drag handle element — no document-level listeners needed.
        // Immune to Salesforce LWS which blocks document.addEventListener.
        try {
          const dh = document.getElementById('autotest-drag-handle')
          if (dh) {
            let _dragging = false
            let _pid = -1
            let _sx = 0, _sy = 0, _sl = 0, _st = 0

            dh.addEventListener('pointerdown', (e: PointerEvent) => {
              if (e.button !== 0) return
              // Convert bottom/right anchoring to top/left on first drag
              if (overlay.style.bottom !== 'auto') {
                const r = overlay.getBoundingClientRect()
                overlay.style.bottom = 'auto'
                overlay.style.right = 'auto'
                overlay.style.left = r.left + 'px'
                overlay.style.top = r.top + 'px'
              }
              dh.setPointerCapture(e.pointerId)
              _dragging = true
              _pid = e.pointerId
              _sx = e.clientX
              _sy = e.clientY
              _sl = parseInt(overlay.style.left || '0', 10)
              _st = parseInt(overlay.style.top || '0', 10)
              dh.style.cursor = 'grabbing'
              e.preventDefault()
              e.stopPropagation()
            })

            dh.addEventListener('pointermove', (e: PointerEvent) => {
              if (!_dragging || e.pointerId !== _pid) return
              const dx = e.clientX - _sx
              const dy = e.clientY - _sy
              const mxL = window.innerWidth - overlay.offsetWidth - 4
              const mxT = window.innerHeight - overlay.offsetHeight - 4
              overlay.style.left = Math.max(4, Math.min(_sl + dx, mxL)) + 'px'
              overlay.style.top = Math.max(4, Math.min(_st + dy, mxT)) + 'px'
            })

            dh.addEventListener('pointerup', (e: PointerEvent) => {
              if (!_dragging || e.pointerId !== _pid) return
              _dragging = false
              try { dh.releasePointerCapture(e.pointerId) } catch (_) { }
              dh.style.cursor = 'grab'
            })

            dh.addEventListener('lostpointercapture', () => {
              _dragging = false
              dh.style.cursor = 'grab'
            })
          }
        } catch (_dragErr) { /* drag setup non-fatal */ }

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
          const chkId = action === 'resume' ? 'autotest-resume-chk' : action === 'skip' ? 'autotest-skip-chk' : 'autotest-stop-chk'
          const chk = document.getElementById(chkId) as HTMLInputElement | null
          if (chk) chk.checked = true
          // exposeFunction channel
          try { if (typeof (window as any).__autotestHitlSignal === 'function') { (window as any).__autotestHitlSignal(action) } } catch { }
          // DOM attribute
          document.body.setAttribute('data-autotest-hitl-action', action)
          // sessionStorage
          try { sessionStorage.setItem('autotest-hitl-action', action) } catch { }
        }

        // Attach JS event handlers as ADDITIONAL channels (may fail in LWS — non-fatal)
        try {
          const resumeBtn = overlay.querySelector('#autotest-resume-btn')
          const skipBtn = overlay.querySelector('#autotest-skip-btn')
          const stopBtn = overlay.querySelector('#autotest-stop-btn')
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
          if (stopBtn) {
            stopBtn.addEventListener('click', (e) => {
              e.stopPropagation(); e.stopImmediatePropagation()
              handleAction('stop', 'autotest-stop-btn')
            }, { capture: true })
          }
        } catch { /* LWS may block addEventListener — the <a>+iframe channel handles it */ }
      },
      { stepNum, stepAction, stepTarget, stepValue, errorMsg, timeoutMs, aiFailureType, aiFailureReason },
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

async function injectAiRecoveryBanner(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      let banner = document.getElementById('autotest-ai-recovery-banner')
      if (banner) return
      banner = document.createElement('div')
      banner.id = 'autotest-ai-recovery-banner'
      banner.style.cssText = 'position:fixed;top:50%;right:24px;transform:translateY(-50%);z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;pointer-events:none'
      banner.innerHTML = `<div style="background:linear-gradient(135deg,#4f46e5 0%,#7c3aed 100%);color:#fff;padding:12px 16px;border-radius:8px;box-shadow:0 10px 25px -5px rgba(0,0,0,0.3);font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px"><span>🤖</span> AI Recovery Mode Active</div>`
      document.body.appendChild(banner)
    })
  } catch { /* non-fatal */ }
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

  let browser: Browser | null = null
  let browserContext: BrowserContext | null = null
  let page: Page | null = null

  // ── Browser-closed-by-user flag ───────────────────────────────────────────
  // When the user closes the testing browser window manually, Playwright fires
  // the 'close' event on the Page. We capture this and check it at the start
  // of each step so the execution loop exits cleanly instead of re-opening.
  let userClosedBrowser = false

  const stepResults: ExecutionStepResult[] = []
  let finalStatus: 'PASSED' | 'FAILED' | 'ERROR' = 'PASSED'
  let errorMessage: string | null = null

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

    const traceFile = path.join(TRACES_DIR, `${executionId}.zip`)
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
          storageState: getSessionPath(projectId),
          viewport: { width: 1280, height: 800 },
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

    // ── Wire up browser/page close detection ─────────────────────────────
    // If user closes the testing browser window, set userClosedBrowser = true.
    // The step loop checks this flag before each step and exits immediately.
    if (isInteractive && page) {
      page.on('close', () => {
        log.warn(`[EXEC] ⚠️  Testing browser window CLOSED by user — aborting execution ${executionId}`)
        userClosedBrowser = true
      })
    }
    if (isInteractive && browserContext) {
      browserContext.on('page', (newPage) => {
        if (userClosedBrowser) return  // already flagged
        newPage.on('close', () => {
          const allPages = browserContext?.pages() ?? []
          if (allPages.length === 0) {
            log.warn(`[EXEC] ⚠️  All browser pages closed — aborting execution ${executionId}`)
            userClosedBrowser = true
          }
        })
      })
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

      } else if (isWebAppCategory(context.projectCategory) && context.webLoginStrategy !== 'none') {
        // Route to the correct web app authentication strategy.
        if (context.webLoginStrategy === 'keycloak') {
          // ── Keycloak / OAuth Custom Token ─────────────────────────────────
          // Injects auth_token and id_token into sessionStorage via addInitScript().
          // No form filling — the stored tokens act as the browser session.
          log.info(`[SESSION] Running Keycloak token injection (hasStoredSession=${hasSession})`)
          try {
            await loginWithKeycloak(page!, browserContext!, context, projectId)
          } catch (loginErr) {
            log.error({ loginErr }, '[SESSION] Keycloak session injection failed — test cannot proceed')
            throw loginErr
          }
        } else {
          // Always run loginToWebApp — mirrors Salesforce's always-authenticate approach.
          // The stored session (loaded above) pre-populates cookies, but we always
          // re-authenticate to ensure validity — stale cookies silently block test steps.
          log.info(`[SESSION] Running web app form login (hasStoredSession=${hasSession})`)
          try {
            await loginToWebApp(page!, browserContext!, context, projectId)
          } catch (loginErr) {
            log.error({ loginErr }, '[SESSION] Web app login failed — test cannot proceed')
            throw loginErr
          }
        }
      }
    }

    // ── Step execution phase ──────────────────────────────────────
    let firstFailedLocator: string | null = null
    let failedScreenshotBase64: string | null = null
    let failedHtmlSnippet: string | null = null

    // ── SF Lightning Engine: Load metadata + install watchers ────
    if (context.projectCategory === 'salesforce' && projectId) {
      // Load MCP field metadata from metadata_normalized table
      try {
        const metaMap = await loadFieldMetadata(projectId)
        if (Object.keys(metaMap).length > 0) {
          sfMetadataMapRegistry.set(executionId, metaMap)
        }
      } catch (metaErr) {
        log.warn({ metaErr }, '[SF-ENGINE] Failed to load field metadata (non-fatal)')
      }

      // Install persistent error modal auto-dismisser
      if (page) {
        await installErrorModalWatcher(page).catch(() => { /* non-fatal */ })
      }
    }

    // ── HITL: Mutable resolve reference for signal channels ────
    let hitlSettleFn: ((action: 'resume' | 'skip' | 'stop') => void) | null = null
    let hitlRouteRegistered = false
    let hitlFnExposed = false

    for (let i = 0; i < context.steps.length; i++) {
      // ── Check if user closed the testing window ──────────────────────
      if (userClosedBrowser) {
        log.warn(`[EXEC] Browser closed by user — stopping at step ${i + 1}/${context.steps.length}`)
        finalStatus = 'FAILED'
        errorMessage = 'Test aborted: user closed the testing browser window'
        stepResults.push({
          step: i + 1,
          action: 'SYSTEM',
          target: null,
          value: null,
          status: 'failed',
          message: 'Testing browser window was closed by user',
          duration_ms: 0,
          screenshot_path: null,
          error: 'Browser closed by user',
        })
        break
      }

      const step = context.steps[i]
      const isLastStep = i === context.steps.length - 1
      const result = await executeStep(
        page!, step, i, isLastStep, execScreenDir, executionId,
        browserContext ?? undefined,
        projectId,
        context.projectCategory,
        context,
      )
      stepResults.push(result)

      log.info(
        `[EXEC] Step ${i + 1}/${context.steps.length}: ${result.status}` +
        ` — ${step.action} "${step.target ?? ''}"`,
      )

      if (result.status === 'failed') {
        // ── Execution Agent: 1 autonomous recovery attempt before HITL ───────
        // Shows a live "AI Recovery" banner in the browser, then attempts one
        // recovery strategy. If it fails or CALL_HITL fires, we immediately
        // surface the HITL overlay — no prolonged retry loops.
        let agentRecovered = false
        let agentFailureType: string | undefined
        let agentFailureReason: string | undefined

        if (isInteractive && page) {
          // ── Show recovery-in-progress banner ─────────────────────────────
          const stepValue = (step.value ?? '').trim()
          const isLikelyBadData = !stepValue || stepValue.length < 2 || /^[-\u2013\u2014.?!_*#@~`\/\\]+$/.test(stepValue)
          const bannerTitle = isLikelyBadData ? 'AI Recovery — Fixing Invalid Data…' : 'AI Recovery in Progress…'
          const bannerSubtext = isLikelyBadData
            ? `Step ${i + 1}: invalid value "${stepValue || '(empty)'}" — generating realistic data`
            : `Step ${i + 1} failed — attempting autonomous fix`
          await page.evaluate(({ stepNum, errMsg, title, subtext }: { stepNum: number; errMsg: string; title: string; subtext: string }) => {
            document.getElementById('autotest-recovery-banner')?.remove()
            const banner = document.createElement('div')
            banner.id = 'autotest-recovery-banner'
            banner.style.cssText = 'position:fixed;top:50%;right:24px;transform:translateY(-50%);z-index:2147483646;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;pointer-events:none'
            banner.innerHTML = `<div style="background:linear-gradient(135deg,#1a1f2e,#232941);border:1px solid rgba(99,102,241,0.4);border-radius:16px;padding:16px 20px;width:360px;box-shadow:0 16px 48px rgba(0,0,0,0.5);display:flex;gap:12px;align-items:flex-start">
              <div style="width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#6366f1,#818cf8);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">🤖</div>
              <div style="flex:1;min-width:0">
                <div style="color:#fff;font-size:13px;font-weight:700;margin-bottom:4px">${title}</div>
                <div style="color:#94a3b8;font-size:11px;margin-bottom:8px">${subtext}</div>
                <div style="background:rgba(99,102,241,0.12);border-radius:8px;padding:8px 10px;color:#a5b4fc;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${errMsg}</div>
              </div>
            </div>`
            document.body.appendChild(banner)
          }, {
            stepNum: i + 1,
            errMsg: (result.error ?? result.message ?? 'Step failed').slice(0, 80),
            title: bannerTitle,
            subtext: bannerSubtext,
          }).catch(() => {})

          try {
            const pageHtml = await page.evaluate(() =>
              document.body ? document.body.innerHTML.slice(0, 3000) : ''
            ).catch(() => '')
            const screenshotB64 = await page.screenshot({ type: 'png' })
              .then(b => b.toString('base64')).catch(() => undefined)

            // Single recovery attempt — agent escalates to HITL on attemptNum >= 2
            const recovery = await handleStepFailure({
              executionId,
              projectId,
              failedStep: step as any,
              errorMessage: result.error ?? result.message ?? 'Step failed',
              screenshot: screenshotB64,
              pageHtml,
              attemptNum: 1,
            })

            agentFailureType = recovery.failureType
            agentFailureReason = recovery.reason

            log.info(
              { executionId, step: step.id, action: recovery.action, failureType: agentFailureType },
              '[EXEC-AGENT] Recovery action returned',
            )

            if (recovery.action === 'WAIT_AND_RETRY') {
              log.info(`[EXEC-AGENT] Waiting 2s then retrying step ${i + 1}`)
              await page.waitForTimeout(2_000)
              const retryResult = await executeStep(
                page, step, i, isLastStep, execScreenDir, executionId,
                browserContext ?? undefined, projectId, context.projectCategory, context,
              )
              if (retryResult.status === 'passed') {
                stepResults[stepResults.length - 1] = retryResult
                agentRecovered = true
                log.info(`[EXEC-AGENT] ✅ Step ${i + 1} recovered via WAIT_AND_RETRY`)
              }
            } else if (recovery.action === 'DISMISS_MODAL') {
              log.info(`[EXEC-AGENT] Dismissing modal then retrying step ${i + 1}`)
              await page.keyboard.press('Escape').catch(() => {})
              await page.waitForTimeout(1_000)
              const retryResult = await executeStep(
                page, step, i, isLastStep, execScreenDir, executionId,
                browserContext ?? undefined, projectId, context.projectCategory, context,
              )
              if (retryResult.status === 'passed') {
                stepResults[stepResults.length - 1] = retryResult
                agentRecovered = true
                log.info(`[EXEC-AGENT] ✅ Step ${i + 1} recovered via DISMISS_MODAL`)
              }
            } else if (recovery.action === 'SKIP_STEP') {
              // INVALID_FIELD or known-skip scenario: auto-skip the step without HITL
              // The field doesn't exist on the form — no human intervention can fix this
              log.info(
                { executionId, step: step.id, failureType: recovery.failureType, reason: recovery.reason },
                `[EXEC-AGENT] ⏭ Auto-skipping step ${i + 1} (${recovery.failureType ?? 'SKIP_STEP'})`,
              )
              stepResults[stepResults.length - 1] = {
                ...result,
                status: 'skipped' as any,
                message: `⏭ Step auto-skipped: ${recovery.reason ?? 'Field does not exist on this entity'}`,
                error: recovery.reason ?? result.error,
              }
              agentRecovered = true
            } else if (recovery.action === 'REGENERATE_AND_RETRY') {
              // INVALID_TEST_DATA: the step value is placeholder/garbage — replace with corrected value and retry
              const correctedValue = (recovery as any).correctedValue as string | undefined
              if (correctedValue) {
                log.info(
                  { executionId, step: step.id, originalValue: step.value, correctedValue, failureType: recovery.failureType },
                  `[EXEC-AGENT] 🔄 Retrying step ${i + 1} with corrected value (${recovery.failureType})`,
                )

                // Update the recovery banner to show the fix
                await page.evaluate(({ corrected, fieldName }: { corrected: string; fieldName: string }) => {
                  const banner = document.getElementById('autotest-recovery-banner')
                  if (banner) {
                    const msgEl = banner.querySelector('div > div:nth-child(2) > div:last-child') as HTMLElement | null
                    if (msgEl) msgEl.textContent = `Fixing: "${fieldName}" \u2192 "${corrected}"`
                    const titleEl = banner.querySelector('div > div:nth-child(2) > div:first-child') as HTMLElement | null
                    if (titleEl) titleEl.textContent = 'AI Recovery \u2014 Replacing Bad Data\u2026'
                  }
                }, { corrected: correctedValue.slice(0, 40), fieldName: (step.target ?? '').slice(0, 30) }).catch(() => {})

                // Create a corrected copy of the step with the new value
                const correctedStep = { ...step, value: correctedValue }
                await page.waitForTimeout(500)
                const retryResult = await executeStep(
                  page, correctedStep, i, isLastStep, execScreenDir, executionId,
                  browserContext ?? undefined, projectId, context.projectCategory, context,
                )
                if (retryResult.status === 'passed') {
                  stepResults[stepResults.length - 1] = {
                    ...retryResult,
                    message: `✅ Step auto-corrected: value changed from "${(step.value ?? '').slice(0, 20)}" to "${correctedValue.slice(0, 30)}"`,
                  }
                  agentRecovered = true
                  log.info(`[EXEC-AGENT] ✅ Step ${i + 1} recovered via REGENERATE_AND_RETRY (value: "${correctedValue}")`)
                } else {
                  log.warn(
                    { executionId, step: step.id, correctedValue },
                    `[EXEC-AGENT] ❌ Step ${i + 1} still failed after REGENERATE_AND_RETRY`,
                  )
                }
              } else {
                // No corrected value available — skip the step
                log.info(
                  { executionId, step: step.id, failureType: recovery.failureType },
                  `[EXEC-AGENT] ⏭ Auto-skipping step ${i + 1} (INVALID_TEST_DATA, no corrected value)`,
                )
                stepResults[stepResults.length - 1] = {
                  ...result,
                  status: 'skipped' as any,
                  message: `⏭ Step auto-skipped: ${recovery.reason ?? 'Invalid test data with no replacement available'}`,
                  error: recovery.reason ?? result.error,
                }
                agentRecovered = true
              }
            } else if (recovery.hitlInvoked || recovery.action === 'HITL_INVOKED') {
              agentRecovered = true // already paused via hitlTool
            }
          } catch (agentErr) {
            log.warn({ agentErr }, '[EXEC-AGENT] Recovery attempt errored (non-fatal) — falling through to HITL overlay')
          } finally {
            // Always remove the recovery banner
            page.evaluate(() => document.getElementById('autotest-recovery-banner')?.remove()).catch(() => {})
          }

          if (agentRecovered) {
            const latestResult = stepResults[stepResults.length - 1]
            if (latestResult.status === 'passed') continue
            finalStatus = 'FAILED'
            firstFailedLocator = step.target ?? ''
            break
          }
        }

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
                  if (hitlSettleFn && (action === 'resume' || action === 'skip' || action === 'stop')) {
                    hitlSettleFn(action as 'resume' | 'skip' | 'stop')
                  }
                  await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' })
                } catch { await route.abort().catch(() => { }) }
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
                if (hitlSettleFn && (action === 'resume' || action === 'skip' || action === 'stop')) {
                  hitlSettleFn(action as 'resume' | 'skip' | 'stop')
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
            agentFailureType,
            agentFailureReason,
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
                agentFailureType,
                agentFailureReason,
              )
              log.info(`[HITL] ♻️ Overlay re-injected after page navigation for step ${i + 1}`)
              await setBrowserState(page!, 'paused')
            } catch (err) {
              log.warn({ err }, '[HITL] Could not re-inject overlay after navigation (non-fatal)')
            }
          }
          page.on('load', reInjectOverlay)

          let pauseAction: 'resume' | 'skip' | 'stop' = 'resume'
          try {
            // Quad-channel HITL gate — whichever fires first wins:
            //   Channel 0 (iframe link) — <a href> targeting hidden iframe, intercepted by page.route(). Pure HTML, no JS needed.
            //   Channel 1 (exposeFunc)  — window.__autotestHitlSignal() calls Node.js directly. Survives navigation.
            //   Channel 2 (DOM poll)    — polls checkbox state + data-autotest-hitl-action every 500ms.
            //   Channel 3 (dashboard)   — waitForResume() resolves on POST /api/v1/test-runs/:id/resume.
            pauseAction = await new Promise<'resume' | 'skip' | 'stop'>((resolve, reject) => {
              const deadline = Date.now() + pauseTimeoutMs
              let settled = false

              function settle(action: 'resume' | 'skip' | 'stop') {
                if (settled) return
                settled = true
                hitlPauseSettled = true
                hitlSettleFn = null
                clearInterval(pollInterval)
                try { page?.off('load', reInjectOverlay) } catch { }
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
                    const stopChk = document.getElementById('autotest-stop-chk') as HTMLInputElement | null
                    if (resumeChk?.checked) return 'resume'
                    if (skipChk?.checked) return 'skip'
                    if (stopChk?.checked) return 'stop'
                    // Check DOM attribute + sessionStorage
                    const a = document.body.getAttribute('data-autotest-hitl-action')
                      || sessionStorage.getItem('autotest-hitl-action')
                    if (a) {
                      document.body.removeAttribute('data-autotest-hitl-action')
                      try { sessionStorage.removeItem('autotest-hitl-action') } catch { }
                    }
                    return a
                  })
                  consecutivePollErrors = 0
                  if (action === 'resume' || action === 'skip' || action === 'stop') settle(action as 'resume' | 'skip' | 'stop')
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
            if (pauseAction !== 'stop') {
              await prisma.test_runs.update({ where: { id: executionId }, data: { status: 'running' } }).catch(() => { })
            }
            log.info(`[HITL] User chose: "${pauseAction}" for step ${i + 1}`)
          } catch {
            log.warn(`[HITL] Pause timed out for step ${i + 1} — marking as failed and stopping`)
            hitlPauseSettled = true
            hitlSettleFn = null
            try { page.off('load', reInjectOverlay) } catch { }
            await removePauseOverlay(page)
            await setBrowserState(page, 'failed')
            finalStatus = 'FAILED'
            firstFailedLocator = step.target ?? ''
            break
          }

          // ── Handle stop: close browser and abort run ────────────────────
          if (pauseAction === 'stop') {
            log.warn(`[HITL] User clicked Stop at step ${i + 1} — aborting run and closing browser`)
            hitlPauseSettled = true
            hitlSettleFn = null
            try { page.off('load', reInjectOverlay) } catch { }
            // Mark result as stopped
            stepResults[stepResults.length - 1] = {
              ...result, status: 'failed',
              message: `Step ${i + 1} stopped by user — test aborted`, error: 'User stopped the test',
            }
            finalStatus = 'FAILED'
            errorMessage = 'Test stopped by user'
            firstFailedLocator = step.target ?? ''
            // Set failed border, then close browser
            await setBrowserState(page, 'failed').catch(() => {})
            await page.waitForTimeout(800).catch(() => {})
            userClosedBrowser = true  // prevent further steps
            // Close the browser gracefully
            try {
              await browser?.close()
            } catch (closeErr) {
              log.warn({ closeErr }, '[HITL] Could not close browser on stop (non-fatal)')
            }
            break
          }

          // Remove overlay
          await removePauseOverlay(page)
          await setBrowserState(page, 'running')

          if (pauseAction === 'skip') {
            // A skipped step means the test cannot be fully verified — mark as failed
            finalStatus = 'FAILED'
            if (!firstFailedLocator) {
              firstFailedLocator = step.target ?? ''
            }
            stepResults[stepResults.length - 1] = {
              ...result, status: 'skipped',
              message: `Step ${i + 1} skipped by user (interactive mode)`, error: null,
            }
            log.info(`[HITL] Step ${i + 1} skipped — finalStatus set to FAILED, continuing to step ${i + 2}`)
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
      await page.waitForTimeout(600).catch(() => { })

      // ── Capture the authoritative RESULT screenshot with border visible ──
      const resultStatus = finalStatus === 'PASSED' ? 'PASSED' : 'FAILED'
      const resultSsFile = `result-${resultStatus}-${Date.now()}.png`
      const resultSsAbsPath = path.join(execScreenDir, resultSsFile)
      try {
        await page.screenshot({ path: resultSsAbsPath, fullPage: false })
        // Inject it as the last step so it wins the lastScreenshot pick below
        stepResults.push({
          step: stepResults.length + 1,
          action: 'RESULT_SCREENSHOT',
          target: null,
          value: null,
          status: finalStatus === 'PASSED' ? 'passed' : 'failed',
          message: `Final result screenshot — ${resultStatus}`,
          duration_ms: 0,
          screenshot_path: `/screenshots/${executionId}/${resultSsFile}`,
          error: null,
        })
        log.info(`[EXEC] 📸 Result screenshot captured with ${resultStatus} border: ${resultSsFile}`)
      } catch (ssErr) {
        log.warn({ ssErr }, '[EXEC] Could not capture result screenshot (non-fatal)')
      }

      // Brief pause so the user can see the final result color
      await page.waitForTimeout(2400).catch(() => { })
    }

    // ── Stop trace ────────────────────────────────────────────────
    try { await browserContext!.tracing.stop({ path: traceFile }) }
    catch (traceErr) { log.warn({ traceErr }, '[EXEC] Failed to stop trace') }

    // ── Write final result to DB BEFORE closing browser ───────────
    // This eliminates the race condition where the browser closes but the DB
    // still shows 'running'. The frontend poll always gets the true final
    // status before the browser window disappears.
    {
      const durationMsEarly = Date.now() - startTime
      const lastShotEarly = stepResults.slice().reverse().find((s) => s.screenshot_path)?.screenshot_path ?? null
      const earlyStatus =
        finalStatus === 'PASSED' ? 'passed'
          : finalStatus === 'FAILED' ? 'failed'
            : 'error'
      try {
        await prisma.test_runs.update({
          where: { id: executionId },
          data: {
            status: earlyStatus,
            result: earlyStatus,
            logs: stepResults as unknown as object[],
            duration: durationMsEarly / 1000,
            screenshot_path: lastShotEarly,
          },
        })
        log.info(`[EXEC] ✅ Pre-close DB write: ${executionId} → ${earlyStatus}`)
      } catch (earlyWriteErr) {
        log.warn({ earlyWriteErr }, '[EXEC] Pre-close DB write failed (will retry after close)')
      }
    }

    // ── Enqueue healing if failed ─────────────────────────────────
    if (finalStatus === 'FAILED' && firstFailedLocator !== null) {
      await healingQueue.add('heal', {
        executionId,
        testRunId: executionId,
        testCaseId,
        projectId,
        failedLocator: firstFailedLocator,
        screenshotBase64: failedScreenshotBase64 ?? '',
        htmlSnippet: failedHtmlSnippet ?? '',
        logs: stepResults as unknown as Record<string, unknown>[],
        steps: context.steps,
      }, { attempts: 2, backoff: { type: 'exponential', delay: 3000 } })
      log.info(`[EXEC] Healing job enqueued for ${executionId}`)
    }

  } catch (err: unknown) {
    log.error({ err }, `[EXEC] Fatal error in execution ${executionId}`)
    finalStatus = 'ERROR'
    errorMessage = err instanceof Error ? err.message : String(err)
    stepResults.push({
      step: stepResults.length + 1,
      action: 'SYSTEM',
      target: null,
      value: null,
      status: 'failed',
      message: `Fatal execution error: ${errorMessage}`,
      duration_ms: Date.now() - startTime,
      screenshot_path: null,
      error: errorMessage,
    })
  } finally {
    frameRegistry.delete(executionId)
    sfFieldMapRegistry.delete(executionId)
    sfMetadataMapRegistry.delete(executionId)
    clearPause(executionId)  // clean up HITL pause gate if still pending
    try { await browserContext?.close() } catch { /* ignore */ }
    try { await browser?.close() } catch { /* ignore */ }
  }

  // ── Safety: Write final result to test_runs (catches fatal error path) ──────
  // The pre-close write above handles the happy path. This catches ERROR status
  // from the catch block which runs before finally (browser not yet closed).
  const durationMs = Date.now() - startTime
  const lastScreenshot = stepResults.slice().reverse().find((s) => s.screenshot_path)?.screenshot_path ?? null
  const testRunStatus =
    finalStatus === 'PASSED' ? 'passed'
      : finalStatus === 'FAILED' ? 'failed'
        : 'error'

  try {
    await prisma.test_runs.update({
      where: { id: executionId },
      data: {
        status: testRunStatus,
        result: testRunStatus,
        logs: stepResults as unknown as object[],
        duration: durationMs / 1000,
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

worker.on('completed', (job) => log.info(`[EXEC] Job ${job.id} completed`))
worker.on('failed', (job, err) => log.error({ err }, `[EXEC] Job ${job?.id} failed: ${err.message}`))
worker.on('error', (err) => log.error({ err }, '[EXEC] Worker error'))

log.info('🔧 Execution worker started — Playwright headless runner active (SF Lightning full support)')

export default worker
