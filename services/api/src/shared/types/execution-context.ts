/**
 * ExecutionContext Type
 *
 * Re-exports the ExecutionContext from job-types for convenience.
 * Used by test-run.service.ts to build the context before enqueuing.
 */
export type { ExecutionContext, StepData } from '../queue/job-types.js'
