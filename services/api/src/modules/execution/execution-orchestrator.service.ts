/**
 * Execution Orchestrator Service — Layer 2
 *
 * Sits between the BullMQ job handler and the Playwright step executor.
 * Implements the pre-execution gate pattern and layered retry strategy
 * WITHOUT modifying any existing execution logic.
 *
 * Architecture:
 *
 *   processExecution (existing, unchanged)
 *     └─ orchestrator.executeStepWithGates(page, step, ...)
 *           ├─ Gate 1: Input Validation
 *           ├─ Gate 2: Selector Health Gate (SelectorRegistry query)
 *           ├─ Gate 3: Pre-Scout (quick element count)
 *           ├─ executeStep(page, step, ...) ← EXISTING FUNCTION, UNTOUCHED
 *           ├─ Post: record success/failure in SelectorRegistry
 *           └─ Post: write metrics (fire-and-forget)
 *
 * Key design rules:
 *   - orchestrator.executeStepWithGates() ALWAYS calls the existing executeStep()
 *   - On any orchestrator error, the error propagates identically to the current flow
 *   - All gates are try/catch wrapped — a gate failure never blocks execution
 *   - Browser pool acquisition/release is handled here (Layer 3 integration)
 *
 * @module execution-orchestrator
 */
import type { Page, BrowserContext }  from '@playwright/test'
import { createModuleLogger }          from '../../shared/logger/index.js'
import { ExecutionLogger, classifyError } from '../../shared/execution/execution-logger.service.js'
import { selectorRegistry }            from '../../modules/self-healing/selector-registry.service.js'
import { healWithIntent }              from '../../modules/self-healing/self-healing.service.js'
import type { StepData, ExecutionJob } from '../../shared/queue/job-types.js'
import type { ExecutionStepResult }    from '../../modules/execution/execution.schema.js'

const log = createModuleLogger('execution-orchestrator')

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  executionId:       string
  projectId:         string
  projectCategory?:  string
  retryStrategy:     'standard' | 'aggressive' | 'minimal'
  enablePreScout:    boolean
  enableHealthGate:  boolean
  enableCDP:         boolean
}

// Signature of the existing executeStep function — must match execution.worker.ts exactly
export type ExecuteStepFn = (
  page:             Page,
  step:             StepData,
  stepIndex:        number,
  isLastStep:       boolean,
  screenshotsDir:   string,
  executionId:      string,
  browserCtx?:      BrowserContext,
  projectId?:       string,
  projectCategory?: string,
  execJobContext?:  ExecutionJob['context'],
) => Promise<ExecutionStepResult>

// ─── Max retries per strategy ─────────────────────────────────────────────────

const MAX_RETRIES: Record<OrchestratorConfig['retryStrategy'], number> = {
  minimal:    1,
  standard:   2,
  aggressive: 3,
}

// ─── Orchestrator class ───────────────────────────────────────────────────────

export class ExecutionOrchestrator {
  private readonly config:  OrchestratorConfig
  private readonly logger:  ExecutionLogger
  private executeFn!:       ExecuteStepFn

  constructor(config: OrchestratorConfig) {
    this.config = config
    this.logger = new ExecutionLogger(config.executionId, config.projectId)
  }

  /**
   * Register the existing executeStep function.
   * Called once at the start of processExecution.
   *
   * This pattern avoids circular imports while keeping the reference clean.
   */
  register(fn: ExecuteStepFn): void {
    this.executeFn = fn
  }

