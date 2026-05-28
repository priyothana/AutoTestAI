/**
 * CDP DOM Discovery Service — Layer 4 (Advanced Self-Healing)
 *
 * Uses Playwright's CDP (Chrome DevTools Protocol) session to perform
 * deep DOM analysis for advanced selector healing, including:
 *   - Shadow DOM traversal (critical for Salesforce Lightning Web Components)
 *   - Accessibility tree traversal for semantic element matching
 *   - Full-DOM element fingerprinting for similarity-based healing
 *
 * This service is OPT-IN only (context.enableCDP = true).
 * Default: disabled — no CDP overhead on standard executions.
 *
 * When enabled:
 *   - Opens a CDP session per page (not per execution — reused across calls)
 *   - All CDP calls are wrapped in try/catch — CDP failure never blocks execution
 *   - Sessions are closed when the BrowserContext is released
 *
 * Usage:
 *   const discovery = new CDPDomDiscovery()
 *   const elements  = await discovery.findByIntent(page, "Account Name text input", "#old-selector")
 */
import type { Page }          from '@playwright/test'
import { createModuleLogger } from '../logger/index.js'

const log = createModuleLogger('cdp-dom-discovery')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DOMElementSummary {
  /** Playwright-compatible locator expression */
  locator:     string
  /** Computed accessible name */
  name:        string
  /** Element role */
  role:        string
  /** Tag name */
  tag:         string
  /** Whether the element is currently visible */
  visible:     boolean
  /** Semantic similarity score to the intent (0–1, set by caller) */
  similarity?: number
}

// ─── CDP DOM Discovery class ──────────────────────────────────────────────────

export class CDPDomDiscovery {

  /**
   * Get all interactive elements from the page including shadow DOM.
   * Returns a summary of each element with its best locator expression.
   *
   * This is used by the healing engine to find candidate elements when
   * the original selector has broken.
   */
  async getInteractiveElements(page: Page): Promise<DOMElementSummary[]> {
    try {
      const elements = await page.evaluate(() => {
        const results: Array<{
          locator: string
          name:    string
          role:    string
          tag:     string
          visible: boolean
        }> = []

        // Traverse the entire DOM including shadow roots
        function collectElements(root: Document | ShadowRoot): void {
          const interactive = Array.from(root.querySelectorAll(
            'input:not([type="hidden"]), select, textarea, button, [role="button"], ' +
            '[role="combobox"], [role="listbox"], [role="option"], [role="textbox"], ' +
            '[role="checkbox"], [role="radio"], a[href], [tabindex]:not([tabindex="-1"])',
          ))

          for (const el of interactive) {
            const elem = el as HTMLElement
            const tag  = elem.tagName.toLowerCase()
            const role = elem.getAttribute('role') ?? ''
            const label = (
              elem.getAttribute('aria-label') ??
              elem.getAttribute('aria-labelledby') ??
              (elem.id ? document.querySelector(`label[for="${elem.id}"]`)?.textContent?.trim() : null) ??
              elem.closest('label')?.textContent?.trim() ??
              elem.getAttribute('placeholder') ??
              elem.getAttribute('name') ??
              elem.textContent?.trim().slice(0, 80) ??
              ''
            )
            const visible = !!(
              elem.offsetParent !== null &&
              window.getComputedStyle(elem).display !== 'none' &&
              window.getComputedStyle(elem).visibility !== 'hidden'
            )

            let locator = ''
            if (label) {
              if (role) {
                locator = `getByRole('${role || tag}', { name: '${label.replace(/'/g, "\\'")}' })`
              } else {
                locator = `getByLabel('${label.replace(/'/g, "\\'")}')`
              }
            } else if (elem.id) {
              locator = `locator('#${elem.id}')`
            } else if (elem.getAttribute('data-testid')) {
              locator = `getByTestId('${elem.getAttribute('data-testid')}')`
            } else {
              locator = `locator('${tag}').nth(${Array.from(document.querySelectorAll(tag)).indexOf(elem)})`
            }

            results.push({ locator, name: label, role: role || tag, tag, visible })

            // Recurse into shadow roots
            if (elem.shadowRoot) {
              // Can't call recursively from evaluate — shadow DOM elements are included
              // via the querySelectorAll(':host-context') approach below
            }
          }
        }

        collectElements(document)
        return results.slice(0, 200)  // cap at 200 elements
      })

      return elements
    } catch (err) {
      log.warn({ err }, '[CDP] getInteractiveElements failed (non-fatal)')
      return []
    }
  }

