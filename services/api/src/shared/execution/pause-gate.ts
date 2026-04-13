/**
 * Pause Gate — Human-in-the-Loop (HITL) Execution
 *
 * When a test step fails in interactive mode, the execution worker
 * registers a resolver here and suspends (awaits a Promise).
 *
 * The resume route calls `resolvePause(executionId, 'resume' | 'skip')`
 * which unblocks the worker so it can continue from the next step.
 *
 * This works because the BullMQ execution worker runs in the SAME
 * Node.js process as the Fastify HTTP server (both imported in index.ts).
 * No Redis round-trip needed — a simple in-memory Map is sufficient.
 */

export type PauseAction = 'resume' | 'skip' | 'stop'

interface PauseEntry {
  resolve: (action: PauseAction) => void
  timeoutId: ReturnType<typeof setTimeout>
}

/** executionId → pending pause entry */
const pendingPauses = new Map<string, PauseEntry>()

/**
 * Called by the execution worker when a step fails in interactive mode.
 * Returns a Promise that resolves when the user clicks Resume or Skip,
 * or rejects after `timeoutMs` (default 10 minutes).
 */
export function waitForResume(
  executionId: string,
  timeoutMs = 10 * 60 * 1000,
): Promise<PauseAction> {
  return new Promise<PauseAction>((resolve, reject) => {
    // Clear any previous pause entry for this execution
    clearPause(executionId)

    const timeoutId = setTimeout(() => {
      pendingPauses.delete(executionId)
      reject(new Error(`[PAUSE-GATE] Timed out waiting for resume on execution ${executionId}`))
    }, timeoutMs)

    pendingPauses.set(executionId, { resolve, timeoutId })
  })
}

/**
 * Called by the resume/stop API route.
 * Returns true if an execution was waiting, false if no pause was registered.
 */
export function resolvePause(executionId: string, action: PauseAction): boolean {
  const entry = pendingPauses.get(executionId)
  if (!entry) return false

  clearTimeout(entry.timeoutId)
  pendingPauses.delete(executionId)
  entry.resolve(action)
  return true
}

/**
 * Check if an execution is currently paused and waiting.
 */
export function isPaused(executionId: string): boolean {
  return pendingPauses.has(executionId)
}

/**
 * Clear a pause entry (e.g. if the execution was cancelled).
 */
export function clearPause(executionId: string): void {
  const existing = pendingPauses.get(executionId)
  if (existing) {
    clearTimeout(existing.timeoutId)
    pendingPauses.delete(executionId)
  }
}
