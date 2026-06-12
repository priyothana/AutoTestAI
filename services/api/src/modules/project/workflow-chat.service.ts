/**
 * Workflow Chat Service
 * Powers the AI-driven Business Flow wizard in the Tests tab:
 *   Phase 1 — Generate business flow options from project metadata + BRD
 *   Phase 2 — Conversational refinement to narrow the workflow scope
 *   Phase 3 — Natural-language filtering of generated test cases
 */
import { ChatOpenAI }            from '@langchain/openai'
import { ChatAnthropic }         from '@langchain/anthropic'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import type { BaseChatModel }    from '@langchain/core/language_models/chat_models'
import prisma                    from '../../shared/db/prisma.js'
import { createModuleLogger }    from '../../shared/logger/index.js'
import { buildFieldManifest, autoCorrectButtonNames } from '../ai-agents/tools/metadata-reader.tool.js'

const log = createModuleLogger('workflow-chat')

// ─── LLM factory ─────────────────────────────────────────────────────────────

/**
 * Returns true when Anthropic should be preferred over OpenAI.
 * Controlled by LLM_PROVIDER env var: 'anthropic' → use Anthropic.
 * Falls back to Anthropic whenever OpenAI key is missing.
 */
function useAnthropic(): boolean {
  const provider = (process.env.LLM_PROVIDER ?? '').toLowerCase()
  if (provider === 'anthropic') return true
  if (provider === 'openai')    return false
  // No explicit provider — prefer OpenAI only if key is present
  return !process.env.OPENAI_API_KEY
}

function buildLlm(): BaseChatModel {
  if (!useAnthropic() && process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o', temperature: 0.4, maxTokens: 8192 })
  }
  return new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-5'),
    maxTokens: 8192,
    temperature: 0.4,
  })
}

/** Dedicated LLM for workflow discovery — uses a high-capability model for richer analysis. */
function buildDiscoveryLlm(): BaseChatModel {
  if (!useAnthropic() && process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o', temperature: 0.3, maxTokens: 8192 })
  }
  return new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.CLAUDE_MODEL ?? (process.env.LLM_MODEL ?? 'claude-sonnet-4-5'),
    maxTokens: 8192,
    temperature: 0.3,
  })
}

/**
 * Hard cap on assembled metadata string to keep total prompt under model limits.
 * ~18 000 chars ≈ ~4 500 tokens — leaves ample room for the system prompt + BRD.
 */
const META_CHAR_BUDGET = 18_000

/** Trim a string to at most `budget` chars, appending a truncation notice. */
function capMeta(s: string, budget = META_CHAR_BUDGET): string {
  if (s.length <= budget) return s
  return s.slice(0, budget) + `\n  … [truncated — ${s.length - budget} chars omitted to fit token limit]`
}

/**
 * Safely decode document content for LLM consumption.
 * Files uploaded as binary are stored as base64 strings.
 * Plain text files (.txt) are stored as UTF-8 and passed through.
 * We attempt base64 decode; if it fails or produces garbled output we
 * return a notice instead so the prompt stays clean.
 */
function decodeDocContent(raw: string, maxChars = 6000): string {
  if (!raw || raw.trim() === '') return ''
  // Heuristic: base64 strings are long, contain only [A-Za-z0-9+/=], and have no spaces
  const isLikelyBase64 = raw.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(raw.trim())
  if (isLikelyBase64) {
    try {
      const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8')
      // If decoded text looks printable (>70% ASCII printable), use it
      const printable = decoded.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length
      if (printable / decoded.length > 0.7) {
        return decoded.slice(0, maxChars)
      }
      // Binary file (PDF/DOCX internals) — not readable by LLM
      return '[Binary document attached — content extracted from filename only. Use the document name to infer its purpose.]'
    } catch {
      return '[Document attached — could not decode content]'
    }
  }
  // Plain text — pass through with cap
  return raw.slice(0, maxChars)
}

// ─── BRD Entity Extraction & Orphan Detection (project-agnostic) ─────────────

/**
 * Extracts entity/module/workflow names from any BRD text.
 *
 * Works for any domain: CRM entities (Lead, Opportunity, Invoice),
 * Logistics (Shipment, Booking, Delivery), Healthcare (Prescription, Visit),
 * ERP (Purchase Order, GRN, BOM), etc.
 *
 * Heuristic approach — does NOT require domain knowledge:
 *  1. Section headers: "## Invoice Management" → "Invoice Management"
 *  2. Object noun patterns: "the Invoice is created", "create a Booking"
 *  3. Bold/Title-case nouns that appear ≥2 times in the BRD
 *  4. Workflow diagram labels: "CAMPAIGN → LEAD → ACCOUNT"
 *
 * Returns a Set of candidate entity names (de-duped, title-cased, min 3 chars).
 */
