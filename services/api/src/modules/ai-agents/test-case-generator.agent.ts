/**
 * Test Case Generator Agent — Phase 1, Agent 2
 *
 * Creates high-level test cases (name + description + priority) grounded in:
 *   - Project RAG metadata (primary source of truth)
 *   - BRD / functional specification documents
 *   - Jira story acceptance criteria
 *   - Existing test cases (for de-duplication)
 *
 * LLM: OpenAI gpt-4o
 * HITL: Triggered if no metadata found or focus areas are ambiguous
 */
import { ChatOpenAI }                from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import { StringOutputParser }         from '@langchain/core/output_parsers'

import { createModuleLogger }    from '../../shared/logger/index.js'
import { ragSearchTool }         from './tools/rag-search.tool.js'
import { getTestCasesByProject, logAgentExecution } from './tools/db-query.tool.js'
import { hitlTool }              from './tools/hitl.tool.js'
import type { HITLInput }        from './agent.types.js'

const log = createModuleLogger('tc-generator-agent')

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GeneratedTestCase {
  name:        string
  description: string
  priority:    'low' | 'medium' | 'high'
  tags:        string[]
  confidence:  number
}

export interface TestCaseGenInput {
  projectId:           string
  count:               number
  focusAreas?:         string[]
  selectedModule?:     string
  brdContent?:         string
  executionId?:        string  // for HITL
  excludeDuplicates?:  boolean // default true
}

export interface TestCaseGenOutput {
  cases:       GeneratedTestCase[]
  thoughts:    string[]
  confidence:  number
  hitlInvoked: boolean
}

// ── LLM ────────────────────────────────────────────────────────────────────────

function buildLlm() {
  return new ChatOpenAI({
    apiKey:      process.env.OPENAI_API_KEY,
    model:       process.env.TC_GEN_MODEL ?? 'gpt-4o',
    temperature: 0.3,
    maxTokens:   3000,
  })
}

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the Test Case Generator Agent for AutoTestAI.

Your job: Generate high-level test cases (NOT step-by-step — just name, description, priority).

Sources (use ALL provided):
1. PROJECT METADATA (via RAG) — primary source of truth
2. BRD / Functional Specification — business rules
3. Existing Test Cases — avoid duplication
4. Focus Areas — constrain generation scope

Rules:
- NEVER invent entities or pages not in the metadata
- Each test case must describe a REAL business workflow
- Use action-oriented names: "Create Invoice With Required Fields and Verify Success"
- Tags: CRUD | Negative | EdgeCase | Workflow | ReadOnly | Integration
- Do NOT generate smoke tests or UI-only tests without business value
- If metadata is empty, set confidence < 0.5 for all generated cases