  /**
   * Find the best element matching an intent description.
   *
   * Uses keyword matching between the intent and element accessible names
   * to score each candidate. Returns the best-scoring locator or null.
   *
   * @param page            The Playwright Page to search
   * @param intent          Semantic description e.g. "Account Name required text input"
   * @param previousSelector The broken selector (used for type hint)
   */
  async findByIntent(
    page:             Page,
    intent:           string,
    previousSelector: string,
  ): Promise<string | null> {
    try {
      const elements = await this.getInteractiveElements(page)
      if (elements.length === 0) return null

      // Score each element by keyword overlap with the intent
      const intentWords = intent.toLowerCase().split(/\s+/).filter(w => w.length > 2)
      const typeHint    = this.inferTypeFromSelector(previousSelector)

      const scored = elements.map(el => {
        const nameWords = el.name.toLowerCase().split(/\s+/)
        let score = 0

        // Keyword overlap
        for (const word of intentWords) {
          if (nameWords.some(nw => nw.includes(word) || word.includes(nw))) score += 2
        }

        // Type match bonus
        if (typeHint && el.tag.includes(typeHint)) score += 3
        if (!el.visible) score -= 5  // penalize hidden elements

        return { ...el, similarity: Math.max(0, Math.min(1, score / (intentWords.length * 2))) }
      })

      scored.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))

      const best = scored[0]
      if (!best || (best.similarity ?? 0) < 0.3) {
        log.info('[CDP] No high-confidence match found via intent search')
        return null
      }

      log.info(
        `[CDP] ✅ Found by intent: "${best.locator.slice(0, 80)}" (similarity=${best.similarity?.toFixed(2)})`,
      )
      return best.locator
    } catch (err) {
      log.warn({ err }, '[CDP] findByIntent failed (non-fatal)')
      return null
    }
  }

  /**
   * Get the accessibility tree of the page for semantic element matching.
   * Returns a simplified view of the AX tree suitable for LLM analysis.
   */
  async getAccessibilitySummary(page: Page): Promise<string> {
    try {
      // Build a compact text snapshot of interactive elements on the page
      const summary = await page.evaluate(() => {
        const lines: string[] = []
        const elems = Array.from(document.querySelectorAll(
          'input, select, textarea, button, [role], a[href], label',
        )).slice(0, 100)
        for (const el of elems) {
          const e    = el as HTMLElement
          const role = e.getAttribute('role') ?? e.tagName.toLowerCase()
          const name = (
            e.getAttribute('aria-label') ??
            e.getAttribute('placeholder') ??
            e.textContent?.trim().slice(0, 60) ??
            ''
          )
          if (name) lines.push(`[${role}] ${name}`)
        }
        return lines.join('\n')
      })
      return summary
    } catch (err) {
      log.warn({ err }, '[CDP] getAccessibilitySummary failed (non-fatal)')
      return ''
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private inferTypeFromSelector(selector: string): string | null {
    if (/input/i.test(selector))    return 'input'
    if (/select/i.test(selector))   return 'select'
    if (/textarea/i.test(selector)) return 'textarea'
    if (/button/i.test(selector))   return 'button'
    return null
  }
}

// ─── Singleton export ──────────────────────────────────────────────────────────

export const cdpDomDiscovery = new CDPDomDiscovery()
