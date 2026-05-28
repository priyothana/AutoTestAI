/**
 * Execution Logger Service — Layer 2 Observability
 *
 * Structured, correlated logging for the 4-layer execution pipeline.
 * Emits structured JSON logs with layer context, and asynchronously
 * persists per-step metrics to the execution_metrics table.
 *
 * Design: all DB writes are fire-and-forget (non-blocking) — a logger
 * failure must NEVER delay or break a test execution step.
 */
import prisma               from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'

const log = createModuleLogger('execution-logger')

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExecutionLayer = 'intent' | 'orchestrator' | 'browser' | 'healing'

export type ErrorClass =
  | 'SELECTOR_FAILURE'     // locator not found, element not visible
  | 'NETWORK_ERROR'        // timeout, ERR_ABORTED, connection refused
  | 'ASSERTION_ERROR'      // text not matching, toast not found
  | 'SESSION_ERROR'        // login redirect, 401/403
  | 'APPLICATION_ERROR'    // SF validation rule, required field missing
  | 'INFRASTRUCTURE'       // browser crash, CDP disconnect
  | 'UNKNOWN'

export interface StepMetrics {
  executionId:    string
  projectId:      string
  stepIndex:      number
  action:         string
  status:         'passed' | 'failed' | 'skipped' | 'healed'
  durationMs:     number
  retryCount?:    number
  errorClass?:    ErrorClass
  healed?:        boolean
  selectorUsed?:  string
  selectorHealth?: string
}

// ─── Error classification engine ──────────────────────────────────────────────

/**
 * Deterministically classify an error message into an ErrorClass.
 * Used by the orchestrator to choose the correct recovery path.
 */
export function classifyError(errorMessage: string, stepTarget?: string): ErrorClass {
  const combined = `${errorMessage} ${stepTarget ?? ''}`.toLowerCase()

  // Selector/locator failures (most common)
  if (/locator.*not.*found|no element|cannot find|element.*not found|not visible|all.*strateg|smartwebapp/i.test(combined)) {
    return 'SELECTOR_FAILURE'
  }

  // Network / timing errors
  if (/timeout|timed.*out|err_aborted|connection.*refused|net::err/i.test(combined)) {
    return 'NETWORK_ERROR'
  }

  // Assertion failures
  if (/assert|expect.*but|expected.*received|not.*contain|toast.*not/i.test(combined)) {
    return 'ASSERTION_ERROR'
  }

  // Session / auth errors
  if (/session.*expired|login.*required|auth.*challenge|401|403|unauthorized/i.test(combined)) {
    return 'SESSION_ERROR'
  }

  // Application-level errors (SF validation rules, required fields)
  if (/validation.*fail|required.*field|field.*required|must not be blank|save.*fail/i.test(combined)) {
    return 'APPLICATION_ERROR'
  }

  // Browser infrastructure
  if (/browser.*crash|page.*crash|cdp.*disconnect|protocol.*error|target.*closed/i.test(combined)) {
    return 'INFRASTRUCTURE'
  }

  return 'UNKNOWN'
}

// ─── Logger class ─────────────────────────────────────────────────────────────

export class ExecutionLogger {
  private readonly executionId: string
  private readonly projectId:   string

  constructor(executionId: string, projectId: string) {
    this.executionId = executionId
    this.projectId   = projectId
  }

  /** Log a gate decision from the orchestrator */
  logGate(gateName: string, result: 'pass' | 'block' | 'skip', reason?: string): void {
    log.info(
      { executionId: this.executionId, gate: gateName, result, reason },
      `[ORCHESTRATOR] Gate "${gateName}" → ${result}${reason ? `: ${reason}` : ''}`,
    )
  }

  /** Log a step starting */
  logStepStart(stepIndex: number, action: string, target?: string): void {
    log.info(
      { executionId: this.executionId, stepIndex: stepIndex + 1, action, target },
      `[ORCHESTRATOR] Step ${stepIndex + 1} START: ${action}${target ? ` "${target.slice(0, 60)}"` : ''}`,
    )
  }

  /** Log a step result */
  logStepResult(stepIndex: number, status: StepMetrics['status'], durationMs: number, details?: object): void {
    const icon = status === 'passed' || status === 'healed' ? '✅' : status === 'skipped' ? '⏭' : '❌'
    log.info(
      { executionId: this.executionId, stepIndex: stepIndex + 1, status, durationMs, ...details },
      `[ORCHESTRATOR] Step ${stepIndex + 1} ${icon} ${status.toUpperCase()} (${durationMs}ms)`,
    )
  }

  /** Log a retry decision */
  logRetry(stepIndex: number, attempt: number, reason: string): void {
    log.warn(
      { executionId: this.executionId, stepIndex: stepIndex + 1, attempt, reason },
      `[ORCHESTRATOR] Step ${stepIndex + 1} RETRY attempt ${attempt}: ${reason}`,
    )
  }

  /** Log a healing event */
  logHeal(stepIndex: number, fieldName: string, success: boolean, newSelector?: string): void {
    const icon = success ? '🩹' : '💔'
    log.info(
      { executionId: this.executionId, stepIndex: stepIndex + 1, fieldName, success, newSelector },
      `[HEALING] ${icon} Step ${stepIndex + 1} selector "${fieldName}" ${success ? 'healed' : 'heal failed'}`,
    )
  }

  /**
   * Persist step metrics to execution_metrics table.
   * FIRE-AND-FORGET — never awaited in the hot path.
   */
  writeMetrics(metrics: StepMetrics): void {
    prisma.execution_metrics.create({
      data: {
        execution_id:    metrics.executionId,
        project_id:      metrics.projectId,
        step_index:      metrics.stepIndex,
        action:          metrics.action,
        status:          metrics.status,
        duration_ms:     metrics.durationMs,
        retry_count:     metrics.retryCount ?? 0,
        error_class:     metrics.errorClass,
        healed:          metrics.healed ?? false,
        selector_used:   metrics.selectorUsed?.slice(0, 500),
        selector_health: metrics.selectorHealth,
      },
    }).catch((err: unknown) => {
      // Non-fatal: metrics loss is acceptable vs. blocking test execution
      log.warn({ err }, '[ORCHESTRATOR] Failed to write step metrics (non-fatal)')
    })
  }
}