Output ONLY valid JSON array (no markdown):
[{ 
  "name": string, 
  "description": string, 
  "priority": "low|medium|high", 
  "tags": string[], 
  "confidence": 0.0-1.0 
}]`

// ── De-duplication ─────────────────────────────────────────────────────────────

function isDuplicate(
  candidate: string,
  existingNames: string[],
  threshold = 0.7,
): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim()
  const a = normalize(candidate)
  for (const ex of existingNames) {
    const b = normalize(ex)
    // Simple word-overlap similarity
    const aWords = new Set(a.split(/\s+/))
    const bWords = new Set(b.split(/\s+/))
    const intersection = [...aWords].filter(w => bWords.has(w)).length
    const union = new Set([...aWords, ...bWords]).size
    if (union > 0 && intersection / union >= threshold) return true
  }
  return false
}

// ── Main function ─────────────────────────────────────────────────────────────

export async function runTestCaseGeneratorAgent(
  input: TestCaseGenInput,
): Promise<TestCaseGenOutput> {
  const startMs   = Date.now()
  const thoughts: string[] = []
  let hitlInvoked = false

  log.info(
    { projectId: input.projectId, count: input.count, focusAreas: input.focusAreas },
    '[TC-GEN] Starting',
  )

  // ── OBSERVE ───────────────────────────────────────────────────────────────

  thoughts.push('OBSERVE: loading metadata, BRD context, existing test cases, and project artifacts')

  const [ragResult, existingCases, projectArtifacts] = await Promise.all([
    ragSearchTool({
      projectId: input.projectId,
      query:     `${input.selectedModule ?? ''} ${(input.focusAreas ?? []).join(' ')} test cases workflows`,
      topK:      12,
    }),
    input.excludeDuplicates !== false
      ? getTestCasesByProject(input.projectId, 100)
      : Promise.resolve([]),
    // Load BRD + existing tests from DB (complement any caller-provided brdContent)
    (async () => {
      const { default: p } = await import('../../shared/db/prisma.js')
      const row = await p.projects.findUnique({
        where:  { id: input.projectId },
        select: { brd_content: true, existing_tests_content: true },
      })
      return row ?? {}
    })(),
  ])

  thoughts.push(`OBSERVE: ${ragResult.count} RAG chunks, ${existingCases.length} existing test cases`)

  // ── Decode artifact helper (handles base64-encoded binary uploads) ────────
  function decodeArtifact(raw: string | null | undefined, maxChars = 4000): string {
    if (!raw) return ''
    const isLikelyBase64 = raw.length > 100 && /^[A-Za-z0-9+/=\n\r]+$/.test(raw.trim())
    if (isLikelyBase64) {
      try {
        const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8')
        const printable = decoded.split('').filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length
        if (printable / decoded.length > 0.7) return decoded.slice(0, maxChars)
        return '[Binary document — not directly readable. Use filename context.]'
      } catch { return '' }
    }
    return raw.slice(0, maxChars)
  }

  // Merge caller-provided brdContent with DB-stored content (caller wins)
  const resolvedBrd = decodeArtifact(input.brdContent ?? (projectArtifacts as any).brd_content)
  const resolvedExistingTests = decodeArtifact((projectArtifacts as any).existing_tests_content)

  // ── HITL if no metadata ────────────────────────────────────────────────────

  if (ragResult.count === 0 && input.executionId) {
    thoughts.push('THINK: no metadata — calling hitlTool')
    const hitlInput: HITLInput = {
      agentName:   'test-case-generator',
      executionId: input.executionId,
      reason:      'No project metadata found — cannot generate grounded test cases',
      suggestions: [
        'Sync project metadata first (Settings → Metadata Sync)',
        'Crawl the application URLs before generating',
        'Provide a BRD document to generate from specification only',
      ],
    }
    await hitlTool(hitlInput)
    hitlInvoked = true
  }

  // ── THINK: build prompt ───────────────────────────────────────────────────

  const existingNames = existingCases.map(c => c.name)
  const focusAreasText = input.focusAreas?.length
    ? `Focus areas: ${input.focusAreas.join(', ')}`
    : 'Focus areas: CRUD, Workflow, Negative'
  const moduleText = input.selectedModule ? `Module/Entity: ${input.selectedModule}` : ''

  const userPrompt = [
    ragResult.chunks.length > 0
      ? `=== PROJECT METADATA ===\n${ragResult.chunks.join('\n\n---\n')}`
      : '(no metadata — generate from specification only)',
    resolvedBrd ? `\n=== BRD / SPECIFICATION ===\n${resolvedBrd.slice(0, 3000)}` : '',
    resolvedExistingTests ? `\n=== EXISTING TEST PATTERNS (for naming conventions and coverage reference) ===\n${resolvedExistingTests.slice(0, 2000)}` : '',
    existingNames.length > 0
      ? `\n=== EXISTING TEST CASES (avoid duplicating) ===\n${existingNames.slice(0, 30).join('\n')}`
      : '',
    `\n=== GENERATION REQUEST ===`,
    focusAreasText,
    moduleText,
    `Count: ${input.count}`,
    `Generate ${input.count} high-quality test cases. Output ONLY JSON array.`,
  ].filter(Boolean).join('\n')

  // ── ACT ───────────────────────────────────────────────────────────────────

  thoughts.push('ACT: generating test cases with LLM')
  let cases: GeneratedTestCase[] = []

  try {
    const llm    = buildLlm()
    const parser = new StringOutputParser()
    const raw    = await llm.pipe(parser).invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(userPrompt),
    ])

    let cleaned = raw.trim()
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.split('\n').filter(l => !l.trim().startsWith('```')).join('\n')
    }
    const match = cleaned.match(/\[[\s\S]*\]/)
    if (match) cases = JSON.parse(match[0]) as GeneratedTestCase[]
  } catch (err) {
    thoughts.push(`ACT: parse error — ${String(err).slice(0, 80)}`)
  }

  // ── REFLECT: de-duplicate ─────────────────────────────────────────────────

  thoughts.push(`REFLECT: de-duplicating ${cases.length} candidates against ${existingNames.length} existing`)
  const deduped = cases.filter(c => !isDuplicate(c.name, existingNames))
  thoughts.push(`REFLECT: ${deduped.length} unique cases after de-duplication`)

  const avgConfidence = deduped.length > 0
    ? deduped.reduce((s, c) => s + (c.confidence ?? 0.7), 0) / deduped.length
    : 0

  // ── DELIVER ───────────────────────────────────────────────────────────────

  await logAgentExecution({
    projectId:     input.projectId,
    agentName:     'test-case-generator',
    taskType:      'generate_test_cases',
    inputSummary:  { count: input.count, focusAreas: input.focusAreas, module: input.selectedModule },
    outputSummary: { generated: deduped.length, duplicatesRemoved: cases.length - deduped.length },
    thoughts,
    hitlInvoked,
    confidence:    avgConfidence,
    tokensUsed:    0,
    durationMs:    Date.now() - startMs,
  })

  log.info(
    { projectId: input.projectId, count: deduped.length, avgConfidence },
    '[TC-GEN] Done',
  )

  return { cases: deduped, thoughts, confidence: avgConfidence, hitlInvoked }
}
