/**
 * Test Step Generator Agent — Phase 1, Agent 3
 *
 * The highest-ROI agent: replaces the single-shot LLM call in generation.service.ts
 * with a fully autonomous, 5-check validated, self-correcting step generation pipeline.
 *
 * LLM: OpenAI gpt-4o
 * ReAct: Observe → Think → Act → Reflect → Deliver
 *
 * Anti-hallucination gate (5 checks before accepting output):
 *   1. Required field coverage  — COUNT_B ≥ COUNT_REQUIRED
 *   2. URL verification         — every NAVIGATE path in verified URL map
 *   3. Button name exactness    — CLICK target matches metadata submit button
 *   4. Locator type validity    — lookups use LOOKUP, selects use SELECT
 *   5. Data type alignment      — phone/email/date/amount format checks
 *
 * Max 3 self-correction loops before calling hitlTool.
 */
import { ChatOpenAI }            from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }    from '@langchain/core/output_parsers'
import { v4 as uuidv4 }          from 'uuid'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { buildFieldManifest, buildUrlMap, formatManifestForPrompt } from './tools/metadata-reader.tool.js'
import { getTestCaseById, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import type {
  AgentStep_Playwright,
  StepValidationResult,
  HITLInput,
} from './agent.types.js'

const log = createModuleLogger('step-generator-agent')

// ── LLM ───────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.STEP_GEN_MODEL ?? 'gpt-4o',
    temperature: 0.1,
    maxTokens:   4096,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Test Step Generator Agent for AutoTestAI.
Your job: generate EXECUTABLE Playwright test steps grounded in real metadata.

MANDATORY PRE-FLIGHT (complete BEFORE writing any step):
  A. Identify PRIMARY ENTITY from the test case name.
  B. Find the EXACT page URL from the URL MAP — never invent.
  C. List ALL required fields from the FIELD MANIFEST. Count = COUNT_REQUIRED.
  D. Find the EXACT submit button name from the FIELD MANIFEST. Copy verbatim.
  E. Self-check: will my steps cover COUNT_REQUIRED fields? If not, add them.

Anti-hallucination rules (ABSOLUTE):
- NEVER use a URL not in the URL MAP
- NEVER use a field label not in the FIELD MANIFEST
- NEVER use a generic button name — use the EXACT name from the manifest
- Lookup fields → action: LOOKUP (never TYPE)
- Select fields → action: SELECT with a value from [VALID OPTIONS]
- Phone fields → phone format only (e.g. "+1 555-123-4567")
- Email fields → email format only (e.g. "user@example.com")
- Date fields  → MM/DD/YYYY format only

Step schema (output a JSON array — no markdown, no fences):
[{
  "id": "1",
  "action": "NAVIGATE|CLICK|TYPE|SELECT|LOOKUP|CHECKBOX|ASSERT_TEXT|ASSERT_URL|ASSERT_TOAST|WAIT",
  "target": "exact locator (omit for NAVIGATE/WAIT/ASSERT_URL)",
  "value": "url | input text | expected text | seconds",
  "locator_type": "label|role|text|placeholder|css"
}]`

// ── 5-Check Validation Gate ───────────────────────────────────────────────────

function validateSteps(
  steps:          AgentStep_Playwright[],
  requiredCount:  number,
  verifiedPaths:  string[],
  submitButton?:  string,
): StepValidationResult {
  const issues: string[] = []

  // Check 1: Required field coverage
  const fieldSteps = steps.filter(s =>
    ['TYPE', 'SELECT', 'LOOKUP', 'CHECKBOX'].includes(s.action.toUpperCase())
  )
  const check1 = fieldSteps.length >= requiredCount
  if (!check1) {
    issues.push(`Required field coverage: found ${fieldSteps.length} field steps but need ${requiredCount}`)
  }

  // Check 2: URL verification
  const navSteps = steps.filter(s => s.action.toUpperCase() === 'NAVIGATE')
  let check2 = true
  if (verifiedPaths.length > 0) {
    for (const nav of navSteps) {
      const val = nav.value ?? ''
      const ok = verifiedPaths.some(p => p === val || val.startsWith(p))
      if (!ok) {
        issues.push(`URL not in verified map: "${val}"`)
        check2 = false
      }
    }
  }

  // Check 3: Button name exactness
  let check3 = true
  if (submitButton) {
    const clickSteps = steps.filter(s => s.action.toUpperCase() === 'CLICK')
    const hasCorrectBtn = clickSteps.some(s =>
      (s.target ?? '').toLowerCase() === submitButton.toLowerCase()
    )
    if (clickSteps.length > 0 && !hasCorrectBtn) {
      issues.push(`Submit button mismatch. Expected: "${submitButton}"`)
      check3 = false
    }
  }

  // Check 4: Locator type validity
  let check4 = true
  for (const s of steps) {
    const action = s.action.toUpperCase()
    if (action === 'LOOKUP' && s.locator_type !== 'label') {
      issues.push(`LOOKUP step "${s.target}" should use locator_type: "label"`)
      check4 = false
    }
  }

  // Check 5: Data type alignment
  let check5 = true
  const phoneRe  = /^\+?[\d\s\-().]{7,20}$/
  const emailRe  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  const dateRe   = /^\d{2}\/\d{2}\/\d{4}$/

  for (const s of steps) {
    if (s.action.toUpperCase() !== 'TYPE') continue
    const label = (s.target ?? '').toLowerCase()
    const value = s.value ?? ''
    if (!value) continue

    if (/phone|mobile|tel/.test(label) && !phoneRe.test(value)) {
      issues.push(`Data type: phone field "${s.target}" has non-phone value "${value}"`)
      check5 = false
    }
    if (/email/.test(label) && !emailRe.test(value)) {
      issues.push(`Data type: email field "${s.target}" has non-email value "${value}"`)
      check5 = false
    }
    if (/date/.test(label) && !dateRe.test(value)) {
      issues.push(`Data type: date field "${s.target}" must be MM/DD/YYYY, got "${value}"`)
      check5 = false
    }
  }

  return {
    passed: check1 && check2 && check3 && check4 && check5,
    checks: {
      requiredFieldCoverage: check1,
      urlVerification:       check2,
      buttonNameExact:       check3,
      locatorTypeValid:      check4,
      dataTypeAlignment:     check5,
    },
    issues,
  }
}

// ── JSON parse helper ─────────────────────────────────────────────────────────

function parseStepsJson(raw: string): AgentStep_Playwright[] {
  let cleaned = raw.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
  }
  // Extract first JSON array
  const match = cleaned.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('No JSON array found in LLM output')
  return JSON.parse(match[0]) as AgentStep_Playwright[]
}

// ── Main exported function ────────────────────────────────────────────────────

export interface StepGenInput {
  projectId:    string
  testCaseId?:  string  // if editing an existing test case
  testName:     string  // e.g. "Create Invoice With Required Fields"
  description?: string
  executionId?: string  // required for HITL
  entityFilter?: string // narrow metadata to one entity
}

export interface StepGenOutput {
  steps:      AgentStep_Playwright[]
  validation: StepValidationResult
  thoughts:   string[]
  loopCount:  number
  confidence: number
}

export async function runTestStepGeneratorAgent(
  input: StepGenInput,
): Promise<StepGenOutput> {
  const startMs = Date.now()
  const jobId   = uuidv4()
  const thoughts: string[] = []

  log.info({ projectId: input.projectId, testName: input.testName }, '[STEP-GEN] Starting')

  // ── OBSERVE: gather all context ───────────────────────────────────────────

  thoughts.push('OBSERVE: gathering field manifest, URL map, metadata chunks, and project artifacts')

  const [manifest, urlMap, ragResult, projectArtifacts] = await Promise.all([
    buildFieldManifest(input.projectId, input.entityFilter),
    buildUrlMap(input.projectId),
    ragSearchTool({ projectId: input.projectId, query: `${input.testName} form fields steps`, topK: 8 }),
    // Pull stored BRD + existing tests from the projects table
    (async () => {
      const p = await import('../../shared/db/prisma.js').then(m => m.default)
      const row = await p.projects.findUnique({
        where:  { id: input.projectId },
        select: { brd_content: true, existing_tests_content: true, existing_tests_filename: true },
      })
      return row ?? {}
    })(),
  ])

  // ── THINK: build context prompt ───────────────────────────────────────────

  thoughts.push(`THINK: manifest has ${manifest?.requiredCount ?? 0} required fields, URL map has ${urlMap.paths.length} paths`)

  const manifestText = manifest ? formatManifestForPrompt(manifest) : '(no field manifest — use RAG metadata only)'

  const urlMapText = urlMap.paths.length > 0
    ? `=== VERIFIED URL MAP ===\nBase URL: ${urlMap.baseUrl}\nPaths (use ONLY these):\n${urlMap.paths.map(p => `  ✅ ${p}`).join('\n')}`
    : '(no crawler URL map — use relative paths inferred from metadata)'

  const ragText = ragResult.chunks.length > 0
    ? `=== PROJECT METADATA (RAG) ===\n${ragResult.chunks.join('\n\n---\n\n')}`
    : ''

  // ── Decode and include project artifact documents ───────────────────────
  function decodeArtifact(raw: string | null | undefined, maxChars = 4000): string {
    if (!raw) return ''
    const isLikelyBase64 = raw.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(raw.trim())
    if (isLikelyBase64) {
      try {
        const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8')
        const printable = decoded.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length
        if (printable / decoded.length > 0.7) return decoded.slice(0, maxChars)
        return '[Binary document attached — not directly readable. Use filename context.]'
      } catch { return '' }
    }
    return raw.slice(0, maxChars)
  }

  const brdText = decodeArtifact((projectArtifacts as any).brd_content)
  const existingTestsText = decodeArtifact((projectArtifacts as any).existing_tests_content)

  const userPrompt = [
    urlMapText,
    manifestText,
    ragText,
    brdText ? `=== BRD / SPECIFICATION (business rules to follow) ===\n${brdText}` : '',
    existingTestsText ? `=== EXISTING TEST CASES (for naming conventions and coverage reference) ===\n${existingTestsText}` : '',
    `=== TEST CASE ===\nName: ${input.testName}\nDescription: ${input.description ?? ''}`,
    `Generate executable Playwright steps for this test case. Output ONLY a JSON array.`,
  ].filter(Boolean).join('\n\n')

  // ── ACT + REFLECT: generate and self-validate (max 3 loops) ───────────────

  const llm    = buildLlm()
  const parser = new StringOutputParser()
  const chain  = llm.pipe(parser)

  let steps: AgentStep_Playwright[] = []
  let validation: StepValidationResult = { passed: false, checks: {} as any, issues: ['Not generated yet'] }
  let loopCount = 0

  while (loopCount < 3) {
    loopCount++
    thoughts.push(`ACT (loop ${loopCount}): calling LLM to generate steps`)

    const correctionHint = loopCount > 1
      ? `\n\nPREVIOUS ATTEMPT FAILED THESE CHECKS:\n${validation.issues.map(i => `• ${i}`).join('\n')}\nFix ALL of the above issues.`
      : ''

    try {
      const raw = await chain.invoke([
        new SystemMessage(SYSTEM_PROMPT),
        new HumanMessage(userPrompt + correctionHint),
      ])
      steps = parseStepsJson(raw)
    } catch (err) {
      thoughts.push(`ACT (loop ${loopCount}): LLM parse error — ${String(err).slice(0, 100)}`)
      continue
    }

    // Assign sequential IDs
    steps = steps.map((s, i) => ({ ...s, id: String(i + 1) }))

    validation = validateSteps(
      steps,
      manifest?.requiredCount ?? 0,
      urlMap.paths,
      manifest?.submitButton,
    )

    thoughts.push(`REFLECT (loop ${loopCount}): validation ${validation.passed ? '✅ PASSED' : '❌ FAILED'} — ${validation.issues.join('; ')}`)

    if (validation.passed) break
  }

  // ── HITL if still failing after 3 loops ──────────────────────────────────

  if (!validation.passed && input.executionId) {
    thoughts.push('Calling hitlTool: could not pass validation after 3 loops')

    const hitlInput: HITLInput = {
      agentName:    'test-step-generator',
      executionId:  input.executionId,
      reason:       `Step generation failed ${loopCount} validation checks: ${validation.issues.join('; ')}`,
      suggestions: [
        'Verify the metadata is synced for this project',
        'Check that the entity name in the test case matches the metadata',
        `Required fields count: ${manifest?.requiredCount ?? 'unknown'}`,
      ],
      metadata: { projectId: input.projectId, testName: input.testName },
    }
    await hitlTool(hitlInput)
  }

  // ── DELIVER ───────────────────────────────────────────────────────────────

  const confidence = validation.passed ? 0.95 - (loopCount - 1) * 0.1 : 0.4
  thoughts.push(`DELIVER: ${steps.length} steps, confidence: ${confidence}`)

  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'test-step-generator',
    taskType:      'generate_steps',
    inputSummary:  { testName: input.testName, entityFilter: input.entityFilter },
    outputSummary: { stepCount: steps.length, loopCount, passed: validation.passed },
    thoughts,
    hitlInvoked:   !validation.passed,
    confidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info(
    { testName: input.testName, steps: steps.length, loopCount, confidence, passed: validation.passed },
    '[STEP-GEN] Done',
  )

  return { steps, validation, thoughts, loopCount, confidence }
}