function parseBrdEntities(brdText: string): Set<string> {
  if (!brdText || brdText.trim().length < 50) return new Set()

  const candidates = new Set<string>()

  // ── 1. Section / heading patterns ──────────────────────────────────────────
  // Matches: "# Invoice", "## Quote Management", "### 3. Order Processing"
  const headingRe = /^#+\s+(?:\d+\.?\s+)?([A-Z][A-Za-z\s&/\-]{2,40})$/gm
  for (const m of brdText.matchAll(headingRe)) {
    const raw = m[1].trim().replace(/\s+/g, ' ')
    if (raw.length >= 3 && raw.length <= 50) candidates.add(raw)
  }

  // ── 2. ALL-CAPS diagram labels (workflow arrows like "CAMPAIGN → LEAD") ────
  // Common in BRDs that embed ASCII workflow diagrams
  const allCapsRe = /\b([A-Z][A-Z\s]{2,30})\b/g
  for (const m of brdText.matchAll(allCapsRe)) {
    const raw = m[1].trim().replace(/\s+/g, ' ')
    // Skip common English all-caps words that aren't entities
    const skipWords = new Set(['THE', 'AND', 'FOR', 'FROM', 'WITH', 'MUST', 'NOT', 'ALL',
      'ARE', 'HAS', 'CAN', 'WILL', 'THIS', 'THAT', 'WHEN', 'THEN', 'INTO', 'UPON',
      'SHOULD', 'SHALL', 'ONLY', 'ONCE', 'ALSO', 'BOTH', 'SUCH', 'EACH', 'SOME',
      'NEW', 'OLD', 'KEY', 'END', 'NOTE', 'HITL', 'API', 'UI', 'URL', 'BRD', 'LLM'])
    const parts = raw.split(/\s+/)
    if (parts.every(p => !skipWords.has(p)) && raw.length >= 3 && raw.length <= 40) {
      // Title-case it: "OPPORTUNITY PRODUCTS" → "Opportunity Products"
      const titled = raw.replace(/\b\w+/g, w => w[0] + w.slice(1).toLowerCase())
      candidates.add(titled)
    }
  }

  // ── 3. Quoted / bold entity names: "**Invoice**", "`Quote`", '"Order"' ─────
  const quotedRe = /(?:\*\*|__|`|")([A-Z][A-Za-z\s]{1,30})(?:\*\*|__|`|")/g
  for (const m of brdText.matchAll(quotedRe)) {
    const raw = m[1].trim()
    if (raw.length >= 3 && /^[A-Z]/.test(raw)) candidates.add(raw)
  }

  // ── 4. Verb-Object patterns: "create an Invoice", "generate a Payment" ────
  const verbObjectRe = /\b(?:create|generate|issue|submit|approve|process|manage|review|convert|send|record|update|delete|archive|view|list)\s+(?:a|an|the|new)?\s*([A-Z][A-Za-z\s]{2,30}?)(?=[,\.\s]|$)/gm
  for (const m of brdText.matchAll(verbObjectRe)) {
    const raw = m[1].trim().replace(/\s+/g, ' ')
    if (raw.length >= 3 && raw.length <= 40 && /^[A-Z]/.test(raw)) candidates.add(raw)
  }

  // ── 5. Frequency filter — keep nouns appearing ≥2 times (reduces false positives)
  const freqMap = new Map<string, number>()
  const textLower = brdText.toLowerCase()
  const confirmed = new Set<string>()
  for (const cand of candidates) {
    const count = (textLower.match(new RegExp(`\\b${cand.toLowerCase().replace(/[^a-z0-9\s]/g, '.')}\\b`, 'g')) ?? []).length
    freqMap.set(cand, count)
    if (count >= 2) confirmed.add(cand)
  }
  // Always keep heading-based entities (even if only mentioned once)
  const headingRe2 = /^#+\s+(?:\d+\.?\s+)?([A-Z][A-Za-z\s&/\-]{2,40})$/gm
  for (const m of brdText.matchAll(headingRe2)) {
    const raw = m[1].trim().replace(/\s+/g, ' ')
    if (raw.length >= 3) confirmed.add(raw)
  }

  // Strip generic non-entity terms
  const genericTerms = new Set([
    'Introduction', 'Overview', 'Summary', 'Description', 'Purpose', 'Scope',
    'Background', 'Appendix', 'Glossary', 'References', 'Revision History',
    'Table Of Contents', 'Requirements', 'Functional Requirements', 'Non Functional',
    'Business Rules', 'Acceptance Criteria', 'User Stories', 'Use Cases',
    'Document', 'Section', 'Phase', 'Stage', 'Step', 'Field', 'Button',
    'System', 'Application', 'Platform', 'Module', 'Feature', 'Component',
  ])

  for (const term of genericTerms) confirmed.delete(term)

  return confirmed
}

/**
 * Finds BRD entities that the crawler COULD NOT reach.
 *
 * A BRD entity is "orphaned" (crawler-unreachable) when:
 *   - It is mentioned in the BRD (via parseBrdEntities)
 *   - BUT there is NO crawled page whose path contains the entity's slug form
 *
 * This is the universal fix for the "record-dependency" problem:
 *   CRM: Invoice requires Order → crawler never navigated there
 *   Logistics: Delivery Note requires Shipment → same issue
 *   Healthcare: Prescription requires Patient Visit → same issue
 *   ERP: Goods Receipt Note requires Purchase Order → same issue
 *
 * Returns { orphaned: string[], crawledEntityNames: string[] }
 */
function detectOrphanedBrdEntities(
  brdEntities:  Set<string>,
  crawledPaths: string[],
): { orphaned: string[]; crawledEntityNames: string[] } {
  // Slugify: "Opportunity Products" → ["opportunity", "products", "opportunity-products"]
  const toSlugs = (name: string): string[] => {
    const lower = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const parts  = lower.split('-').filter(p => p.length > 2)
    return [lower, ...parts]
  }

  // Build a set of all "entity tokens" present in crawled paths
  const crawledTokens = new Set<string>()
  const crawledEntityNames: string[] = []
  for (const p of crawledPaths) {
    const segments = p.toLowerCase().split('/').filter(Boolean)
    for (const seg of segments) {
      // Stem: remove trailing s/es/ies for plural matching
      crawledTokens.add(seg)
      if (seg.endsWith('ies'))  crawledTokens.add(seg.slice(0, -3) + 'y')
      else if (seg.endsWith('es') && seg.length > 3) crawledTokens.add(seg.slice(0, -2))
      else if (seg.endsWith('s')  && seg.length > 3) crawledTokens.add(seg.slice(0, -1))
    }
    // Derive readable entity name from path for reporting
    const last = segments[segments.length - 1]
    if (last && !['new', 'edit', 'create', 'list', 'view', 'show', 'index'].includes(last)) {
      const readable = last.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      crawledEntityNames.push(readable)
    }
  }

  const orphaned: string[] = []
  for (const entity of brdEntities) {
    const slugs = toSlugs(entity)
    // Consider "found" if ANY slug segment appears in crawled tokens
    const found = slugs.some(slug => crawledTokens.has(slug))
    if (!found) orphaned.push(entity)
  }

  return { orphaned, crawledEntityNames }
}

/**
 * Builds the CRAWLER-UNREACHABLE ENTITIES block for the workflow generation prompt.
 *
 * This block explicitly tells the LLM:
 *  - Which entities exist in the BRD but were NOT crawled by Playwright
 *  - WHY they were missed (dependency on existing records)
 *  - That it MUST generate full lifecycle flows for each one
 *
 * This is intentionally domain-neutral: it does not assume CRM or any specific
 * domain — it derives the information purely from BRD content and crawled metadata.
 */
function buildOrphanedEntitiesBlock(orphaned: string[]): string {
  if (orphaned.length === 0) return ''

  const entityList = orphaned
    .map(e => `  - ${e}`)
    .join('\n')

  return `
═══════════════════════════════════════════════════════════════
CRAWLER-UNREACHABLE ENTITIES (MANDATORY — generate flows for ALL)
═══════════════════════════════════════════════════════════════
The following entities/modules exist in the BRD but were NOT found
in the crawled metadata. This is expected: these pages typically
require existing records to be present (e.g., an Invoice page needs
an existing Order; a Delivery Note needs an existing Shipment; a
Prescription needs an existing Patient Visit). The Playwright crawler
cannot create those prerequisite records, so these pages were never
visited.

YOU MUST generate flows for each of these entities, but ONLY using actions
and processes that are explicitly documented in the metadata or BRD:
${entityList}

For each entity above:
  a) CREATE flow — create a new record with all required fields
     (infer required fields from the BRD section for this entity)
  b) UPDATE flow — find existing record and modify key fields
  c) STATUS TRANSITION flow — ONLY if the BRD explicitly lists status values
     for this entity. Use ONLY the statuses described in the BRD — do NOT
     invent statuses like "fulfilled", "shipped", "delivered" etc. unless
     the BRD or metadata explicitly names them.
  d) CROSS-MODULE flow — ONLY if the BRD explicitly describes a relationship
     between this entity and another entity (e.g., "Quote is generated from
     Opportunity"). Do NOT invent cross-module actions that are not documented.

IMPORTANT GROUNDING RULES for these entities:
  - Since crawl data is unavailable, derive page URL as: "/{entity-slug}" or "/{entity-slug}/new"
    where entity-slug is the lowercase plural (e.g., "invoices", "delivery-notes", "prescriptions")
  - If the BRD specifies a different URL pattern, use that instead
  - For VERIFY steps, assert ONLY the states/statuses explicitly described in the BRD
  - Do NOT hallucinate business processes, statuses, or actions from general industry knowledge.
    If the BRD says nothing about "fulfillment" for Orders, do NOT generate a fulfillment flow.
═══════════════════════════════════════════════════════════════
`
}

/**
 * After the LLM returns its flow list, check for BRD entities that got no flow generated.
 * For each missing entity, inject a minimal CRUD fallback flow.
 *
 * This is the second safety net — even if the LLM ignores the orphaned-entities block,
 * the post-processor ensures every BRD entity gets at least one flow in the output.
 */
function gapFillMissingEntityFlows(
  flows:       Array<{ name: string; description: string }>,
  brdEntities: Set<string>,
): Array<{ name: string; description: string }> {
  if (brdEntities.size === 0) return flows

  // Check which entities already have a flow (fuzzy match on flow name)
  const coveredEntities = new Set<string>()
  for (const flow of flows) {
    const flowNameLower = flow.name.toLowerCase()
    for (const entity of brdEntities) {
      const entityLower = entity.toLowerCase()
      // Consider covered if the entity name appears in the flow name
      if (flowNameLower.includes(entityLower) || entityLower.split(' ').every(w => w.length <= 2 || flowNameLower.includes(w))) {
        coveredEntities.add(entity)
      }
    }
  }

  // Inject fallback flows for uncovered entities
  const injected: Array<{ name: string; description: string }> = []
  for (const entity of brdEntities) {
    if (coveredEntities.has(entity)) continue

    // Generate minimal CRUD flows for this entity
    injected.push(
      {
        name:        `Create ${entity} With Required Fields`,
        description: `Creates a new ${entity} record by filling all required fields as specified in the BRD. Verifies successful creation and that the record appears in the ${entity} list.`,
      },
      {
        name:        `Update and Verify ${entity} Details`,
        description: `Finds an existing ${entity} record and modifies its key editable fields. Verifies the changes are saved and reflected in the record detail view.`,
      },
    )

    log.info({ entity }, '[WORKFLOW] Gap-fill: injected fallback flows for BRD entity not covered by LLM')
  }

  return [...flows, ...injected]
}

/**
 * Classifies each crawled page by its UI role and extracts confirmed action capabilities.
 *
 * Page types derived automatically from metadata:
 *   FORM     — has ≥1 required input field (create/edit screen)
 *   LIST     — has ≥1 record-ID button (e.g. ENQ-0001, QUO-0002) but no required inputs
 *   DASHBOARD— root path "/" or "/dashboard" with action-card buttons but no records
 *   DETAIL   — has a mix of inputs and record-action buttons
 *   UNKNOWN  — none of the above
 *
 * Returns a text block to inject into prompts so the LLM knows EXACTLY what UI
 * actions are available on each page — eliminating hallucinated steps like
 * "Click Add Charges" on a page that only has a record list.
 */
function buildPageUIConstraints(
  pages: Array<{
    path: string
    buttons?: Array<{ name?: string }>
    inputs?: Array<{ name?: string; required?: boolean }>
    selects?: Array<{ name?: string }>
  }>,
): string {
  if (pages.length === 0) return ''

  // Regex patterns for record-ID buttons (ENQ-0001, QUO-004, BKG-12, INV-0001 etc.)
  const RECORD_ID_PATTERN = /^[A-Z]{2,6}-?\d{1,6}$/

  const lines: string[] = ['PAGE UI INVENTORY (confirmed elements only — do not use unlisted buttons/inputs):']

  for (const page of pages) {
    const path = page.path ?? '/'
    const allButtons = (page.buttons ?? []).map(b => (b.name ?? '').trim()).filter(Boolean)
    const allInputs  = (page.inputs  ?? []).map(i => (i.name ?? '').trim()).filter(Boolean)
    const allSelects = (page.selects ?? []).map(s => (s.name ?? '').trim()).filter(Boolean)

    // Classify buttons
    const recordButtons = allButtons.filter(b => RECORD_ID_PATTERN.test(b.split('\n')[0]))
    const navButtons    = allButtons.filter(b => {
      const first = b.split('\n')[0]
      return !RECORD_ID_PATTERN.test(first) &&
             !['Previous', 'Next', 'Sign Out', 'Admin', 'Logout', 'Log Out', 'Close', 'Cancel'].includes(first) &&
             !first.match(/^[A-Z]$/)  // single-letter avatar buttons
    })
    const requiredInputs = (page.inputs ?? []).filter(i => i.required).map(i => (i.name ?? '').trim()).filter(Boolean)

    // Determine page type
    let pageType: string
    if (path === '/' || path === '/dashboard') {
      pageType = 'DASHBOARD'
    } else if (requiredInputs.length > 0 || allSelects.length > 0) {
      pageType = 'FORM'
    } else if (recordButtons.length > 0 && allInputs.length <= 1) {
      // 1 input = usually a search box on a list page
      pageType = 'LIST'
    } else if (allInputs.length > 1) {
      pageType = 'DETAIL/FORM'
    } else {
      pageType = 'UNKNOWN'
    }

    const lineParts = [`  • ${path} [${pageType}]`]

    // ── Cross-entity button filter ──────────────────────────────────────
    // The page's entity is derived from its path (e.g., /accounts → "account").
    // Buttons like "+ New Lead" appearing on the /accounts page are from the
    // navigation sidebar — NOT actions for the Account entity. Filter them out
    // so the LLM doesn't use them when generating Account test cases.
    const pathSegments = path.split('/').filter(Boolean)
    // Entity slug: last meaningful segment, de-pluralized (accounts → account)
    const pageEntitySlug = (pathSegments.find(s => !['new', 'create', 'add', 'edit', 'view', 'detail'].includes(s.toLowerCase())) ?? '')
      .toLowerCase()
      .replace(/s$/, '')  // simple de-plural: accounts → account

    const isOtherEntityButton = (btnName: string): boolean => {
      if (!pageEntitySlug || pageEntitySlug.length < 3) return false
      const lower = btnName.toLowerCase()
      const match = lower.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
      if (!match) return false
      const entityWord = match[1].trim()
      if (entityWord.length < 3) return false
      // If the button's entity word doesn't match the page entity → it's cross-entity
      return !pageEntitySlug.includes(entityWord) && !entityWord.includes(pageEntitySlug)
    }

    // Confirmed action buttons (not record IDs, not nav chrome, not cross-entity)
    const actionButtons = navButtons.filter(b => {
      const first = b.split('\n')[0]
      const lower = first.toLowerCase()
      if (['previous', 'next', 'sign out', 'admin', 'logout', 'log out', 'close', 'cancel'].includes(lower)) return false
      // Exclude cross-entity sidebar buttons (e.g., "+ New Lead" on /accounts page)
      if (isOtherEntityButton(first)) return false
      return true
    }).map(b => b.split('\n')[0]).slice(0, 8)
    if (actionButtons.length > 0) lineParts.push(`    confirmed buttons: ${actionButtons.join(', ')}`)

    // Record list (if LIST page — shows what records can be clicked)
    if (recordButtons.length > 0) {
      lineParts.push(`    record list: ${recordButtons.slice(0, 4).join(', ')}${recordButtons.length > 4 ? ` (+${recordButtons.length - 4} more)` : ''}`)
      lineParts.push(`    ⚠ LIST page: generate NAVIGATE + CLICK record + VERIFY flows only. No CREATE/EDIT unless a "New" or "Create" button is listed above.`)
    }

    // Form fields
    if (requiredInputs.length > 0) lineParts.push(`    required fields: ${requiredInputs.join(', ')}`)
    if (allSelects.length > 0)     lineParts.push(`    dropdowns: ${allSelects.slice(0, 6).join(', ')}`)

    lines.push(lineParts.join('\n'))
  }

  return lines.join('\n')
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a comprehensive project context for the AI, including:
 * - Project name and integration type (web_app / salesforce / api)
 * - Full page inventory: path, title, form fields, buttons, selects
 * - Domain model testing rules (what actions are available on each entity)
 * - BRD content if available
 *
 * This rich context ensures the AI generates workflows grounded in the
 * actual metadata of the project, not generic hallucinated flows.
 */
async function getProjectContext(projectId: string): Promise<{
  projectName:          string
  metadataSummary:      string
  brdContent:           string
  existingTestsContent: string
  projectCategory:      string
  pageConstraints:      string  // per-page UI inventory: page type + confirmed buttons/fields
  testDataEntities:     Array<{ entity_name: string; record_count: number; source_url: string | null }>  // confirmed scraped entities
}> {
  // ── Parallel DB fetches ──────────────────────────────────────────────────
  const [project, integration, brdRow, jiraIntegration, testDataRows] = await Promise.all([
    prisma.projects.findUnique({
      where:  { id: projectId },
      select: { name: true, category: true, description: true, type: true, base_url: true, brd_content: true, existing_tests_content: true, existing_tests_filename: true },
    }),
    prisma.project_integrations.findFirst({
      where:  { project_id: projectId },
      select: { category: true, base_url: true, last_synced_at: true },
    }),
    (prisma as any).project_brd?.findFirst
      ? (prisma as any).project_brd.findFirst({
          where:  { project_id: projectId },
          select: { content: true },
        })
      : null,
    // Fetch Jira config so we can pull stories for context
    prisma.project_integrations.findFirst({
      where:  { project_id: projectId },
      select: { jira_domain: true, jira_email: true, jira_token: true, jira_board_id: true },
    }),
    // Fetch confirmed test-data entities (from web_test_data table).
    // These are GROUND TRUTH — the UI scraper actually navigated to these entity pages
    // and confirmed they exist. Entities like Invoice, Opportunity, Quote, Order, Contract
    // will appear here even if the page crawler (metadata_raw_store) never reached them.
    prisma.$queryRawUnsafe<Array<{ entity_name: string; record_count: number; source_url: string | null }>>(
      `SELECT entity_name, record_count, source_url FROM web_test_data WHERE project_id = $1::uuid ORDER BY entity_name`,
      projectId,
    ).catch(() => [] as Array<{ entity_name: string; record_count: number; source_url: string | null }>),
  ])

  // Parse test-data entities into a clean array for downstream use
  const testDataEntities = (testDataRows ?? []).map(r => ({
    entity_name:  r.entity_name,
    record_count: r.record_count ?? 0,
    source_url:   r.source_url ?? null,
  }))

  const projectCategory = integration?.category ?? project?.category ?? 'unknown'
  const baseUrl         = integration?.base_url ?? project?.base_url ?? ''

  // ── Extract app title from raw crawl pages for domain signal ────────────────
  // The page title (e.g. "d2d-UEM - Unified Endpoint Management") is a very
  // strong domain indicator — extract it to help the LLM reinterpret paths correctly.
  let appTitle = ''
  try {
    const rawForTitle = await prisma.metadata_raw_store.findFirst({
      where:  { project_id: projectId, metadata_type: 'webpage' },
      select: { raw_json: true },
    })
    const pagesForTitle = ((rawForTitle?.raw_json as any)?.pages ?? []) as Array<{ title?: string }>
    // Find the most common non-login page title
    const titleCounts: Record<string, number> = {}
    for (const pg of pagesForTitle) {
      if (pg.title && !pg.title.toLowerCase().includes('login')) {
        titleCounts[pg.title] = (titleCounts[pg.title] || 0) + 1
      }
    }
    const sorted = Object.entries(titleCounts).sort((a, b) => b[1] - a[1])
    if (sorted.length > 0) appTitle = sorted[0][0]
  } catch {
    // Non-critical — proceed without app title
  }

  // ── Build metadata summary: multi-tier priority ──────────────────────────
  //   Tier 1: domain_models with testing_rules (richest — includes page structure)
  //   Tier 2: metadata_normalized structured_json (full page details)
  //   Tier 3: metadata_raw_store page paths (crawled URLs)
  //   Tier 4: metadata_normalized label/object_name (Salesforce object list)
  // Build a project identity header from the project's own fields so the
  // LLM always knows the project domain even without crawled metadata.
  const projectDescLines: string[] = []
  if (project?.description) projectDescLines.push(`PROJECT DESCRIPTION: ${project.description}`)
  if (project?.type)        projectDescLines.push(`PROJECT TYPE: ${project.type}`)
  const projectIdentity = projectDescLines.length > 0
    ? projectDescLines.join('\n') + '\n\n'
    : ''

  let metaSummary = '(no metadata synced yet — run Sync Metadata first)'

  // ── Jira stories context (best-effort) ──────────────────────────────────
  let jiraStoriesSummary = ''
  try {
    if (jiraIntegration?.jira_token && jiraIntegration.jira_domain && jiraIntegration.jira_board_id) {
      const { fernetDecrypt } = await import('../../shared/encryption/fernet.js')
      const token   = fernetDecrypt(jiraIntegration.jira_token)
      const domain  = jiraIntegration.jira_domain
      const boardId = jiraIntegration.jira_board_id
      const authHeader = 'Basic ' + Buffer.from(`${jiraIntegration.jira_email}:${token}`).toString('base64')
      const url = `${domain}/rest/agile/1.0/board/${boardId}/issue?maxResults=50&fields=summary,description,issuetype,status`
      const resp = await fetch(url, {
        headers: { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' },
      })
      if (resp.ok) {
        const data = (await resp.json()) as any
        const issues: any[] = data.issues ?? []
        if (issues.length > 0) {
          const lines = issues.slice(0, 40).map((i: any) => {
            const summary = i.fields?.summary ?? ''
            const desc = typeof i.fields?.description === 'string'
              ? i.fields.description.slice(0, 120)
              : (i.fields?.description?.content ?? [])
                  .flatMap((b: any) => (b.content ?? []).map((c: any) => c.text ?? ''))
                  .join(' ')
                  .slice(0, 120)
            return `  • [${i.key}] ${summary}${desc ? ` — ${desc}` : ''}`
          })
          jiraStoriesSummary = `JIRA STORIES (${issues.length} total):\n${lines.join('\n')}`
          log.info({ projectId, count: issues.length }, '[WORKFLOW] Jira stories loaded for context')
        }
      }
    }
  } catch (jiraErr) {
    log.warn({ jiraErr }, '[WORKFLOW] Jira stories fetch failed — continuing without')
  }

  // ── Tier 1: domain_models with testing_rules ─────────────────────────────
  const domainModels = await prisma.domain_models.findMany({
    where:  { project_id: projectId },
    select: { entity_name: true, actions: true, testing_rules: true },
    take:   300,  // fetch all — we cap later with META_CHAR_BUDGET
  })

  if (domainModels.length > 0) {
    // Deduplicate by pathname — keep the entry with the most testing_rules per path
    const byPath = new Map<string, typeof domainModels[0]>()
    for (const dm of domainModels) {
      let path = dm.entity_name
      try {
        const u = new URL(dm.entity_name)
        path = u.pathname === '/' ? u.hostname : u.pathname
      } catch {
        // Not a URL — use as-is
      }

      // Skip /login entries — session is pre-managed, login isn't a testable flow
      if (path === '/login' || path.endsWith('/login')) continue

      const existing = byPath.get(path)
      const existingRuleCount = existing
        ? (Array.isArray(existing.testing_rules) ? (existing.testing_rules as unknown[]).length : 0)
        : 0
      const newRuleCount = Array.isArray(dm.testing_rules) ? (dm.testing_rules as unknown[]).length : 0
      if (!existing || newRuleCount > existingRuleCount) {
        byPath.set(path, dm)
      }
    }

    log.info({
      projectId,
      totalDomainModels: domainModels.length,
      uniquePaths: byPath.size,
      filteredLoginEntries: domainModels.length - byPath.size,
    }, '[WORKFLOW] Domain models deduplicated')

    // Group domain models by readable module/entity name
    const lines: string[] = []

    for (const [path, dm] of byPath) {
      const label = path

      const actions = Array.isArray(dm.actions) ? (dm.actions as string[]) : []
      const rules   = Array.isArray(dm.testing_rules)
        ? (dm.testing_rules as Record<string, unknown>[])
        : []

      // Extract field names from testing_rules for rich context
      const fields = rules
        .filter(r => r['field'] && typeof r['field'] === 'string')
        .map(r => String(r['field']))
        .filter(Boolean)
        .slice(0, 12)

      const buttons = rules
        .filter(r => r['button'] && typeof r['button'] === 'string')
        .map(r => String(r['button']))
        .filter(Boolean)
        .slice(0, 8)

      let line = `  • ${label}`
      if (actions.length > 0) line += ` [actions: ${actions.slice(0, 6).join(', ')}]`
      if (fields.length  > 0) line += `\n    fields: ${fields.join(', ')}`
      if (buttons.length > 0) line += `\n    buttons: ${buttons.join(', ')}`
      lines.push(line)
    }

    const rawMeta = `${projectIdentity}APPLICATION MODULES & PAGES (from crawl metadata, ${byPath.size} pages):\n${lines.join('\n')}`
    metaSummary = capMeta(rawMeta)

  } else {
    // ── Tier 2: metadata_normalized structured_json ───────────────────────
    const normalizedRows = await prisma.metadata_normalized.findMany({
      where:  { project_id: projectId },
      select: { object_name: true, entity_type: true, label: true, structured_json: true },
      take:   10,
    })

    if (normalizedRows.length > 0) {
      const lines: string[] = ['APPLICATION MODULES & PAGES (from normalized metadata):']

      for (const row of normalizedRows) {
        const sj = (row.structured_json ?? {}) as Record<string, unknown>
        const pages = Array.isArray(sj['pages'])
          ? (sj['pages'] as Record<string, unknown>[]).slice(0, 80)
          : []

        if (pages.length > 0) {
          for (const page of pages) {
            const path    = String(page['path'] ?? page['url'] ?? '/')
            const title   = page['title'] ? ` ("${String(page['title'])}")` : ''
            const inputs  = (Array.isArray(page['inputs'])  ? page['inputs']  : []) as Record<string, unknown>[]
            const selects = (Array.isArray(page['selects']) ? page['selects'] : []) as Record<string, unknown>[]
            const buttons = (Array.isArray(page['buttons']) ? page['buttons'] : []) as Record<string, unknown>[]

            const fieldNames  = inputs.map(i  => String(i['name'] ?? i['locator'] ?? '')).filter(Boolean).slice(0, 8)
            const selectNames = selects.map(s  => String(s['name'] ?? s['locator'] ?? '')).filter(Boolean).slice(0, 6)
            const buttonNames = buttons.map(b  => String(b['name'] ?? b['locator'] ?? '')).filter(Boolean).slice(0, 6)

            let line = `  • ${path}${title}`
            if (fieldNames.length  > 0) line += `\n    inputs: ${fieldNames.join(', ')}`
            if (selectNames.length > 0) line += `\n    selects: ${selectNames.join(', ')}`
            if (buttonNames.length > 0) line += `\n    buttons: ${buttonNames.join(', ')}`
            lines.push(line)
          }
        } else {
          // Salesforce or API integration: just list object names
          lines.push(`  • ${row.label ?? row.object_name}`)
        }
      }

      metaSummary = capMeta(projectIdentity + lines.join('\n'))

    } else {
      // ── Tier 3: raw crawl page list ────────────────────────────────────
      const rawRow = await prisma.metadata_raw_store.findFirst({
        where:  { project_id: projectId, metadata_type: 'webpage' },
        select: { raw_json: true },
      })
      const rawPages = ((rawRow?.raw_json as any)?.pages ?? []) as Array<{
        path?: string; url?: string; title?: string
        inputs?: unknown[]; buttons?: unknown[]; selects?: unknown[]
      }>

      if (rawPages.length > 0) {
        const lines = [`CRAWLED PAGES (from raw metadata, ${rawPages.length} total):`]
        for (const p of rawPages.slice(0, 100)) {
          const path  = p.path ?? p.url ?? '?'
          const title = p.title ? ` ("${p.title}")` : ''
          const inputs  = (Array.isArray(p.inputs)  ? p.inputs  : []) as Record<string, unknown>[]
          const buttons = (Array.isArray(p.buttons) ? p.buttons : []) as Record<string, unknown>[]
          const fieldNames  = inputs.map((i: any) => String(i['name'] ?? i['locator'] ?? '')).filter(Boolean).slice(0, 6)
          const buttonNames = buttons.map((b: any) => String(b['name'] ?? b['locator'] ?? '')).filter(Boolean).slice(0, 4)
          let line = `  • ${path}${title}`
          if (fieldNames.length  > 0) line += `\n    inputs: ${fieldNames.join(', ')}`
          if (buttonNames.length > 0) line += `\n    buttons: ${buttonNames.join(', ')}`
          lines.push(line)
        }
        metaSummary = capMeta(projectIdentity + lines.join('\n'))
      } else {
        // ── Tier 4: Salesforce object list fallback ─────────────────────
        const normalised = await prisma.metadata_normalized.findMany({
          where:  { project_id: projectId },
          take:   40,
          select: { object_name: true, entity_type: true, label: true },
        })
        if (normalised.length > 0) {
          metaSummary = projectIdentity + 'SALESFORCE OBJECTS:\n' +
            normalised.map(n => `  • ${n.label ?? n.object_name}`).join('\n')
        } else if (projectIdentity) {
          // No crawled metadata at all but we have project description/type —
          // use that so the LLM can infer the correct domain.
          metaSummary = projectIdentity + '(no crawled metadata available — derive workflows from the project description above)'
          log.warn({ projectId }, '[WORKFLOW] No metadata found — using project description for context')
        }
      }
    }
  }

  // ── Append integration type header for LLM context ──────────────────────────────────────────────────
  const appTitleLine = appTitle ? `APPLICATION TITLE: ${appTitle}\n` : ''
  const integrationHeader = baseUrl
    ? `INTEGRATION TYPE: ${projectCategory.toUpperCase()} | BASE URL: ${baseUrl}\n${appTitleLine}\n`
    : `INTEGRATION TYPE: ${projectCategory.toUpperCase()}\n${appTitleLine}\n`

  // ── Build per-page UI constraints from raw crawl metadata ────────────────
  // This gives prompts a project-agnostic inventory of what's ACTUALLY clickable/typeable
  // on each page, preventing hallucinated steps like "Click Add Charges" on a list page.
  let pageConstraints = ''
  try {
    const rawRow = await prisma.metadata_raw_store.findFirst({
      where:  { project_id: projectId, metadata_type: 'webpage' },
      select: { raw_json: true },
    })
    const rawPages = ((rawRow?.raw_json as any)?.pages ?? []) as Array<{
      path?: string; url?: string; title?: string
      buttons?: Array<{ name?: string }>
      inputs?: Array<{ name?: string; required?: boolean }>
      selects?: Array<{ name?: string }>
    }>

    // Only include pages that are NOT 404 / error pages
    const validPages = rawPages.filter(p => {
      const title = (p.title ?? '').toLowerCase()
      return !title.includes('404') &&
             !title.includes('not found') &&
             !title.includes('could not be found') &&
             !title.includes('page not found')
    }).map(p => ({
      path:    p.path ?? p.url ?? '/',
      buttons: p.buttons ?? [],
      inputs:  p.inputs  ?? [],
      selects: p.selects ?? [],
    }))

    // Deduplicate by path (keep first occurrence — they're usually identical)
    const seenPaths = new Set<string>()
    const dedupedPages = validPages.filter(p => {
      if (seenPaths.has(p.path)) return false
      seenPaths.add(p.path)
      return true
    })

    if (dedupedPages.length > 0) {
      pageConstraints = buildPageUIConstraints(dedupedPages)
      log.info({ projectId, pageCount: dedupedPages.length }, '[WORKFLOW] Page UI constraints built from raw metadata')
    }
  } catch (err) {
    log.warn({ err }, '[WORKFLOW] Failed to build page UI constraints — continuing without')
  }

  // Use BRD content from: 1) dedicated brd table, 2) project.brd_content column
  const resolvedBrd = brdRow?.content ?? project?.brd_content ?? ''

  // Existing tests content — stored on the project row
  const resolvedExistingTests = project?.existing_tests_content ?? ''

  // ── Inject confirmed test-data entities into metadata summary ─────────────
  // These are the DEFINITIVE entity list — the scraper confirmed they exist.
  // They MUST appear in the metadata summary so the LLM generates workflows
  // for ALL of them (Invoice, Opportunity, Quote, Order, Contract, etc.).
  let testDataSection = ''
  if (testDataEntities.length > 0) {
    const entityLines = testDataEntities.map(e => {
      const recordInfo = e.record_count > 0 ? ` (${e.record_count} records)` : ' (entity page confirmed, 0 records)'
      return `  • ${e.entity_name}${recordInfo}`
    })
    testDataSection = `\n\nCONFIRMED APPLICATION ENTITIES (${testDataEntities.length} entities discovered via UI scraping — GROUND TRUTH):
The following entities were confirmed by navigating to their pages in the live application.
You MUST generate at least one workflow for EVERY entity listed below.
Do NOT skip any entity — each one represents a real, navigable module in the application.
${entityLines.join('\n')}`
    log.info({ projectId, entityCount: testDataEntities.length, entities: testDataEntities.map(e => e.entity_name) },
      '[WORKFLOW] Test-data entities injected into metadata summary')
  }

  // Append Jira stories + test-data entities to the metadata summary (within budget)
  const jiraSection = jiraStoriesSummary ? `\n\n${jiraStoriesSummary}` : ''
  const fullMeta = capMeta(integrationHeader + metaSummary + testDataSection + jiraSection)

  log.info({
    projectId,
    projectName: project?.name,
    appTitle,
    hasDescription: !!project?.description,
    metaSummaryLength: fullMeta.length,
    hasBrd: !!resolvedBrd,
    hasExistingTests: !!resolvedExistingTests,
    hasJiraStories: !!jiraStoriesSummary,
    testDataEntityCount: testDataEntities.length,
    pageConstraintsLength: pageConstraints.length,
  }, '[WORKFLOW] Project context resolved')

  return {
    projectName:          project?.name ?? 'Unknown Project',
    projectCategory,
    metadataSummary:      fullMeta,
    brdContent:           resolvedBrd,
    existingTestsContent: resolvedExistingTests,
    pageConstraints,
    testDataEntities,
  }
}

// ─── Phase 1: Generate Business Flows ────────────────────────────────────────

export interface BusinessFlow {
  name:        string
  description: string   // 1–2 sentence explanation of what the flow tests
}

export async function generateBusinessFlows(
  projectId: string,
  brdContent?: string,
): Promise<{ flows: BusinessFlow[] }> {
  const ctx = await getProjectContext(projectId)
  const brd = decodeDocContent(brdContent ?? ctx.brdContent, 15000)
  const existingTests = decodeDocContent(ctx.existingTestsContent)

  // ── Detect crawler-unreachable BRD entities (project-agnostic) ─────────────
  // Parse ALL entities from the BRD (any domain — CRM, Logistics, ERP, Healthcare…)
  const brdEntities = parseBrdEntities(brd)

  // Extract crawled page paths from metadata summary for comparison
  const crawledPaths: string[] = []
  for (const line of ctx.metadataSummary.split('\n')) {
    // Matches "  • /invoices [LIST]" or "  • /opportunities/new [FORM]" etc.
    const pathMatch = line.match(/•\s+(\/[^\s\[]+)/)
    if (pathMatch) crawledPaths.push(pathMatch[1])
  }

  // Find entities in BRD that the crawler never reached
  const { orphaned: orphanedEntities } = detectOrphanedBrdEntities(brdEntities, crawledPaths)

  // Build the injection block for the prompt
  const orphanedBlock = buildOrphanedEntitiesBlock(orphanedEntities)

  log.info({
    projectId,
    brdEntityCount:    brdEntities.size,
    crawledPathCount:  crawledPaths.length,
    orphanedCount:     orphanedEntities.length,
    orphanedEntities,
  }, '[WORKFLOW] BRD entity analysis complete')

  const systemPrompt = `You are an expert QA Architect with deep knowledge of software testing across all domains.

Your task: generate a COMPREHENSIVE list of BUSINESS FLOWS for the project described below.
You MUST pay close attention to the PROJECT NAME, DESCRIPTION, and TYPE to understand what domain this application belongs to.
Do NOT default to CRM/Sales flows unless the metadata explicitly shows CRM entities.
A Business Flow is a complete end-to-end user journey that tests real business value — not a single page or button.

CRITICAL CONSTRAINT: You MUST derive ALL flows from TWO primary sources:
1. The crawled METADATA below (pages, fields, buttons, actions)
2. The BRD / SPECIFICATION document (business modules, rules, and user journeys)
If a module or entity is documented in the BRD but NOT in the crawled metadata,
you MUST still generate flows for it — use the BRD field/entity details to construct the workflow steps.
Do NOT invent modules that appear in NEITHER the metadata NOR the BRD.

PROJECT: ${ctx.projectName}
${ctx.metadataSummary}
${brd ? `\nBRD / SPECIFICATION (PRIMARY SOURCE — use this to identify ALL business modules, rules, and user journeys):\n${brd.slice(0, 12000)}` : ''}
${existingTests ? `\nEXISTING TEST CASES / TEST PATTERNS (use to ensure coverage gaps are filled):\n${existingTests.slice(0, 3000)}` : ''}

METADATA INTERPRETATION GUIDE:
- "fields:" lines = actual form fields you can interact with on that page
- "buttons:" lines = actual clickable actions available
- "actions:" lines = what operations are possible (fill_form, submit_form, click_button, etc.)
- "inputs:" / "selects:" = form controls available on that specific page
- Button labels with descriptions (e.g. "Enquiries - Manage freight enquiries") indicate navigation modules — generate flows for these modules.

BRD-SOURCED MODULE DISCOVERY:
- If the BRD defines modules (e.g., "Enquiries Module", "Quotations Module", "Bookings Module")
  that have no corresponding crawled metadata page, you MUST STILL generate workflows for them.
- Use the BRD field descriptions, status values, validation rules, and business rules to construct realistic flows.
- For BRD-sourced modules, include:
  a) Create flow — using the BRD required fields and validation rules
  b) Update flow — using the BRD editable fields and change tracking requirements
  c) Status transition flows — using the BRD status values (e.g., NEW, UNDER REVIEW, QUOTED, CLOSED)
  d) Cross-module pipeline flows — linking related modules (e.g., Enquiry to Quotation to Booking)
- Mark BRD-sourced flows in the description with the relevant BRD section for traceability.

UI GROUNDING RULE (applies to every project):
The following PAGE UI INVENTORY shows what is ACTUALLY available in the application.
Before generating a workflow, check this inventory:
- Pages labelled [LIST] show records only. Only generate NAVIGATE + VIEW DETAIL flows for them,
  unless they also have a "New"/"Create" button listed — in which case also generate a create flow.
- Pages labelled [FORM] have input fields — generate create/edit flows using only the listed fields.
- Do NOT invent UI actions (buttons, form fields) that are not listed in the PAGE UI INVENTORY below.
- If a BRD describes a feature (e.g. "Add Charges") but the corresponding page shows no such button,
  that feature is SYSTEM-AUTOMATED — represent it as a VERIFY step (system result), not a user action.
${ctx.pageConstraints ? `\n${ctx.pageConstraints}` : '(No crawled page data yet — derive flows from BRD and project description only.)'}
${orphanedBlock}
CRITICAL DOMAIN AWARENESS:
- The APPLICATION TITLE and PROJECT NAME tell you what kind of application this is.
- If the APPLICATION TITLE says "UEM" or "Endpoint Management" this is a device/asset management tool, NOT a CRM.
- If the APPLICATION TITLE says "ERP" interpret modules as inventory, procurement, HR, etc.
- URL paths MUST be interpreted in the context of the application actual domain:
  In a UEM app: /accounts = organizational units, /contacts = managed devices/endpoints, /leads = device onboarding requests
  In an ERP app: /leads = procurement leads, /contacts = vendors/suppliers
  In a CRM app: /leads = sales leads, /contacts = customers
  In a Logistics/Freight app: /enquiries = freight enquiries, /quotations = rate quotations, /bookings = shipment bookings
- ALWAYS name your flows using the REAL DOMAIN terminology of this specific application.
  GOOD for UEM: "Enroll New Device via /contacts/new", "Register Organizational Unit via /accounts/create"
  GOOD for Freight: "Create Freight Enquiry with Container Details", "Generate Quotation from Enquiry"
  BAD: "Create New Contact" (generic CRM language for a UEM app)

MANDATORY GENERATION RULES:
1. Generate flows for EVERY distinct page/entity/module visible in EITHER the metadata OR the BRD.
   - For web apps: use the page paths AND navigation button labels as your module list.
   - ADDITIONALLY: scan the BRD for modules, entities, or sections that describe functionality
     not covered by crawled pages — generate flows for those as well.
   - For Salesforce: use the listed objects — only generate flows for those objects.
   - For APIs: generate flows based on available endpoints and data entities.

2. For each module with form fields, include the lifecycle — BUT only confirmed actions:
   a) Create flow — fill required fields and submit the form
   b) Edit/update flow — find an existing record and modify key fields
   c) Delete/archive flow — ONLY if a delete/archive button is confirmed in metadata or BRD
   d) Cross-module flow — ONLY if a relationship between entities is documented in the metadata or BRD

3. Use the actual field names from metadata or BRD to make flows specific.
   GOOD: "Register New Asset with Name, IP Address and OS Version"
   GOOD: "Create Enquiry with place_of_receipt, port_of_loading and Container Details"
   GOOD: "Create New Record with all Required Fields on /accounts/create"
   BAD:  "Fill form and submit" — too vague

4. Include flows that cover the buttons listed in metadata.
   If "Approve" button exists include an approval flow.
   If "Send Invoice" button exists include an invoice sending flow.
   If "Enquiries" navigation button exists include enquiry CRUD flows.

5. Include edge-case flows:
   - Required field validation (submit form with missing required fields)
   - Duplicate record detection
   - Permission / access control (if roles are indicated)

6. DO NOT generate flows for entities NOT present in EITHER the metadata OR the BRD.
   If neither the metadata NOR the BRD mentions an entity, do NOT generate a flow for it.

7. REJECT generic/vague flows:
   - "Verify UI is working" — REJECTED
   - "Test the dashboard" — REJECTED
   - "User login" — REJECTED (session is pre-managed)
   - "Verify navigation" — REJECTED

8. Flow naming rules:
   - 4-9 words, action-oriented, entity-specific, verb-first
   GOOD: "Create Lead and Convert to Opportunity"
   GOOD: "Submit Invoice and Mark as Paid"
   GOOD: "Validate Required Fields on Account Creation Form"
   GOOD: "Create Freight Enquiry with Container Validation"
   BAD:  "Test CRM Features" — too generic

9. Generate 15-40 flows total — one per distinct page/entity in the metadata + BRD, plus cross-module flows. Prioritise business-critical journeys first.

10. For each flow write a 1-2 sentence description that names:
    - The specific page/module/entity involved (using exact names from metadata or BRD)
    - The business outcome validated

11. ANTI-HALLUCINATION RULE (CRITICAL — violations make tests non-executable):
    Do NOT invent business processes, statuses, actions, or workflows from your general industry knowledge.
    ONLY use processes and actions that are EXPLICITLY documented in:
      - The crawled metadata (page paths, buttons, fields)
      - The BRD / specification document
      - The CONFIRMED APPLICATION ENTITIES list
    Examples of HALLUCINATED flows (REJECTED):
      - "Place Order and Verify Fulfillment" — REJECTED if "fulfillment" is not in the metadata or BRD
      - "Process Payment and Verify Receipt" — REJECTED if "receipt" is not in the metadata or BRD
      - "Ship Order and Track Delivery" — REJECTED if "shipping" or "delivery" is not in the metadata or BRD
      - "Approve Invoice and Generate Tax Report" — REJECTED if "tax report" is not in the metadata or BRD
    If in doubt, generate only CREATE and UPDATE flows for the entity — those are always safe.

Return ONLY valid JSON with this exact shape (no markdown, no prose):
{
  "flows": [
    {
      "name": "Concise action-oriented flow name",
      "description": "1-2 sentences describing what this flow tests and why it matters for the business."
    }
  ]
}`

  const llm    = buildDiscoveryLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    // Build a domain reminder for the human turn so the LLM stays on track
    const appTitleHint = ctx.metadataSummary.includes('APPLICATION TITLE:')
      ? ctx.metadataSummary.split('\n').find(l => l.startsWith('APPLICATION TITLE:')) ?? ''
      : ''
    const domainReminder = appTitleHint
      ? `Remember: ${appTitleHint}. Name all flows using the correct domain terminology for this application type, NOT generic CRM terms.`
      : 'Name all flows using correct domain terminology for this application type.'

    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`Generate the complete business flow list now. Return ONLY valid JSON — no markdown fences, no explanation. ${domainReminder}`),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{')
    const lastBrace  = jsonStr.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1)
    }
    const parsed = JSON.parse(jsonStr)
    const flows: BusinessFlow[] = (Array.isArray(parsed.flows) ? parsed.flows : [])
      .filter((f: any) => f && typeof f.name === 'string' && f.name.trim())
      .map((f: any) => ({
        name:        String(f.name).trim(),
        description: String(f.description ?? '').trim(),
      }))

    // ── Post-generation gap-fill (project-agnostic safety net) ────────────────
    // Use BOTH sources for gap detection:
    //   1. BRD entities (parsed from document)
    //   2. Test-data entities (ground truth — scraper confirmed they exist)
    // Every entity from EITHER source that has no matching flow gets a fallback CRUD flow.
    const allKnownEntities = new Set(brdEntities)
    for (const tde of ctx.testDataEntities) {
      allKnownEntities.add(tde.entity_name)
    }

    const gapFilled = gapFillMissingEntityFlows(flows, allKnownEntities)
    if (gapFilled.length > flows.length) {
      log.info(
        { injectedCount: gapFilled.length - flows.length, total: gapFilled.length,
          brdEntityCount: brdEntities.size, testDataEntityCount: ctx.testDataEntities.length },
        '[WORKFLOW] Gap-fill injected flows for entities missed by LLM (from BRD + test-data)',
      )
    }

    // ── Domain-aware relabeling for UEM apps ─────────────────────────────────
    // If the app title indicates UEM/Endpoint Management, replace CRM terminology
    // in flow names/descriptions with proper UEM domain language.
    const summary = ctx.metadataSummary.toLowerCase()
    const isUEM = summary.includes('unified endpoint management') || summary.includes('uem') ||
                  summary.includes('endpoint management') || summary.includes('mdm')

    const relabeledFlows = isUEM
      ? flows.map(f => ({
          name: f.name
            .replace(/\bLead\b/gi, 'Device Onboarding Request')
            .replace(/\bLeads\b/gi, 'Device Onboarding Requests')
            .replace(/\bContact\b/gi, 'Managed Endpoint')
            .replace(/\bContacts\b/gi, 'Managed Endpoints')
            .replace(/\bAccount\b/gi, 'Organizational Unit')
            .replace(/\bAccounts\b/gi, 'Organizational Units')
            .replace(/\bOpportunity\b/gi, 'Deployment Opportunity')
            .replace(/\bOpportunities\b/gi, 'Deployment Opportunities')
            .replace(/\bCampaign\b/gi, 'Device Policy Campaign')
            .replace(/\bCampaigns\b/gi, 'Device Policy Campaigns')
            .replace(/\bContract\b/gi, 'License Agreement')
            .replace(/\bContracts\b/gi, 'License Agreements')
            .replace(/\bQuote\b/gi, 'Service Quote')
            .replace(/\bQuotes\b/gi, 'Service Quotes'),
          description: f.description
            .replace(/\blead\b/gi, 'device onboarding request')
            .replace(/\bcontact\b/gi, 'managed endpoint')
            .replace(/\baccount\b/gi, 'organizational unit')
            .replace(/\bopportunity\b/gi, 'deployment opportunity')
            .replace(/\bcampaign\b/gi, 'device policy campaign')
            .replace(/\bcontract\b/gi, 'license agreement'),
        }))
      : flows

    return { flows: relabeledFlows.length > flows.length ? relabeledFlows : gapFilled.map(f => ({
      name: f.name
        .replace(/\bLead\b/gi, isUEM ? 'Device Onboarding Request' : 'Lead')
        .replace(/\bLeads\b/gi, isUEM ? 'Device Onboarding Requests' : 'Leads')
        .replace(/\bContact\b/gi, isUEM ? 'Managed Endpoint' : 'Contact')
        .replace(/\bContacts\b/gi, isUEM ? 'Managed Endpoints' : 'Contacts')
        .replace(/\bAccount\b/gi, isUEM ? 'Organizational Unit' : 'Account')
        .replace(/\bAccounts\b/gi, isUEM ? 'Organizational Units' : 'Accounts')
        .replace(/\bOpportunity\b/gi, isUEM ? 'Deployment Opportunity' : 'Opportunity')
        .replace(/\bOpportunities\b/gi, isUEM ? 'Deployment Opportunities' : 'Opportunities')
        .replace(/\bCampaign\b/gi, isUEM ? 'Device Policy Campaign' : 'Campaign')
        .replace(/\bCampaigns\b/gi, isUEM ? 'Device Policy Campaigns' : 'Campaigns')
        .replace(/\bContract\b/gi, isUEM ? 'License Agreement' : 'Contract')
        .replace(/\bContracts\b/gi, isUEM ? 'License Agreements' : 'Contracts')
        .replace(/\bQuote\b/gi, isUEM ? 'Service Quote' : 'Quote')
        .replace(/\bQuotes\b/gi, isUEM ? 'Service Quotes' : 'Quotes'),
      description: f.description,
    })) }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Failed to generate business flows')
    return { flows: [] }
  }
}

// ─── Phase 2: Refinement Chat ─────────────────────────────────────────────────

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export interface WorkflowChatResponse {
  reply:         string
  /** true when the AI has gathered enough info and recommends generating */
  readyToGenerate: boolean
  /** structured workflow scope — populated when readyToGenerate=true */
  workflowScope?: {
    flow:          string
    actors:        string[]
    preconditions: string[]
    steps:         string[]
    edgeCases:     string[]
  }
}

export async function workflowRefinementChat(params: {
  projectId:   string
  flow:        string
  history:     ChatMessage[]
  userMessage: string
  brdContent?: string
}): Promise<WorkflowChatResponse> {
  const { projectId, flow, history, userMessage, brdContent } = params
  const ctx = await getProjectContext(projectId)
  const brd = decodeDocContent(brdContent ?? ctx.brdContent)
  const existingTests = decodeDocContent(ctx.existingTestsContent)

  const historyText = history
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'You' : 'AI'}: ${m.content}`)
    .join('\n')

  const exchangeCount = history.filter(m => m.role === 'user').length

  const systemPrompt = `You are an expert QA Analyst. Your goal is to QUICKLY set up test generation scope — do NOT over-question the user.

PROJECT: ${ctx.projectName}
SELECTED BUSINESS FLOW: "${flow}"
AVAILABLE METADATA (pages / entities):
${ctx.metadataSummary}
${ctx.pageConstraints ? `\nPAGE UI INVENTORY (confirmed elements per page — use to scope test steps accurately):\n${ctx.pageConstraints}` : ''}
${brd ? `\nBRD:\n${brd.slice(0, 3000)}` : ''}
${existingTests ? `\nEXISTING TEST PATTERNS (for context):\n${existingTests.slice(0, 1500)}` : ''}

CONVERSATION SO FAR:
${historyText || '(this is the very first message)'}
USER EXCHANGE COUNT: ${exchangeCount}

══════════════════════════════════════════════════
STRICT AGENT RULES (must follow in order):
══════════════════════════════════════════════════

RULE 1 — PROCEED INTENT: If the user's message contains any of the following signals, you MUST immediately set "readyToGenerate": true with no more questions:
  Keywords: proceed, generate, start, go, next, skip, yes, ok, okay, sure, continue, let's go, create, build, ready, enough, fine, all good, sounds good, just generate, do it
  Short affirmative responses: "admin", "all roles", "standard", "default", any 1-3 word answer to your earlier question

RULE 2 — EXCHANGE LIMIT: If exchangeCount >= 1 (user has already replied once), ALWAYS set "readyToGenerate": true. Never ask a 3rd question.

RULE 3 — FIRST MESSAGE: If exchangeCount === 0, ask AT MOST ONE optional context question, max 15 words. Frame it so skipping is easy. Example: "Any specific role or scenario to focus on, or generate a full suite?"

RULE 4 — AUTO-DERIVE: Use the flow name and metadata to infer ALL workflowScope fields. Do NOT ask the user to list steps, preconditions, actors, or edge cases separately.

══════════════════════════════════════════════════

Respond with ONLY valid JSON, no prose:

If still gathering (first exchange only, no proceed intent):
{"reply": "<single optional question, max 15 words>", "readyToGenerate": false}

If ready (any other case — default to this):
{
  "reply": "Got it! Generating a comprehensive test suite for \\"${flow}\\" now.",
  "readyToGenerate": true,
  "workflowScope": {
    "flow": "${flow}",
    "actors": ["<infer from flow + metadata>"],
    "preconditions": ["<infer>"],
    "steps": ["<infer key steps>"],
    "edgeCases": ["<infer common edge cases>"]
  }
}`

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`User says: "${userMessage}"\n\nRespond with ONLY valid JSON.`),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(jsonStr)
    return {
      reply:           parsed.reply ?? 'Ready to generate your test cases!',
      readyToGenerate: !!parsed.readyToGenerate,
      workflowScope:   parsed.workflowScope,
    }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Refinement chat LLM error')
    return { reply: 'I had trouble processing that. Could you rephrase?', readyToGenerate: false }
  }
}

// ─── Phase 3: Test-Case Filter Chat ───────────────────────────────────────────

export interface TestCaseSummary {
  id:       string
  name:     string
  priority: string
  description?: string | null
}

export interface FilterChatResponse {
  reply:       string
  /** IDs to keep selected */
  selectedIds: string[]
  /** human-readable explanation of what was filtered */
  summary:     string
}

export async function filterTestCasesChat(params: {
  instruction: string
  history:     ChatMessage[]
  testCases:   TestCaseSummary[]
  currentSelectedIds: string[]
}): Promise<FilterChatResponse> {
  const { instruction, history, testCases, currentSelectedIds } = params

  const tcList = testCases.map((tc, i) =>
    `${i + 1}. [${tc.id}] ${tc.name} (priority: ${tc.priority})${tc.description ? ` — ${tc.description.slice(0, 80)}` : ''}`
  ).join('\n')

  const historyText = history.slice(-8)
    .map(m => `${m.role === 'user' ? 'You' : 'AI'}: ${m.content}`)
    .join('\n')

  const systemPrompt = `You are an AI assistant helping a QA engineer review and filter a generated list of test cases.
The user can say things like:
  - "Keep only High priority tests"
  - "Remove all login-related tests"
  - "Select only the edge cases"
  - "Deselect everything related to payments"
  - "Select all"
  - "I want tests 1, 3, and 5"

AVAILABLE TEST CASES (full list):
${tcList}

CURRENTLY SELECTED IDs: ${JSON.stringify(currentSelectedIds)}

CONVERSATION HISTORY:
${historyText || '(start)'}

Based on the user's instruction, determine which test case IDs should be selected.
If the instruction is ambiguous, make your best interpretation and explain it.

Respond with ONLY valid JSON:
{
  "reply": "Your conversational response explaining what you did",
  "selectedIds": ["id1", "id2", ...],
  "summary": "X of Y tests selected — kept all High priority tests"
}`

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  let raw = ''
  try {
    raw = await llm.pipe(parser).invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(`User: "${instruction}"\n\nRespond with ONLY valid JSON.`),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    }
    const parsed = JSON.parse(jsonStr)
    const validIds = (parsed.selectedIds ?? []).filter((id: string) => testCases.some(tc => tc.id === id))
    return {
      reply:       parsed.reply ?? 'Done.',
      selectedIds: validIds,
      summary:     parsed.summary ?? `${validIds.length} tests selected`,
    }
  } catch (err) {
    log.error({ err, raw }, '[WORKFLOW] Filter chat LLM error')
    return {
      reply:       'I had trouble understanding that. Please try again.',
      selectedIds: currentSelectedIds,
      summary:     `${currentSelectedIds.length} tests selected (unchanged)`,
    }
  }
}
// ─── Phase 4: Multi-Flow Test Suite Generation ────────────────────────────────
// Generates test cases grouped by business flow and orders them for optimal
// sequential execution (e.g. setup flows first, teardown flows last).

export interface FlowTestCase {
  name: string
  description: string | null
  priority: string
  steps: unknown[]
  tags?: string[]
}

export interface FlowGroup {
  flow: string
  order: number
  rationale: string
  testCases: (FlowTestCase & { id?: string })[]
}

export interface GenerateTestSuiteResult {
  groups: FlowGroup[]
  totalTestCases: number
}

/**
 * Words that commonly appear in flow names but are NOT entity names.
 * Used by extractPrimaryEntityFromFlow and generateFallbackTestCases.
 */
const FLOW_STOP_WORDS = new Set([
  'create','update','edit','delete','view','add','manage','verify','test','check',
  'and','or','link','to','with','for','from','new','a','an','the','record','records',
  'successfully','on','off','without','all','using','based','existing','multiple',
  'successful','ensure','confirm','validate','show','display','missing','required',
  'fields','field','validation','error','errors','message','messages','alert','alerts',
  'form','page','module','feature','settings','list','management','flow','workflow',
  'process','handling','operations','operation','via','by','when','where','that',
  // Search/filter/view/navigation verbs — NEVER entity names
  'search','filter','find','sort','browse','navigate','access','open','close',
  'reset','clear','apply','column','columns','results','result','criteria',
])

/**
 * Extracts the PRIMARY entity name from a flow name by stripping verbs,
 * adjectives, and common descriptive words.  Returns the first meaningful
 * content word (Title-cased), or the first token of the flow name as fallback.
 *
 * Examples:
 *   "Create Lead and Verify Validation on Missing Required Fields" → "Lead"
 *   "Account Management" → "Account"
 *   "Delete Contract"    → "Contract"
 */
function extractPrimaryEntityFromFlow(flowName: string): string {
  for (const word of flowName.split(/\s+/)) {
    const clean = word.replace(/[^a-zA-Z]/g, '')
    if (clean.length > 2 && !FLOW_STOP_WORDS.has(clean.toLowerCase())) {
      return clean.charAt(0).toUpperCase() + clean.slice(1)
    }
  }
  // Fallback: strip known suffixes and return first token
  return (flowName.replace(/\s*(Management|List|Module|Feature|Settings)$/i, '').trim().split(/\s+/)[0] ?? flowName)
}

export async function generateTestSuite(params: {
  projectId:  string
  flows:      string[]
  brdContent?: string
}): Promise<GenerateTestSuiteResult> {
  const { projectId, flows, brdContent } = params
  const ctx = await getProjectContext(projectId)
  const brd = decodeDocContent(brdContent ?? ctx.brdContent, 15000)
  const existingTests = decodeDocContent(ctx.existingTestsContent)

  const llm    = buildLlm()
  const parser = new StringOutputParser()

  // ── Step 1: Ask LLM to order the flows for optimal execution ─────────────────
  let orderedFlows: Array<{ flow: string; order: number; rationale: string }> = flows.map((f, i) => ({
    flow: f, order: i + 1, rationale: 'User-specified order',
  }))

  try {
    const orderPrompt = `You are a QA Architect. Given these business flows for the project "${ctx.projectName}", 
order them optimally for sequential test execution (prerequisite flows first, cleanup/teardown flows last).
FLOWS TO ORDER:
${flows.map((f, i) => `${i + 1}. ${f}`).join('\n')}

METADATA CONTEXT:
${ctx.metadataSummary.slice(0, 1000)}

Return ONLY valid JSON:
{
  "ordered": [
    { "flow": "exact flow name", "order": 1, "rationale": "why this comes first (max 10 words)" },
    ...
  ]
}`
    const raw = await llm.pipe(parser).invoke([
      new SystemMessage(orderPrompt),
      new HumanMessage('Order the flows now. Return ONLY valid JSON.'),
    ])
    let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
    const fb = jsonStr.indexOf('{'); const lb = jsonStr.lastIndexOf('}')
    if (fb !== -1 && lb !== -1) jsonStr = jsonStr.slice(fb, lb + 1)
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed.ordered)) {
      const selectedFlowNamesSet = new Set(flows.map((f) => f.toLowerCase().trim()))
      const llmOrdered: Array<{ flow: string; order: number; rationale: string }> =
        parsed.ordered.filter((x: any) => x.flow && x.order && selectedFlowNamesSet.has(x.flow.toLowerCase().trim()))

      // Ensure ALL originally-selected flows are present — the LLM may drop some.
      // Build a lookup of flows already returned by the LLM (case-insensitive match).
      const llmFlowNames = new Set(llmOrdered.map((x) => x.flow.toLowerCase().trim()))
      const nextOrder = llmOrdered.length + 1
      const missingFlows = flows
        .filter((f) => !llmFlowNames.has(f.toLowerCase().trim()))
        .map((f, i) => ({
          flow:      f,
          order:     nextOrder + i,
          rationale: 'User-selected flow (appended — not returned by ordering LLM)',
        }))

      orderedFlows = [...llmOrdered, ...missingFlows]

      if (missingFlows.length > 0) {
        log.warn(
          { missingFlows: missingFlows.map((x) => x.flow) },
          '[SUITE] LLM dropped flows during ordering — appended them at end',
        )
      }
    }
  } catch (err) {
    log.warn({ err }, '[SUITE] Flow ordering failed — using default order')
  }

  // ── Step 2: Generate test cases per flow in parallel ────────────────────────
  // Generate at least 8 and up to 15 test cases per flow regardless of flow count.
  // A higher token budget (8192) means Tier 1/2 can reliably return the full set.
  const PER_FLOW_COUNT = Math.min(Math.max(8, Math.floor(60 / Math.max(flows.length, 1))), 15)

  // ── Robust JSON extraction — handles common LLM formatting issues ──────────
  function extractJsonArray(raw: string): FlowTestCase[] {
    let cleaned = raw.trim()
      .replace(/^```[a-z]*\n?/, '')   // strip opening code fence
      .replace(/\n?```$/, '')          // strip closing code fence

    // Strategy 1: Extract array directly
    const fa = cleaned.indexOf('[')
    const la = cleaned.lastIndexOf(']')
    if (fa !== -1 && la !== -1) {
      try {
        return JSON.parse(cleaned.slice(fa, la + 1))
      } catch { /* try next strategy */ }
    }

    // Strategy 2: Extract from { "testCases": [...] } wrapper
    const fb = cleaned.indexOf('{')
    const lb = cleaned.lastIndexOf('}')
    if (fb !== -1 && lb !== -1) {
      try {
        const obj = JSON.parse(cleaned.slice(fb, lb + 1))
        const arr = obj.testCases ?? obj.test_cases ?? obj.tests ?? obj.cases
        if (Array.isArray(arr)) return arr
      } catch { /* try next strategy */ }
    }

    // Strategy 3: Fix trailing commas before ] or }
    try {
      const fixed = cleaned
        .replace(/,\s*([\]}])/g, '$1')    // remove trailing commas
        .replace(/\n/g, ' ')              // collapse newlines
      const fa2 = fixed.indexOf('[')
      const la2 = fixed.lastIndexOf(']')
      if (fa2 !== -1 && la2 !== -1) {
        return JSON.parse(fixed.slice(fa2, la2 + 1))
      }
    } catch { /* fallthrough */ }

    throw new Error(`Could not extract JSON array from LLM response (length=${raw.length})`)
  }

  // ── Flow type classifier ──────────────────────────────────────────────────
  // Detects whether a flow is a search/filter/list-view flow (as opposed to a CRUD flow).
  // Examples that should return true:
  //   "Search and Filter Lead from List view"
  //   "Filter Leads by Status"
  //   "Browse Contacts"
  //   "Search Records"
  function isSearchFilterFlow(flowName: string): boolean {
    const lower = flowName.toLowerCase()
    return (
      /\bsearch\b/.test(lower) ||
      /\bfilter\b/.test(lower) ||
      /\bsort\b/.test(lower) ||
      /\bbrowse\b/.test(lower) ||
      (/\blist\s+view\b/.test(lower) && !/\bcreate\b/.test(lower) && !/\bedit\b/.test(lower)) ||
      (/\blist\b/.test(lower) && /\bfind\b/.test(lower))
    )
  }

  // ── Metadata-driven fallback generator ──────────────────────────────────────
  // When BOTH LLM attempts fail, generate contextually appropriate test cases
  // from the field manifest and URL map. This ensures no flow gets an empty group.
  //
  // CRITICAL: Test cases must reflect the ACTUAL BUSINESS FLOW, not generic CRUD.
  // - Search/filter/list-view flows → list navigation + search/filter + assertion
  // - CRUD flows → create/read/update/delete with real fields from manifest
  async function generateFallbackTestCases(
    flowName: string,
  ): Promise<FlowTestCase[]> {
    // Extract entity name(s) from the flow name — use FLOW_STOP_WORDS (which includes
    // 'search', 'filter', 'list', 'view', 'find', 'sort', 'browse', 'navigate', etc.)
    // so these action/UI words are NEVER treated as entity names.
    const entityNames: string[] = []
    for (const word of flowName.split(/\s+/)) {
      const clean = word.replace(/[^a-zA-Z]/g, '')
      if (clean.length > 2 && !FLOW_STOP_WORDS.has(clean.toLowerCase())) {
        entityNames.push(clean.charAt(0).toUpperCase() + clean.slice(1))
        if (entityNames.length >= 2) break  // cap at 2 to avoid over-generation
      }
    }

    const primaryEntity = entityNames[0] ?? flowName.split(/\s+/).find(w => w.length > 3) ?? 'Record'
    const entityPath    = `/${primaryEntity.toLowerCase()}s`

    // ── Branch A: Search / Filter / List-view flows ─────────────────────────
    // These flows are about finding/filtering existing records in a list view,
    // NOT about creating new records. Generate appropriate list-navigation tests.
    if (isSearchFilterFlow(flowName)) {
      const flowLower = flowName.toLowerCase()
      const hasSearch = /\bsearch\b/.test(flowLower)
      const hasFilter = /\bfilter\b/.test(flowLower)

      const testCases: FlowTestCase[] = []

      if (hasSearch) {
        testCases.push({
          name: `Search ${primaryEntity} in List View and Verify Results`,
          description: `Navigate to the ${primaryEntity} list view, enter a search term, and verify matching records appear in results.`,
          priority: 'high',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'TYPE', target: 'Search', value: primaryEntity, locator_type: 'label' },
            { id: '3', action: 'ASSERT_TEXT', target: primaryEntity, locator_type: 'text' },
          ],
          tags: [primaryEntity, 'search', 'list-view', 'fallback'],
        })

        testCases.push({
          name: `Search ${primaryEntity} with No Matching Results`,
          description: `Navigate to the ${primaryEntity} list view, enter a search term that returns no results, and verify the empty state message is shown.`,
          priority: 'medium',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'TYPE', target: 'Search', value: 'xyznonexistent99', locator_type: 'label' },
            { id: '3', action: 'ASSERT_TEXT', target: 'No records', locator_type: 'text' },
          ],
          tags: [primaryEntity, 'search', 'negative', 'list-view', 'fallback'],
        })
      }

      if (hasFilter) {
        testCases.push({
          name: `Filter ${primaryEntity} List by Criteria and Verify Filtered Results`,
          description: `Navigate to the ${primaryEntity} list view, apply a filter, and verify only matching records appear.`,
          priority: 'high',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'CLICK', target: 'Filter', locator_type: 'role' },
            { id: '3', action: 'ASSERT_TEXT', target: primaryEntity, locator_type: 'text' },
          ],
          tags: [primaryEntity, 'filter', 'list-view', 'fallback'],
        })

        testCases.push({
          name: `Reset ${primaryEntity} List Filter and Verify All Records Restored`,
          description: `Apply a filter on the ${primaryEntity} list, then clear/reset the filter, and verify all records are shown again.`,
          priority: 'medium',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'CLICK', target: 'Filter', locator_type: 'role' },
            { id: '3', action: 'CLICK', target: 'Clear', locator_type: 'role' },
            { id: '4', action: 'ASSERT_TEXT', target: primaryEntity, locator_type: 'text' },
          ],
          tags: [primaryEntity, 'filter', 'reset', 'list-view', 'fallback'],
        })
      }

      // End-to-end flow test combining search AND filter if both are present
      if (hasSearch && hasFilter) {
        testCases.push({
          name: flowName,
          description: `End-to-end test for "${flowName}" — navigates to the ${primaryEntity} list view, applies a search term AND a filter, and verifies the combined results.`,
          priority: 'high',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'TYPE', target: 'Search', value: primaryEntity, locator_type: 'label' },
            { id: '3', action: 'CLICK', target: 'Filter', locator_type: 'role' },
            { id: '4', action: 'ASSERT_TEXT', target: primaryEntity, locator_type: 'text' },
          ],
          tags: [primaryEntity, 'search', 'filter', 'end-to-end', 'fallback'],
        })
      }

      log.info(
        { flowName, entityNames, testCaseCount: testCases.length, flowType: 'search-filter' },
        '[SUITE] Generated search/filter fallback test cases',
      )
      return testCases
    }

    // ── Branch B: Generic flow with no entity extracted ──────────────────────
    if (entityNames.length === 0) {
      return [{
        name: `Test ${flowName}`,
        description: `Execute the "${flowName}" business flow end-to-end.`,
        priority: 'medium',
        steps: [
          { id: '1', action: 'NAVIGATE', value: '/', locator_type: 'url' },
          { id: '2', action: 'ASSERT_TEXT', target: flowName.split(/\s+/)[0], locator_type: 'text' },
        ],
        tags: [flowName],
      }]
    }

    // ── Branch C: CRUD / management flows ────────────────────────────────────
    const testCases: FlowTestCase[] = []

    for (const entityName of entityNames) {
      // Try to load manifest for this entity
      let manifest: Awaited<ReturnType<typeof buildFieldManifest>> = null
      try {
        manifest = await buildFieldManifest(projectId, entityName)
      } catch { /* non-critical */ }

      const entityPath = manifest?.createUrl?.replace(/\/new$/, '') ?? `/${entityName.toLowerCase()}s`
      const createPath = manifest?.createUrl ?? `/${entityName.toLowerCase()}s/new`

      if (manifest && manifest.fields.length > 0) {
        // Generate a create test using real field data
        const requiredFields = manifest.fields.filter(f => f.required).slice(0, 6)
        const fieldSteps = requiredFields.map((f, i) => ({
          id: String(i + 2),
          action: f.type === 'select' ? 'SELECT' : f.type === 'lookup' ? 'LOOKUP' : 'TYPE',
          target: f.label,
          value: f.sampleValue ?? (f.options?.[0] ?? `Test ${f.label}`),
          locator_type: 'label',
        }))

        const submitStep = manifest.submitButton ? {
          id: String(fieldSteps.length + 2),
          action: 'CLICK',
          target: manifest.submitButton,
          locator_type: 'role',
        } : {
          id: String(fieldSteps.length + 2),
          action: 'CLICK',
          target: 'Save',
          locator_type: 'role',
        }

        const verifyCreatedStep = {
          id: String(fieldSteps.length + 3),
          action: 'ASSERT_TEXT',
          target: `${entityName} created successfully`,
          locator_type: 'text',
        }

        // TC1: Create with required fields
        testCases.push({
          name: `Create ${entityName} with Required Fields and Verify Success`,
          description: `Create a new ${entityName} record filling all required fields. Verifies the record is saved successfully.`,
          priority: 'high',
          steps: [
            { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
            ...fieldSteps,
            submitStep,
            verifyCreatedStep,
          ],
          tags: [entityName, 'create', 'fallback'],
        })

        // TC2: Validate required fields (submit empty form)
        testCases.push({
          name: `Validate Required Fields on ${entityName} Form`,
          description: `Attempt to submit the ${entityName} form without filling required fields. Expected: validation errors appear.`,
          priority: 'high',
          steps: [
            { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
            { ...submitStep, id: '2' },
            { id: '3', action: 'ASSERT_TEXT', target: 'required', locator_type: 'text' },
          ],
          tags: [entityName, 'validation', 'negative', 'fallback'],
        })

        // TC3: Verify list view loads
        testCases.push({
          name: `Navigate to ${entityName} List and Verify Records Display`,
          description: `Navigate to the ${entityName} list page and verify records are displayed correctly.`,
          priority: 'medium',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
          ],
          tags: [entityName, 'read', 'list', 'fallback'],
        })

        // TC4: Edit existing record (if required fields known)
        if (requiredFields.length > 0) {
          const editFieldSteps = requiredFields.slice(0, 2).map((f, i) => ({
            id: String(i + 3),
            action: f.type === 'select' ? 'SELECT' : 'TYPE',
            target: f.label,
            value: f.sampleValue ?? `Updated ${f.label}`,
            locator_type: 'label',
          }))
          testCases.push({
            name: `Edit ${entityName} Record and Verify Updated Values`,
            description: `Open an existing ${entityName} record, modify key fields, save, and verify the updated values are reflected.`,
            priority: 'high',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'CLICK', target: entityName, locator_type: 'role' },
              { id: '3', action: 'CLICK', target: 'Edit', locator_type: 'role' },
              ...editFieldSteps.map((s, i) => ({ ...s, id: String(4 + i) })),
              { ...submitStep, id: String(4 + editFieldSteps.length) },
              { id: String(5 + editFieldSteps.length), action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'update', 'fallback'],
          })
        }

        // TC5: Delete record
        testCases.push({
          name: `Delete ${entityName} Record and Verify Removal`,
          description: `Navigate to an existing ${entityName} record, trigger deletion, confirm the dialog, and verify the record no longer appears in the list.`,
          priority: 'medium',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'CLICK', target: entityName, locator_type: 'role' },
            { id: '3', action: 'CLICK', target: 'Delete', locator_type: 'role' },
            { id: '4', action: 'CLICK', target: 'Confirm', locator_type: 'role' },
            { id: '5', action: 'ASSERT_TEXT', target: `${entityName} deleted`, locator_type: 'text' },
          ],
          tags: [entityName, 'delete', 'fallback'],
        })

        // TC6: Search in list view
        testCases.push({
          name: `Search ${entityName} by Name and Verify Result`,
          description: `Navigate to the ${entityName} list, use the search field to locate a specific record by name, and verify it appears in results.`,
          priority: 'medium',
          steps: [
            { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
            { id: '2', action: 'TYPE', target: 'Search', value: entityName, locator_type: 'label' },
            { id: '3', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
          ],
          tags: [entityName, 'search', 'fallback'],
        })

        // TC7: Create with invalid data (negative test)
        if (requiredFields.length > 0) {
          const invalidField = requiredFields[0]
          testCases.push({
            name: `Create ${entityName} with Invalid Data in ${invalidField.label} Field`,
            description: `Attempt to create a ${entityName} record with invalid data in the "${invalidField.label}" field. Verifies the appropriate validation error appears.`,
            priority: 'medium',
            steps: [
              { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
              { id: '2', action: 'TYPE', target: invalidField.label, value: '!!!INVALID_DATA@@@', locator_type: 'label' },
              { ...submitStep, id: '3' },
              { id: '4', action: 'ASSERT_TEXT', target: 'invalid', locator_type: 'text' },
            ],
            tags: [entityName, 'negative', 'validation', 'fallback'],
          })
        }

        // TC8: Create with all optional fields populated
        const optionalFields = manifest.fields.filter(f => !f.required).slice(0, 4)
        if (optionalFields.length > 0) {
          const optionalSteps = [
            ...requiredFields.slice(0, 3),
            ...optionalFields,
          ].map((f, i) => ({
            id: String(i + 2),
            action: f.type === 'select' ? 'SELECT' : f.type === 'lookup' ? 'LOOKUP' : 'TYPE',
            target: f.label,
            value: f.sampleValue ?? (f.options?.[0] ?? `Test ${f.label}`),
            locator_type: 'label',
          }))
          testCases.push({
            name: `Create ${entityName} with All Optional Fields and Verify Complete Record`,
            description: `Create a ${entityName} record populating both required and optional fields. Verifies all entered data is saved and displayed correctly.`,
            priority: 'low',
            steps: [
              { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
              ...optionalSteps,
              { ...submitStep, id: String(optionalSteps.length + 2) },
              { id: String(optionalSteps.length + 3), action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'create', 'optional-fields', 'fallback'],
          })
        }

      } else {
        // No manifest — generate a full set of minimal navigation + assertion tests
        testCases.push(
          {
            name: `Navigate to ${entityName} List and Verify Page Loads`,
            description: `Navigate to the ${entityName} list page and verify it loads correctly as part of the "${flowName}" flow.`,
            priority: 'high',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'read', 'fallback'],
          },
          {
            name: `Create New ${entityName} Record with Required Fields`,
            description: `Navigate to the ${entityName} create form, fill required fields with valid data, and verify the record is created successfully.`,
            priority: 'high',
            steps: [
              { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
              { id: '2', action: 'TYPE', target: 'Name', value: `Test ${entityName}`, locator_type: 'label' },
              { id: '3', action: 'CLICK', target: 'Save', locator_type: 'role' },
              { id: '4', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'create', 'fallback'],
          },
          {
            name: `Validate Required Fields on ${entityName} Form`,
            description: `Submit the ${entityName} form without required fields and verify validation errors appear.`,
            priority: 'high',
            steps: [
              { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
              { id: '2', action: 'CLICK', target: 'Save', locator_type: 'role' },
              { id: '3', action: 'ASSERT_TEXT', target: 'required', locator_type: 'text' },
            ],
            tags: [entityName, 'validation', 'negative', 'fallback'],
          },
          {
            name: `Edit Existing ${entityName} Record and Verify Changes Saved`,
            description: `Open an existing ${entityName} record, modify key fields, save, and verify the changes persist.`,
            priority: 'medium',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'CLICK', target: entityName, locator_type: 'role' },
              { id: '3', action: 'CLICK', target: 'Edit', locator_type: 'role' },
              { id: '4', action: 'TYPE', target: 'Name', value: `Updated ${entityName}`, locator_type: 'label' },
              { id: '5', action: 'CLICK', target: 'Save', locator_type: 'role' },
              { id: '6', action: 'ASSERT_TEXT', target: `Updated ${entityName}`, locator_type: 'text' },
            ],
            tags: [entityName, 'update', 'fallback'],
          },
          {
            name: `Delete ${entityName} Record and Verify It Is Removed`,
            description: `Select an existing ${entityName} record, delete it, confirm the action, and verify it no longer appears in the list.`,
            priority: 'medium',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'CLICK', target: entityName, locator_type: 'role' },
              { id: '3', action: 'CLICK', target: 'Delete', locator_type: 'role' },
              { id: '4', action: 'CLICK', target: 'Confirm', locator_type: 'role' },
              { id: '5', action: 'ASSERT_TEXT', target: 'deleted', locator_type: 'text' },
            ],
            tags: [entityName, 'delete', 'fallback'],
          },
          {
            name: `Search for ${entityName} in List View and Verify Results`,
            description: `Use the search functionality on the ${entityName} list page to find a specific record by name.`,
            priority: 'medium',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'TYPE', target: 'Search', value: entityName, locator_type: 'label' },
              { id: '3', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'search', 'fallback'],
          },
          {
            name: `Create ${entityName} with Duplicate Name and Verify Error`,
            description: `Attempt to create a ${entityName} with a name that already exists. Verify a duplicate/uniqueness error is shown.`,
            priority: 'low',
            steps: [
              { id: '1', action: 'NAVIGATE', value: createPath, locator_type: 'url' },
              { id: '2', action: 'TYPE', target: 'Name', value: `Existing ${entityName}`, locator_type: 'label' },
              { id: '3', action: 'CLICK', target: 'Save', locator_type: 'role' },
              { id: '4', action: 'ASSERT_TEXT', target: 'already exists', locator_type: 'text' },
            ],
            tags: [entityName, 'negative', 'duplicate', 'fallback'],
          },
          {
            name: `View ${entityName} Record Detail Page and Verify All Fields`,
            description: `Navigate to a specific ${entityName} record's detail page and verify all fields are displayed correctly.`,
            priority: 'low',
            steps: [
              { id: '1', action: 'NAVIGATE', value: entityPath, locator_type: 'url' },
              { id: '2', action: 'CLICK', target: entityName, locator_type: 'role' },
              { id: '3', action: 'ASSERT_TEXT', target: entityName, locator_type: 'text' },
            ],
            tags: [entityName, 'read', 'detail', 'fallback'],
          },
        )
      }
    }

    // For multi-entity flows (e.g. "Create Contact and Link to Account"),
    // add a cross-entity linking test case
    if (entityNames.length >= 2) {
      testCases.push({
        name: flowName,  // Use the original flow name directly
        description: `End-to-end test for the complete "${flowName}" business flow, covering all involved entities: ${entityNames.join(', ')}.`,
        priority: 'high',
        steps: entityNames.flatMap((en, i) => [
          { id: String(i * 2 + 1), action: 'NAVIGATE', value: `/${en.toLowerCase()}s`, locator_type: 'url' },
          { id: String(i * 2 + 2), action: 'ASSERT_TEXT', target: en, locator_type: 'text' },
        ]),
        tags: [...entityNames, 'cross-entity', 'fallback'],
      })
    }

    log.info(
      { flowName, entityNames, testCaseCount: testCases.length, flowType: 'crud' },
      '[SUITE] Generated comprehensive CRUD fallback test cases from field manifest',
    )

    return testCases
  }

  // ── Per-flow generation with 3-tier resilience ─────────────────────────────
  const groupResults = await Promise.allSettled(
    orderedFlows.map(async (entry) => {
      const isListOnlyModule  = /\s+List$/i.test(entry.flow)
      const isSearchFilter    = isSearchFilterFlow(entry.flow)
      const moduleDisplayName = entry.flow.replace(/\s*(Management|List|Module|Feature|Settings)$/i, '').trim()
      // Primary entity extracted from the flow name (e.g. "Lead" from
      // "Search and Filter Lead from List view" or "Create Lead and Verify Validation").
      // FLOW_STOP_WORDS now includes search/filter/sort/browse/navigate so these
      // action words are never incorrectly extracted as entity names.
      const modulePrimaryEntity = extractPrimaryEntityFromFlow(entry.flow)

      // Build a flow-type-specific constraint block for the LLM scope lock
      const searchFilterConstraint = isSearchFilter ? `
⚠️  "${entry.flow}" is a SEARCH / FILTER / LIST-VIEW flow — there is NO create/edit/delete action.
✅ ONLY generate tests that:
   • Navigate to the ${modulePrimaryEntity} list / list view page
   • Enter search terms in the search box (TYPE action)
   • Apply filters (CLICK filter button + SELECT/TYPE criteria)
   • Verify search/filter results appear correctly (ASSERT_TEXT on matching record or count)
   • Test edge cases: empty search, no results, reset/clear filter
⛔ DO NOT generate "Create ${modulePrimaryEntity} Record", "Edit ${modulePrimaryEntity}", or any CRUD test.
⛔ DO NOT generate tests named "Create Search Record" or "Create Filter Record" — those are INVALID.
   The word "Search" and "Filter" describe ACTIONS in the UI, not entities to create.
` : ''

      const moduleScopeBlock = `
## 🔴🔴🔴 MODULE SCOPE LOCK — NON-NEGOTIABLE 🔴🔴🔴
You MUST generate test cases EXCLUSIVELY for the "${entry.flow}" business flow.
Every single test case in your output MUST be 100% about "${entry.flow}" — nothing else.

${isListOnlyModule && !isSearchFilter ? `⚠️  "${moduleDisplayName}" is a READ-ONLY LIST — there is NO create/edit/delete form.
✅ ONLY generate tests that navigate to the ${moduleDisplayName} list, verify records, search/filter.
⛔ DO NOT generate Create, Edit, Delete tests for "${moduleDisplayName}".` : ''}
${searchFilterConstraint}
⛔ FORBIDDEN — DO NOT generate test cases for ANY entity, page, or workflow that is NOT part of "${entry.flow}":
• Do NOT generate tests for other workflows/modules even if the metadata mentions them.
• Only the selected flow matters — ignore all other entities visible in the metadata or BRD.

✅ Every test case NAME must contain the word "${modulePrimaryEntity}" (e.g. "${isSearchFilter ? `Search ${modulePrimaryEntity}` : `Create ${modulePrimaryEntity}`}", "Verify ${modulePrimaryEntity}").
## 🔴🔴🔴 END MODULE SCOPE LOCK 🔴🔴🔴
`

      const tcPrompt = `You are a senior QA Automation Engineer writing EXECUTABLE test cases.
Generate exactly ${PER_FLOW_COUNT} test cases for this SPECIFIC BUSINESS FLOW: "${entry.flow}"

${moduleScopeBlock}

PROJECT: ${ctx.projectName}
${ctx.metadataSummary}
${brd ? `\nBRD / BUSINESS RULES:\n${brd.slice(0, 4000)}` : ''}
${existingTests ? `\nEXISTING TEST PATTERNS (naming/style reference only):\n${existingTests.slice(0, 2000)}` : ''}

═══════════════════════════════════════════════════════
UI GROUNDING RULES — violations make tests non-executable
═══════════════════════════════════════════════════════

RULE 1 — PAGE UI INVENTORY (actual UI elements confirmed by web crawl):
${ctx.pageConstraints || '(No crawl data — derive steps from BRD only; use VERIFY for system-generated outcomes)'}

RULE 2 — HOW TO READ THE INVENTORY:
• [LIST] pages: only generate NAVIGATE + CLICK record + VERIFY steps.
  DO NOT add CLICK "Create"/"Add" steps unless a "New" or "Create" button is shown in the confirmed buttons list.
• [FORM] pages: use ONLY the listed required fields and dropdowns for TYPE/SELECT steps.
• [DASHBOARD] pages: use ONLY the listed action buttons.
• If the BRD describes a feature that has NO matching button in the inventory:
  that feature is SYSTEM-AUTOMATED. Represent it as a VERIFY step showing the system result,
  NOT as a user CLICK/TYPE step.

RULE 3 — ALLOWED STEP ACTIONS:
  NAVIGATE  — go to a URL path
  CLICK     — click a button or link that is listed in the inventory for that page
  TYPE      — type into an input field listed in the inventory for that page
  SELECT    — choose from a dropdown listed in the inventory for that page
  VERIFY    — assert a visible element, text, count, or state
  WAIT      — wait for page load or a specific element to appear

RULE 4 — GENERAL:
- Test cases must be SPECIFIC to the "${entry.flow}" flow only
- Each test case MUST end with a VERIFY step
- Names: verb-first, entity-specific, outcome-clear
- Cover: 1 happy path, 1 edge case/boundary, 1 validation/negative test
- No login/auth steps — session is pre-established

Return ONLY valid JSON array (no markdown, no prose):
[
  {
    "name": "string",
    "description": "string",
    "priority": "high|medium|low",
    "steps": [
      { "id": "1", "action": "NAVIGATE", "value": "/path" },
      { "id": "2", "action": "CLICK", "target": "Button Name", "locator_type": "role" },
      { "id": "3", "action": "TYPE", "target": "Field Label", "value": "test value", "locator_type": "label" },
      { "id": "4", "action": "VERIFY", "target": "Success message or record visible", "locator_type": "text" }
    ],
    "tags": ["FlowName", "EntityName"]
  }
]`

      // ── Tier 1: Primary LLM call ─────────────────────────────────────────
      let testCases: FlowTestCase[] = []
      try {
        const raw = await llm.pipe(parser).invoke([
          new SystemMessage(tcPrompt),
          new HumanMessage('Generate the test cases now. Return ONLY a valid JSON array.'),
        ])
        testCases = extractJsonArray(raw)
        if (!Array.isArray(testCases) || testCases.length === 0) {
          throw new Error('LLM returned empty or non-array result')
        }
      } catch (primaryErr) {
        log.warn(
          { err: primaryErr, flow: entry.flow },
          '[SUITE] Tier 1 LLM failed — retrying with simplified prompt',
        )

        // ── Tier 2: Retry with a simpler, shorter prompt ───────────────────
        try {
          const retryPrompt = `Generate ${PER_FLOW_COUNT} test cases for: "${entry.flow}"
Project: ${ctx.projectName}

Return ONLY a valid JSON array — no markdown, no explanation:
[{"name":"string","description":"string","priority":"high|medium|low","steps":[{"id":"1","action":"NAVIGATE","value":"/path"},{"id":"2","action":"CLICK","target":"Button","locator_type":"role"},{"id":"3","action":"VERIFY","target":"expected text","locator_type":"text"}],"tags":["tag"]}]`

          const retryRaw = await llm.pipe(parser).invoke([
            new SystemMessage(retryPrompt),
            new HumanMessage('Generate now. ONLY JSON array output.'),
          ])
          testCases = extractJsonArray(retryRaw)
          if (!Array.isArray(testCases) || testCases.length === 0) {
            throw new Error('Retry also returned empty')
          }
          log.info({ flow: entry.flow, count: testCases.length }, '[SUITE] Tier 2 retry succeeded')
        } catch (retryErr) {
          log.warn(
            { err: retryErr, flow: entry.flow },
            '[SUITE] Tier 2 retry also failed — using metadata fallback',
          )

          // ── Tier 3: Metadata-driven fallback ─────────────────────────────
          testCases = await generateFallbackTestCases(entry.flow)
          log.warn(
            { flow: entry.flow, count: testCases.length, target: PER_FLOW_COUNT },
            '[SUITE] ⚠️ Tier 3 metadata fallback activated — both LLM attempts failed',
          )
        }
      }

      // Final safety: filter to valid test cases only
      testCases = testCases.filter(
        (tc: any) => tc && typeof tc.name === 'string' && tc.name.trim(),
      )

      // ── Top-up: if LLM returned fewer cases than PER_FLOW_COUNT, pad with fallback
      if (testCases.length < PER_FLOW_COUNT) {
        try {
          const fallbackCases = await generateFallbackTestCases(entry.flow)
          // Merge, avoiding name duplicates
          const existingNames = new Set(testCases.map((tc: any) => String(tc.name ?? '').toLowerCase().trim()))
          const newCases = fallbackCases.filter(
            fc => !existingNames.has(fc.name.toLowerCase().trim())
          )
          const needed = PER_FLOW_COUNT - testCases.length
          testCases = [...testCases, ...newCases.slice(0, needed)]
          log.info(
            { flow: entry.flow, added: Math.min(newCases.length, needed), total: testCases.length },
            '[SUITE] Padded test cases with fallback to reach PER_FLOW_COUNT target',
          )
        } catch { /* non-critical */ }
      }

      return { ...entry, testCases }
    })
  )

  // ── Step 3: Persist test cases to DB and collect IDs ────────────────────────
  // VERIFY action normalization: generateTestSuite prompts use VERIFY which the
  // execution worker doesn't recognise. Normalise to ASSERT_TEXT before persisting.
  const ACTION_ALIASES_SUITE: Record<string, string> = {
    verify: 'ASSERT_TEXT', check: 'ASSERT_TEXT', assert: 'ASSERT_TEXT',
    fill_form: 'TYPE', enter: 'TYPE', set: 'TYPE', fillform: 'TYPE',
    submit: 'CLICK', press: 'CLICK', tap: 'CLICK',
    goto: 'NAVIGATE', open: 'NAVIGATE', visit: 'NAVIGATE',
  }
  function normaliseStepAction(step: unknown): unknown {
    const s = step as Record<string, unknown>
    const raw = String(s.action ?? '').toLowerCase().trim()
    const mapped = ACTION_ALIASES_SUITE[raw]
    if (mapped) return { ...s, action: mapped }
    return { ...s, action: String(s.action ?? '').toUpperCase().trim() }
  }

  const groups: FlowGroup[] = []
  for (let ri = 0; ri < groupResults.length; ri++) {
    const result = groupResults[ri]

    // ── REJECTED flow: create a placeholder group so it appears in Review ─────
    // Previously we silently skipped rejected flows — this caused the 1st suite
    // to disappear from the Review & Filter page when its LLM call failed.
    if (result.status === 'rejected') {
      const fallbackEntry = orderedFlows[ri]
      log.warn(
        { err: result.reason, flow: fallbackEntry?.flow },
        '[SUITE] Flow generation failed — inserting empty placeholder group so it appears in Review'
      )
      if (fallbackEntry) {
        groups.push({
          flow:      fallbackEntry.flow,
          order:     fallbackEntry.order,
          rationale: fallbackEntry.rationale,
          testCases: [],  // empty — will be visible in Review so user knows it failed
        })
      }
      continue
    }

    const { flow, order, rationale, testCases } = result.value

    // Apply the exact same robust post-generation filter to each business flow group.
    // Pass `modulePrimaryEntity` (e.g. "Lead") rather than the full flow name so that
    // getEntityStems produces short, matchable stems instead of the entire phrase.
    const modulePrimaryEntity = extractPrimaryEntityFromFlow(flow)
    let filteredCases = testCases
    try {
      const { filterTestCasesToModule } = await import('../test-case-generator/test-case-generator.service.js')
      filteredCases = filterTestCasesToModule(testCases as any[], modulePrimaryEntity) as unknown as FlowTestCase[]
      log.info({ flow, beforeCount: testCases.length, afterCount: filteredCases.length }, '[SUITE] Filtered test cases to flow module')
    } catch (filterErr) {
      log.warn({ filterErr, flow }, '[SUITE] Failed to filter test cases to flow module')
    }

    const persisted: (FlowTestCase & { id?: string })[] = []

    // ── Pre-compute field manifest for this flow to filter hallucinated fields ──
    // Extract primary entity from the flow name for manifest look-up.
    // Reuse modulePrimaryEntity computed above (already the first non-stop-word).
    const flowEntity = modulePrimaryEntity.length > 2 ? modulePrimaryEntity : undefined

    let flowManifest: Awaited<ReturnType<typeof buildFieldManifest>> = null
    try {
      flowManifest = await buildFieldManifest(projectId, flowEntity)
      if (flowManifest) {
        log.info(
          { flow, entity: flowEntity, fieldCount: flowManifest.fields.length },
          '[SUITE] Loaded field manifest for hallucination filtering'
        )
      }
    } catch { /* non-critical — will skip filtering */ }

    // Build case-insensitive set of known field labels from manifest
    const knownFieldLabels = flowManifest?.fields?.length
      ? new Set(flowManifest.fields.map(f => f.label.toLowerCase().trim()))
      : null

    const FIELD_ACTIONS = new Set(['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX', 'MULTI_SELECT'])

    for (const tc of filteredCases) {
      try {
        // Normalise inline step actions (VERIFY→ASSERT_TEXT, FILL_FORM→TYPE, etc.)
        let normalisedSteps = Array.isArray(tc.steps)
          ? tc.steps.map(normaliseStepAction)
          : []

        // ── Field hallucination filter ──────────────────────────────────────
        // Remove TYPE/SELECT/LOOKUP steps for fields that don't exist in the
        // real form (e.g., "Email" on Account form). This is the inline
        // equivalent of Check 7 in runTestStepGeneratorAgent.
        if (knownFieldLabels && knownFieldLabels.size > 0) {
          const beforeCount = normalisedSteps.length
          normalisedSteps = normalisedSteps.filter((s: any) => {
            const action = String(s.action ?? '').toUpperCase()
            if (!FIELD_ACTIONS.has(action)) return true  // keep non-field steps
            const target = String(s.target ?? '').trim()
            if (!target) return true
            if (knownFieldLabels.has(target.toLowerCase())) return true  // field exists
            // Field NOT in manifest → hallucinated → remove
            log.warn(
              { flow, tcName: tc.name, action, target },
              '[SUITE] Removing hallucinated field step — field does NOT exist in the form manifest'
            )
            return false
          })
          if (normalisedSteps.length < beforeCount) {
            log.info(
              { flow, tcName: tc.name, removed: beforeCount - normalisedSteps.length, remaining: normalisedSteps.length },
              '[SUITE] Hallucinated field steps removed'
            )
          }
        }

        // ── Cross-entity CLICK button filter ────────────────────────────────
        // Strip CLICK steps that target buttons for a DIFFERENT entity
        // (e.g., "+ New Lead" in a Contact test).
        if (flowEntity && flowEntity.length > 2) {
          const entityLower = flowEntity.toLowerCase()
          const beforeClickCount = normalisedSteps.length
          normalisedSteps = normalisedSteps.filter((s: any) => {
            const action = String(s.action ?? '').toUpperCase()
            if (action !== 'CLICK') return true
            const target = String(s.target ?? '').toLowerCase().trim()
            if (!target) return true
            const match = target.match(/\b(?:new|create|add)\s+([a-z]+(?:\s+[a-z]+)?)\b/)
            if (!match) return true
            const entityWord = match[1].trim()
            if (entityWord.length < 3 || ['the', 'a', 'an', 'new', 'all', 'item', 'record', 'entry'].includes(entityWord)) return true
            if (entityLower.includes(entityWord) || entityWord.includes(entityLower)) return true
            log.warn(
              { flow, tcName: tc.name, target: s.target, entityWord, flowEntity },
              '[SUITE] Removing cross-entity CLICK step — button is for a different entity',
            )
            return false
          })
          if (normalisedSteps.length < beforeClickCount) {
            log.info(
              { flow, tcName: tc.name, removed: beforeClickCount - normalisedSteps.length },
              '[SUITE] Cross-entity CLICK steps removed',
            )
          }
        }

        // ── Button name auto-correction (CENTRALIZED) ─────────────────────
        // Deterministically replaces LLM-invented button names (e.g. "Create
        // New Account") with the REAL button from metadata (e.g. "+New Account").
        if (flowEntity && flowEntity.length > 2) {
          await autoCorrectButtonNames(normalisedSteps as Array<Record<string, any>>, projectId, flowEntity)
        }

        const row = await prisma.test_cases.create({
          data: {
            name:        tc.name,
            description: tc.description ?? '',
            priority:    tc.priority ?? 'medium',
            steps:       normalisedSteps as any,
            status:      'review',
            project_id:  projectId,   // ← required so test-run service can resolve the project
          },
        })
        persisted.push({ ...tc, id: row.id })
      } catch (err) {
        log.warn({ err, tcName: tc.name }, '[SUITE] Failed to persist TC')
      }
    }
    groups.push({ flow, order, rationale, testCases: persisted })
  }

  // Sort by order
  groups.sort((a, b) => a.order - b.order)
  const totalTestCases = groups.reduce((s, g) => s + g.testCases.length, 0)

  log.info({ projectId, flowCount: groups.length, totalTestCases }, '[SUITE] Generation complete')
  return { groups, totalTestCases }
}
