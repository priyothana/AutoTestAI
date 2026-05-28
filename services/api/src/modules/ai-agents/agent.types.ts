/**
 * AI Agents — Shared Type Definitions
 *
 * All 5 Phase-1 agents share these types:
 *   1. Orchestrator Agent
 *   2. Test Case Generator Agent
 *   3. Test Step Generator Agent
 *   4. Execution Agent
 *   5. Healing & Analyzer Agent
 *
 * LLM Strategy: OpenAI gpt-4o for all agents
 * Framework: ReAct (Observe → Think → Act → Reflect)
 * HITL: Treated as a callable tool by every agent
 */

// ── Agent identity ─────────────────────────────────────────────────────────────

export type AgentName =
  | 'orchestrator'
  | 'test-case-generator'
  | 'test-step-generator'
  | 'execution'
  | 'healing-analyzer'

// ── ReAct loop primitives ──────────────────────────────────────────────────────

export interface AgentThought {
  thought:  string
  action:   string
  input:    Record<string, unknown>
}

export interface AgentObservation {
  tool:    string
  result:  unknown
  error?:  string
}

export interface AgentStep {
  thought:     AgentThought
  observation: AgentObservation
  timestamp:   string
}

// ── Agent execution state ─────────────────────────────────────────────────────

export interface AgentState {
  agentName:   AgentName
  projectId:   string
  jobId:       string
  steps:       AgentStep[]          // full ReAct trace
  memory:      Record<string, unknown>  // short-term scratchpad
  hitlInvoked: boolean
  confidence:  number               // 0-1, set on DELIVER
  status:      'running' | 'completed' | 'failed' | 'paused'
  result?:     unknown
  error?:      string
}

// ── HITL tool contract ────────────────────────────────────────────────────────

export interface HITLInput {
  agentName:    AgentName
  executionId:  string              // test execution ID for pause-gate
  reason:       string              // why HITL is needed
  failedStep?:  Record<string, unknown>
  errorMessage?: string
  screenshot?:  string             // base64
  suggestions:  string[]           // 2-3 concrete options for the user
  metadata?:    Record<string, unknown>
  timeoutMs?:   number             // default: 600_000 (10 min)
}

export interface HITLOutput {
  action:      'resume' | 'skip' | 'stop'
  humanData?:  Record<string, unknown>  // data the user provided
  timestamp:   string
}

// ── Tool return types ──────────────────────────────────────────────────────────

export interface FieldEntry {
  label:        string
  type:         'input' | 'select' | 'lookup' | 'checkbox' | 'textarea'
  required:     boolean
  options?:     string[]           // valid picklist values
  sampleValue?: string
  locatorType:  'label' | 'role' | 'placeholder'
}

/**
 * A single navigation menu item captured by the crawler from <nav>,
 * [role="navigation"], sidebar containers, or similar structures.
 */
export interface NavigationItem {
  /** Visible text label (e.g. "Users", "Accounts", "Dashboard") */
  text:       string
  /** ARIA role of the element */
  role:       'link' | 'menuitem' | 'button' | 'treeitem' | 'tab' | 'unknown'
  /** href if the element is an <a> tag */
  href?:      string
  /** aria-label attribute if present */
  ariaLabel?: string
  /** Recommended Playwright locator — e.g. "role=link, name=Users" */
  locator:    string
}

export interface FieldManifest {
  entityName:    string
  requiredCount: number
  fields:        FieldEntry[]
  submitButton?: string            // exact primary action button name (e.g. "+ New Lead")
  allButtons?:   string[]         // all button names found on the page (verbatim)
  createUrl?:    string
  listUrl?:      string
  editUrl?:      string
  /** Knowledge Graph: cross-entity relationships — e.g. {"Account": "required_lookup"} */
  relationships?:  Record<string, string>
  /** Knowledge Graph: discovered business rules — e.g. {"stage_required": true} */
  businessRules?:  Record<string, unknown>
  /**
   * Navigation menu items captured by the crawler from the app's sidebar/nav.
   * Used to generate reliable role=link locators for CLICK navigation steps.
   */
  navigationItems?: NavigationItem[]
}

export interface VerifiedUrlMap {
  baseUrl: string
  paths:   string[]
}

// ── Test step shape (mirrors existing schema) ─────────────────────────────────

export interface AgentStep_Playwright {
  id:           string
  action:       string
  target?:      string
  value?:       string
  locator_type?: string
  sf_field_type?: string
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface StepValidationResult {
  passed:   boolean
  checks: {
    requiredFieldCoverage: boolean
    urlVerification:       boolean
    buttonNameExact:       boolean
    locatorTypeValid:      boolean
    dataTypeAlignment:     boolean
  }
  issues: string[]               // human-readable failure descriptions
}

// ── Agent execution audit log (matches agent_executions DB table) ─────────────

export interface AgentExecutionLog {
  projectId:   string
  agentName:   AgentName
  taskType:    string
  inputSummary:  Record<string, unknown>
  outputSummary: Record<string, unknown>
  thoughts:    string[]
  toolCalls:   Array<{ tool: string; input: unknown; output: unknown }>
  hitlInvoked: boolean
  confidence:  number
  tokensUsed:  number
  durationMs:  number
}
