/**
 * HITL Tool — Human-in-the-Loop as a Callable Agent Tool
 *
 * Any of the 5 agents can call this tool when they reach the limit of autonomy.
 * Wraps the existing pause-gate.ts infrastructure so no new HTTP endpoints
 * are needed — the existing /executions/:id/resume route still works.
 *
 * When called, this tool:
 *   1. Registers a pause on the pause-gate for the given executionId
 *   2. Optionally publishes a rich context payload to Redis (for SSE push to frontend)
 *   3. Awaits the human's action (resume / skip / stop)
 *   4. Returns the human's decision + any data they provided
 */
import { waitForResume, clearPause } from '../../../shared/execution/pause-gate.js'
import { createModuleLogger }        from '../../../shared/logger/index.js'
import prisma                        from '../../../shared/db/prisma.js'
import type { HITLInput, HITLOutput } from '../agent.types.js'

const log = createModuleLogger('hitl-tool')

// ── Shared in-memory store for HITL context (consumed by SSE endpoint) ─────────
// Maps executionId → rich HITL context payload
export const hitlContextStore = new Map<string, HITLInput & { createdAt: string }>()

/**
 * HITL Tool — pause execution and wait for human intervention.
 *
 * @param input  Rich context for the UI (reason, screenshot, suggestions, etc.)
 * @returns      Human's decision (resume/skip/stop) + any data they supplied
 */
export async function hitlTool(input: HITLInput): Promise<HITLOutput> {
  const {
    agentName,
    executionId,
    reason,
    suggestions,
    timeoutMs = 10 * 60 * 1000,
  } = input

  log.info(
    { agentName, executionId, reason },
    '[HITL] Agent requested human intervention',
  )

  // 1. Store rich context so the frontend SSE endpoint can push it
  hitlContextStore.set(executionId, {
    ...input,
    createdAt: new Date().toISOString(),
  })

  // 2. Update execution status to PAUSED in DB (non-fatal if it fails)
  try {
    const isExecution = await prisma.executions.findUnique({
      where: { id: executionId },
      select: { id: true },
    }).catch(() => null)

    if (isExecution) {
      await prisma.executions.update({
        where: { id: executionId },
        data:  { status: 'PAUSED' },
      })
    } else {
      await prisma.test_runs.update({
        where: { id: executionId },
        data:  { status: 'paused' },
      })
    }
  } catch (err) {
    log.warn({ err }, '[HITL] Could not update execution status to PAUSED in executions or test_runs (non-fatal)')
  }

  // 3. Log HITL invocation to agent_executions audit table
  try {
    await (prisma as any).agent_executions?.create({
      data: {
        project_id:    input.metadata?.projectId as string ?? null,
        agent_name:    agentName,
        task_type:     'hitl_invoked',
        input_summary: { reason, suggestions, failedStep: input.failedStep } as object,
        output_summary: {} as object,
        hitl_invoked:  true,
        confidence:    0,
        tokens_used:   0,
        duration_ms:   0,
      },
    }).catch(() => { /* table may not exist yet */ })
  } catch { /* non-fatal */ }

  // 4. Wait for human action via pause-gate
  let action: 'resume' | 'skip' | 'stop' = 'skip'
  try {
    action = await waitForResume(executionId, timeoutMs) as 'resume' | 'skip' | 'stop'
    log.info({ agentName, executionId, action }, '[HITL] Human responded')
  } catch (err) {
    log.warn({ err }, '[HITL] Timed out waiting for human — defaulting to skip')
    action = 'skip'
  } finally {
    hitlContextStore.delete(executionId)
    clearPause(executionId)
  }

  // 5. Update execution status back to RUNNING
  try {
    if (action !== 'stop') {
      const isExecution = await prisma.executions.findUnique({
        where: { id: executionId },
        select: { id: true },
      }).catch(() => null)

      if (isExecution) {
        await prisma.executions.update({
          where: { id: executionId },
          data:  { status: 'RUNNING' },
        })
      } else {
        await prisma.test_runs.update({
          where: { id: executionId },
          data:  { status: 'running' },
        })
      }
    }
  } catch { /* non-fatal */ }

  return {
    action,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Get the current HITL context for an execution (used by SSE endpoint).
 */
export function getHitlContext(executionId: string) {
  return hitlContextStore.get(executionId) ?? null
}
