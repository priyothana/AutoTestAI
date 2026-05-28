/**
 * Structured Action Schema — Layer 1 Contract
 *
 * Defines the strict JSON schema that the Intent Parser (LLM) MUST output.
 * The Orchestrator layer consumes this schema — never raw Playwright code.
 *
 * Design principle: LLM translates natural language → StructuredAction[]
 * The Orchestrator deterministically maps StructuredAction → Playwright calls.
 *
 * Zod is used for runtime validation of LLM output.
 */
import { z } from 'zod'

// ─── Supported action types ───────────────────────────────────────────────────

export const SUPPORTED_ACTIONS = [
  // Navigation
  'navigate',
  'goto',
  'open',
  // Interaction
  'click',
  'fill',
  'type',
  'select',
  'lookup',
  'checkbox',
  'check',
  'uncheck',
  // Salesforce-specific
  'selectrecordtype',
  'select_record_type',
  'switchframe',
  'switch_frame',
  // Assertion
  'assert',
  'assert_text',
  'asserttext',
  'assert_toast',
  'asserttoast',
  'assert_visible',
  'assertvisible',
  'verify',
  'verify_text',
  'verifytext',
  // Timing
  'wait',
  // Scroll
  'scroll',
  'scrollto',
  'scroll_to',
] as const

export type ActionType = typeof SUPPORTED_ACTIONS[number]

// ─── Locator types ────────────────────────────────────────────────────────────

export const LOCATOR_TYPES = [
  'label',
  'role',
  'text',
  'css',
  'placeholder',
  'testid',
  'test-id',
  'data-testid',
  'xpath',
  'url',
  '',          // empty = auto-detect
] as const

export type LocatorType = typeof LOCATOR_TYPES[number]

// ─── Salesforce field types ───────────────────────────────────────────────────

export const SF_FIELD_TYPES = [
  'picklist',
  'lookup',
  'lookup_advanced',
  'date',
  'dependent_picklist',
  'filtered_lookup',
  'text',
  'email',
  'phone',
  'currency',
  'number',
  'percent',
  'checkbox',
  'textarea',
  'url',
  'multipicklist',
] as const

export type SfFieldType = typeof SF_FIELD_TYPES[number]

// ─── Individual structured action ────────────────────────────────────────────

export const StructuredActionSchema = z.object({
  /** Step identifier — sequential string ("1", "2", ...) or UUID */
  id: z.string().min(1),

  /** The action to perform — case-insensitive, normalized on parse */
  action: z.string().min(1),

  /** Locator expression or empty string for navigate/wait/assert_toast */
  target: z.string().default(''),

  /** The value to type, select, URL to navigate to, or text to assert */
  value: z.string().default(''),

  /**
   * Playwright locator strategy.
   * 'label' = getByLabel, 'role' = getByRole, 'text' = getByText, etc.
   */
  locator_type: z.string().default(''),

  /**
   * Salesforce field type — used by the execution engine to route
   * to the correct SF Lightning interaction handler.
   * Only required for SF projects with action='select'/'fill'/'lookup'.
   */
  sf_field_type: z.string().optional(),

  /**
   * Optional metadata from the intent parser.
   * Not used by the execution engine — stored for observability only.
   */
  metadata: z.object({
    intent:     z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    source:     z.enum(['llm', 'cache', 'manual']).optional(),
  }).optional(),
})

export type StructuredAction = z.infer<typeof StructuredActionSchema>

// ─── Full structured test output ──────────────────────────────────────────────

export const StructuredTestOutputSchema = z.object({
  /** Name of the test case */
  name: z.string().min(1),

  /** Human-readable description */
  description: z.string().default(''),

  /** Test priority */
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),

  /** List of ordered test steps */
  steps: z.array(StructuredActionSchema).min(1),

  /** Expected outcome after all steps */
  expected_outcome: z.string().default(''),
})

export type StructuredTestOutput = z.infer<typeof StructuredTestOutputSchema>

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Parse and validate a single structured action from LLM output.
 * Returns null if the action is malformed.
 */
export function parseStructuredAction(raw: unknown): StructuredAction | null {
  const result = StructuredActionSchema.safeParse(raw)
  return result.success ? result.data : null
}

/**
 * Parse and validate a full structured test output from LLM.
 * Returns null if the output is invalid.
 */
export function parseStructuredTestOutput(raw: unknown): StructuredTestOutput | null {
  const result = StructuredTestOutputSchema.safeParse(raw)
  return result.success ? result.data : null
}

/**
 * Validate that a steps array conforms to the structured action schema.
 * Returns { valid: true, steps } or { valid: false, errors }.
 */
export function validateSteps(
  steps: unknown[],
): { valid: true; steps: StructuredAction[] } | { valid: false; errors: string[] } {
  const parsed: StructuredAction[] = []
  const errors: string[] = []

  for (let i = 0; i < steps.length; i++) {
    const result = StructuredActionSchema.safeParse(steps[i])
    if (result.success) {
      parsed.push(result.data)
    } else {
      errors.push(`Step ${i + 1}: ${result.error.errors.map(e => e.message).join(', ')}`)
    }
  }

  if (errors.length > 0) return { valid: false, errors }
  return { valid: true, steps: parsed }
}

/**
 * The JSON schema instruction block appended to all LLM system prompts.
 * This enforces that the LLM outputs structured JSON that the engine can parse.
 */
export const STRUCTURED_OUTPUT_SCHEMA_INSTRUCTION = `
════════════════════════════════════════════════════════════
STRUCTURED OUTPUT SCHEMA — MANDATORY — DO NOT SKIP
════════════════════════════════════════════════════════════

Your output MUST be a single valid JSON object. No markdown, no code fences.
The execution engine parses this JSON programmatically.

The "steps" array MUST follow this EXACT structure per item:
{
  "id": "1",                        ← sequential number as string
  "action": "navigate",             ← EXACTLY one of the actions below
  "target": "",                     ← locator or empty for navigate/wait
  "value": "/lightning/o/...",      ← URL, text, wait ms, or assertion text
  "locator_type": "url"             ← EXACTLY one locator type below
}

For Salesforce fill/select/lookup steps, also add:
  "sf_field_type": "picklist"       ← SF field type if applicable

VALID ACTIONS (case-insensitive):
  navigate, click, fill, type, select, lookup, checkbox, wait,
  assert_text, assert_toast, assert_visible, verify_text, scroll

VALID LOCATOR TYPES:
  label, role, text, css, placeholder, testid, xpath, url, ""

EXAMPLES:
  Navigate:   {"id":"1","action":"navigate","target":"","value":"/lightning/o/Account/list","locator_type":"url"}
  Click btn:  {"id":"2","action":"click","target":"role=button, name=New","value":"","locator_type":"role"}
  Fill text:  {"id":"3","action":"fill","target":"Account Name","value":"Test Account","locator_type":"label"}
  SF lookup:  {"id":"4","action":"lookup","target":"Contact Name","value":"John Smith","locator_type":"label","sf_field_type":"lookup"}
  Wait:       {"id":"5","action":"wait","target":"2000","value":"","locator_type":""}
  Assert:     {"id":"6","action":"assert_text","target":"was created","value":"","locator_type":"text"}

DO NOT add any fields not listed above. DO NOT wrap in markdown.
════════════════════════════════════════════════════════════
`.trim()