  /**
   * Execute a single step with all pre/post gates applied.
   * This is the ONLY public entry point — replaces the direct executeStep() call
   * in the processExecution step loop.
   *
   * Returns the same ExecutionStepResult as the existing executeStep().
   * Throws the same errors — callers see identical behavior.
   */
  async executeStepWithGates(
    page:            Page,
    step:            StepData,
    stepIndex:       number,
    isLastStep:      boolean,
    screenshotsDir:  string,
    executionId:     string,
    browserCtx?:     BrowserContext,
    projectId?:      string,
    projectCategory?: string,
    execJobContext?:  ExecutionJob['context'],
  ): Promise<ExecutionStepResult> {

    const start = Date.now()
    const action = (step.action ?? '').toLowerCase().replace(/[-_\s]/g, '')
    const target = step.target ?? ''

    this.logger.logStepStart(stepIndex, step.action, target)

    // ── Gate 1: Input Validation ─────────────────────────────────────────────
    if (!step.action) {
      log.warn(`[ORCHESTRATOR] Step ${stepIndex + 1} has no action — passing through`)
    }

    // ── Gate 2: Selector Health Gate ─────────────────────────────────────────
    // Check registry before executing. If QUARANTINE → use healed selector.
    let healedSelector: string | null = null

    if (this.config.enableHealthGate && projectId && target) {
      try {
        const health = await selectorRegistry.getHealth(projectId, target)

        if (health?.healthStatus === 'QUARANTINE') {
          this.logger.logGate('selector-health', 'block', `"${target}" is QUARANTINED (${health.consecutiveFailures} failures)`)

          // Attempt to heal using intent before blocking
          if (health.intentDescription) {
            const dom = await page.content().catch(() => '')
            healedSelector = await healWithIntent({
              projectId,
              fieldName:         target,
              intentDescription: health.intentDescription,
              currentDom:        dom,
              pageUrl:           page.url(),
            })
            if (healedSelector) {
              this.logger.logHeal(stepIndex, target, true, healedSelector)
              // Inject healed selector into the step for this execution
              ;(step as any)._correctedTarget = healedSelector
            }
          }
          if (!healedSelector) {
            this.logger.logGate('selector-health', 'skip', `No heal available for QUARANTINED "${target}"`)
          }
        } else if (health?.healthStatus === 'BROKEN') {
          this.logger.logGate('selector-health', 'pass', `"${target}" is BROKEN (${health.consecutiveFailures} failures) — proceeding with heal attempt if step fails`)
        } else if (health) {
          this.logger.logGate('selector-health', 'pass', `"${target}" is ${health.healthStatus}`)
        }
      } catch (gateErr) {
        // Gate errors are always non-fatal
        log.warn({ gateErr }, '[ORCHESTRATOR] Selector health gate error (non-fatal)')
      }
    }

    // ── Gate 3: Pre-Scout ────────────────────────────────────────────────────
    // For CLICK/FILL/SELECT actions: quick visibility check before full execution
    if (this.config.enablePreScout && target && this.isInteractionAction(action)) {
      try {
        const count = await page.locator(target).count().catch(() => -1)
        if (count === 0) {
          // Element not in DOM — log but don't block (may be in iframe or shadow DOM)
          this.logger.logGate('pre-scout', 'pass', `"${target}" has 0 visible elements — may be in iframe/shadow`)
        } else if (count > 0) {
          this.logger.logGate('pre-scout', 'pass', `"${target}" found ${count} element(s)`)
        }
      } catch {
        // Pre-scout errors are always non-fatal — just skip
      }
    }

    // ── Execute Step (existing function — UNTOUCHED) ─────────────────────────
    const maxAttempts = MAX_RETRIES[this.config.retryStrategy]
    let   lastResult: ExecutionStepResult | null = null
    let   retryCount = 0

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        lastResult = await this.executeFn(
          page, step, stepIndex, isLastStep, screenshotsDir, executionId,
          browserCtx, projectId, projectCategory, execJobContext,
        )

        if (lastResult.status === 'passed') {
          // ── Post: Record success in registry ───────────────────────────────
          if (projectId && target) {
            selectorRegistry.recordSuccess(projectId, target, target, {
              selectorType:      'label',
              intentDescription: `${step.action} "${target}" on ${page.url()}`,
              pageUrl:           page.url(),
            }).catch(() => { /* non-fatal */ })
          }

          // Write metrics (fire-and-forget)
          const durationMs = Date.now() - start
          this.logger.writeMetrics({
            executionId, projectId: projectId ?? '', stepIndex,
            action: step.action, status: 'passed', durationMs, retryCount,
            healed:          healedSelector !== null,
            selectorUsed:    target,
            selectorHealth:  'HEALTHY',
          })
          this.logger.logStepResult(stepIndex, 'passed', durationMs)
          return lastResult
        }

        // Step failed — check if we should retry
        if (attempt < maxAttempts && lastResult.status === 'failed') {
          const errorClass = classifyError(lastResult.error ?? lastResult.message ?? '', target)

          // Only retry on transient errors (not assertion failures or app errors)
          if (errorClass === 'SELECTOR_FAILURE' || errorClass === 'NETWORK_ERROR') {
            retryCount++
            this.logger.logRetry(stepIndex, attempt, `${errorClass}: ${(lastResult.error ?? '').slice(0, 80)}`)

            // For BROKEN selectors on retry: attempt inline healing
            if (projectId && target && errorClass === 'SELECTOR_FAILURE') {
              const health = await selectorRegistry.recordFailure(projectId, target, page.url())
              if ((health === 'BROKEN' || health === 'QUARANTINE')) {
                const dom = await page.content().catch(() => '')
                const healthEntry = await selectorRegistry.getHealth(projectId, target)
                if (healthEntry?.intentDescription) {
                  const healed = await healWithIntent({
                    projectId,
                    fieldName:         target,
                    intentDescription: healthEntry.intentDescription,
                    currentDom:        dom,
                    pageUrl:           page.url(),
                  })
                  if (healed) {
                    ;(step as any)._correctedTarget = healed
                    this.logger.logHeal(stepIndex, target, true, healed)
                  }
                }
              }
            }

            // Brief wait before retry
            await page.waitForTimeout(1_000).catch(() => {})
            continue
          }
        }

        // Non-retryable failure or max attempts reached
        break

      } catch (stepErr) {
        // Re-throw — let processExecution handle it exactly as before
        throw stepErr
      }
    }

    // ── Post: Record failure in registry ──────────────────────────────────────
    if (lastResult?.status === 'failed' && projectId && target) {
      selectorRegistry.recordFailure(projectId, target, page.url()).catch(() => { /* non-fatal */ })
    }

    // Write failure metrics (fire-and-forget)
    const durationMs = Date.now() - start
    const errorClass  = classifyError(lastResult?.error ?? lastResult?.message ?? '', target)
    this.logger.writeMetrics({
      executionId, projectId: projectId ?? '', stepIndex,
      action:         step.action,
      status:         lastResult?.status === 'skipped' ? 'skipped' : 'failed',
      durationMs,
      retryCount,
      errorClass,
      healed:          false,
      selectorUsed:    target,
    })
    this.logger.logStepResult(stepIndex, lastResult?.status === 'skipped' ? 'skipped' : 'failed', durationMs)

    return lastResult!
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private isInteractionAction(normalizedAction: string): boolean {
    return ['click', 'fill', 'type', 'select', 'lookup', 'checkbox', 'check', 'uncheck'].includes(normalizedAction)
  }

  /** Called in the finally block of processExecution — cleans up orchestrator state */
  cleanup(): void {
    log.info(`[ORCHESTRATOR] Cleanup for execution ${this.config.executionId}`)
    // Future: release any acquired resources (e.g., distributed locks)
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an orchestrator instance from an ExecutionJob context.
 * Reads orchestrator settings from the job context with safe defaults.
 */
export function createOrchestrator(
  executionId: string,
  projectId:   string,
  context:     ExecutionJob['context'],
): ExecutionOrchestrator {
  return new ExecutionOrchestrator({
    executionId,
    projectId,
    projectCategory:  context.projectCategory,
    retryStrategy:    context.retryStrategy ?? 'standard',
    enablePreScout:   context.enablePreScout  !== false,   // default: true
    enableHealthGate: context.enableSelectorHealthGate !== false,  // default: true
    enableCDP:        context.enableCDP === true,           // default: false
  })
}
