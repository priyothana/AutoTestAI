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

const log = createModuleLogger('workflow-chat')

// ─── LLM factory ─────────────────────────────────────────────────────────────

function buildLlm(): BaseChatModel {
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini', temperature: 0.4, maxTokens: 2048 })
  }
  return new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.LLM_MODEL ?? 'claude-sonnet-4-5',
    maxTokens: 2048,
    temperature: 0.4,
  })
}

/** Dedicated LLM for workflow discovery — uses gpt-4o for richer analysis. */
function buildDiscoveryLlm(): BaseChatModel {
  if (process.env.OPENAI_API_KEY) {
    return new ChatOpenAI({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o', temperature: 0.3, maxTokens: 3000 })
  }
  return new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model:  process.env.LLM_MODEL ?? 'claude-sonnet-4-5',
    maxTokens: 3000,
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
}> {
  // ── Parallel DB fetches ──────────────────────────────────────────────────
  const [project, integration, brdRow, jiraIntegration] = await Promise.all([
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
  ])

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

  // Use BRD content from: 1) dedicated brd table, 2) project.brd_content column
  const resolvedBrd = brdRow?.content ?? project?.brd_content ?? ''

  // Existing tests content — stored on the project row
  const resolvedExistingTests = project?.existing_tests_content ?? ''

  // Append Jira stories to the metadata summary (within budget)
  const jiraSection = jiraStoriesSummary ? `\n\n${jiraStoriesSummary}` : ''
  const fullMeta = capMeta(integrationHeader + metaSummary + jiraSection)

  log.info({
    projectId,
    projectName: project?.name,
    appTitle,
    hasDescription: !!project?.description,
    metaSummaryLength: fullMeta.length,
    hasBrd: !!resolvedBrd,
    hasExistingTests: !!resolvedExistingTests,
    hasJiraStories: !!jiraStoriesSummary,
  }, '[WORKFLOW] Project context resolved')

  return {
    projectName:          project?.name ?? 'Unknown Project',
    projectCategory,
    metadataSummary:      fullMeta,
    brdContent:           resolvedBrd,
    existingTestsContent: resolvedExistingTests,
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
  const brd = decodeDocContent(brdContent ?? ctx.brdContent)
  const existingTests = decodeDocContent(ctx.existingTestsContent)

  const systemPrompt = `You are an expert QA Architect with deep knowledge of software testing across all domains.

Your task: generate a COMPREHENSIVE list of BUSINESS FLOWS for the project described below.
You MUST pay close attention to the PROJECT NAME, DESCRIPTION, and TYPE to understand what domain this application belongs to.
Do NOT default to CRM/Sales flows unless the metadata explicitly shows CRM entities.
A Business Flow is a complete end-to-end user journey that tests real business value — not a single page or button.

⚠️ CRITICAL CONSTRAINT: You MUST derive ALL flows EXCLUSIVELY from the metadata provided below.
Do NOT invent modules, pages, fields, or entities that are not listed in the metadata.

═══════════════════════════════════════════════════════
PROJECT: ${ctx.projectName}
${ctx.metadataSummary}
${brd ? `\nBRD / SPECIFICATION (use this to identify business rules and user journeys):\n${brd.slice(0, 8000)}` : ''}
${existingTests ? `\nEXISTING TEST CASES / TEST PATTERNS (use to ensure coverage gaps are filled):\n${existingTests.slice(0, 3000)}` : ''}
═══════════════════════════════════════════════════════

METADATA INTERPRETATION GUIDE:
- "fields:" lines = actual form fields you can interact with on that page
- "buttons:" lines = actual clickable actions available
- "actions:" lines = what operations are possible (fill_form, submit_form, click_button, etc.)
- "inputs:" / "selects:" = form controls available on that specific page

CRITICAL DOMAIN AWARENESS:
- The APPLICATION TITLE and PROJECT NAME tell you what kind of application this is.
- If the APPLICATION TITLE says "UEM" or "Endpoint Management" → this is a device/asset management tool, NOT a CRM.
- If the APPLICATION TITLE says "ERP" → interpret modules as inventory, procurement, HR, etc.
- URL paths MUST be interpreted in the context of the application's actual domain:
  • In a UEM app: /accounts = organizational units, /contacts = managed devices/endpoints, /leads = device onboarding requests
  • In an ERP app: /leads = procurement leads, /contacts = vendors/suppliers
  • In a CRM app: /leads = sales leads, /contacts = customers
- ALWAYS name your flows using the REAL DOMAIN terminology of this specific application.
  GOOD for UEM: "Enroll New Device via /contacts/new", "Register Organizational Unit via /accounts/create"
  BAD: "Create New Contact" (generic CRM language for a UEM app)

MANDATORY GENERATION RULES:
1. ✅ Generate flows for EVERY distinct page/entity/module explicitly visible in the metadata above.
   - For web apps: use the page paths (•) as your module list — only generate flows for those paths.
   - For Salesforce: use the listed objects — only generate flows for those objects.
   - For APIs: generate flows based on available endpoints and data entities.

2. ✅ For each module with form fields, include the FULL lifecycle:
   a) Create flow — fill required fields and submit the form
   b) Edit/update flow — find an existing record and modify key fields
   c) Delete/archive flow (if a delete button is present in metadata)
   d) At least one cross-module flow linking related entities

3. ✅ Use the actual field names from metadata to make flows specific.
   GOOD: "Register New Asset with Name, IP Address and OS Version"
   GOOD: "Create New Record with all Required Fields on /accounts/create"
   BAD:  "Fill form and submit" — too vague

4. ✅ Include flows that cover the buttons listed in metadata.
   If "Approve" button exists → include an approval flow.
   If "Send Invoice" button exists → include an invoice sending flow.

5. ✅ Include edge-case flows:
   - Required field validation (submit form with missing required fields)
   - Duplicate record detection
   - Permission / access control (if roles are indicated)

6. ❌ DO NOT generate flows for entities NOT present in the metadata.
   If "Opportunity" page is not in the metadata list, do NOT generate an Opportunity flow.

7. ❌ REJECT generic/vague flows:
   - "Verify UI is working" — REJECTED
   - "Test the dashboard" — REJECTED
   - "User login" — REJECTED (session is pre-managed)
   - "Verify navigation" — REJECTED

8. ✅ Flow naming rules:
   - 4–9 words, action-oriented, entity-specific, verb-first
   GOOD: "Create Lead and Convert to Opportunity"
   GOOD: "Submit Invoice and Mark as Paid"
   GOOD: "Validate Required Fields on Account Creation Form"
   BAD:  "Test CRM Features" — too generic

9. ✅ Generate 15–40 flows total — one per distinct page/entity in the metadata, plus cross-module flows. Prioritise business-critical journeys first.

10. ✅ For each flow write a 1–2 sentence description that names:
    - The specific page/module/entity involved (using exact names from metadata)
    - The business outcome validated

Return ONLY valid JSON with this exact shape (no markdown, no prose):
{
  "flows": [
    {
      "name": "Concise action-oriented flow name",
      "description": "1–2 sentences describing what this flow tests and why it matters for the business."
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

    return { flows: relabeledFlows }
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

export async function generateTestSuite(params: {
  projectId:  string
  flows:      string[]
  brdContent?: string
}): Promise<GenerateTestSuiteResult> {
  const { projectId, flows, brdContent } = params
  const ctx = await getProjectContext(projectId)
  const brd = decodeDocContent(brdContent ?? ctx.brdContent)
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
      orderedFlows = parsed.ordered.filter((x: any) => x.flow && x.order)
    }
  } catch (err) {
    log.warn({ err }, '[SUITE] Flow ordering failed — using default order')
  }

  // ── Step 2: Generate test cases per flow in parallel ────────────────────────
  const PER_FLOW_COUNT = Math.min(Math.max(4, Math.floor(20 / flows.length)), 8)

  const groupResults = await Promise.allSettled(
    orderedFlows.map(async (entry) => {
      const tcPrompt = `You are a senior QA Automation Engineer. 
Generate exactly ${PER_FLOW_COUNT} test cases for this SPECIFIC BUSINESS FLOW: "${entry.flow}"

PROJECT: ${ctx.projectName}
AVAILABLE ENTITIES/PAGES:
${ctx.metadataSummary}
${brd ? `\nBRD:\n${brd.slice(0, 3000)}` : ''}
${existingTests ? `\nEXISTING TEST PATTERNS (avoid duplicating, use as reference for naming conventions):\n${existingTests.slice(0, 2000)}` : ''}

RULES:
- Test cases must be SPECIFIC to the "${entry.flow}" flow only
- Each test case must end with an ASSERT step
- Names must be action-oriented (verb + entity + outcome)
- Cover happy path, edge cases, and at least 1 negative test
- No login/auth steps — session is pre-established

Return ONLY valid JSON array (no markdown):
[
  {
    "name": "string",
    "description": "string",
    "priority": "high|medium|low",
    "steps": [
      { "id": "1", "action": "NAVIGATE", "value": "/path" },
      { "id": "2", "action": "TYPE", "target": "Field Label", "value": "test value", "locator_type": "label" }
    ],
    "tags": ["FlowName", "CRUD"]
  }
]`
      const raw = await llm.pipe(parser).invoke([
        new SystemMessage(tcPrompt),
        new HumanMessage('Generate the test cases now. Return ONLY a valid JSON array.'),
      ])
      let jsonStr = raw.trim().replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '')
      const fa = jsonStr.indexOf('['); const la = jsonStr.lastIndexOf(']')
      if (fa !== -1 && la !== -1) jsonStr = jsonStr.slice(fa, la + 1)
      const testCases: FlowTestCase[] = JSON.parse(jsonStr)
      return { ...entry, testCases: Array.isArray(testCases) ? testCases : [] }
    })
  )

  // ── Step 3: Persist test cases to DB and collect IDs ────────────────────────
  const groups: FlowGroup[] = []
  for (const result of groupResults) {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason }, '[SUITE] Flow generation failed')
      continue
    }
    const { flow, order, rationale, testCases } = result.value
    const persisted: (FlowTestCase & { id?: string })[] = []

    for (const tc of testCases) {
      try {
        const row = await prisma.test_cases.create({
          data: {
            name:        tc.name,
            description: tc.description ?? '',
            priority:    tc.priority ?? 'medium',
            steps:       (tc.steps ?? []) as any,
            status:      'active',
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
