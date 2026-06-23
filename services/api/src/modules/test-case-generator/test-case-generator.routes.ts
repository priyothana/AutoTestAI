/**
 * Test-Case Generator Module — Routes
 *
 * Endpoints:
 *   POST /api/v1/projects/:projectId/generate-test-cases
 *     Body: { count, focusAreas, suiteName?, brdContent?, existingTestsContent?, useJira }
 *     Returns: 202 { jobId, suiteName }
 *
 *   GET  /api/v1/projects/:projectId/generate-test-cases/status/:jobId
 *     Returns: { status, progress, message, generatedCount, suiteId?, testCaseIds?, error? }
 *
 *   GET  /api/v1/projects/:projectId/jira/stories-for-generation
 *     Returns: { stories: [...] }
 *     (Quick preview of available Jira stories before triggering generation)
 *
 *   POST /api/v1/projects/:projectId/generate-steps-for-selected
 *     Body: { testCaseIds: string[] }
 *     Returns: { generated: number, failed: number }
 *     (Generates test steps for the selected test cases — called when user clicks "Add Selected to Tests")
 */
import type { FastifyInstance } from 'fastify'
import { z }                   from 'zod'
import {
  enqueueGenerationJob,
  getJobStatus,
  fetchJiraStoriesForProject,
  generateStepsForTestCases,
  generateModulesForProject,
} from './test-case-generator.service.js'

// ── Request body schema ───────────────────────────────────────────────────────

const GenerateTestCasesBodySchema = z.object({
  /**
   * Number of test cases to generate (1–200).
   * The frontend no longer exposes a user-controlled slider — the backend
   * generates a full list (default 30) covering the entire project scope.
   */
  count:                z.number().int().min(1).max(200).default(30),
  /** Optional focus areas (kept for backward compat — module supersedes these) */
  focusAreas:           z.array(z.string()).default([]),
  /** Selected module name — narrows generation to a specific module/feature */
  selectedModule:       z.string().max(200).optional(),
  /** Custom suite name (optional) */
  suiteName:            z.string().max(255).optional(),
  /** BRD content extracted on the frontend (plain text, ≤50 KB) */
  brdContent:           z.string().max(50_000).optional(),
  /** Existing test cases content (plain text, ≤30 KB) */
  existingTestsContent: z.string().max(30_000).optional(),
  /** Whether to pull Jira stories from the connected board */
  useJira:              z.boolean().default(false),
})

const GenerateStepsForSelectedSchema = z.object({
  /** IDs of the test cases that the user selected to add to Tests tab */
  testCaseIds:    z.array(z.string().uuid()).min(1).max(100),
  /** Optional: module that was selected when these test cases were generated.
   *  Passed back so step generation stays scoped to the same module. */
  selectedModule: z.string().max(200).optional(),
  /** Optional: BRD content passed in request */
  brdContent:     z.string().max(50_000).optional(),
  /** Optional: existing tests content passed in request */
  existingTestsContent: z.string().max(30_000).optional(),
})

// ── Route plugin ─────────────────────────────────────────────────────────────

export async function testCaseGeneratorRoutes(app: FastifyInstance): Promise<void> {

  // ── POST /projects/:projectId/generate-test-cases ────────────────────────

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/generate-test-cases',
    async (request, reply) => {
      try {
        const { projectId } = request.params
        const body = GenerateTestCasesBodySchema.parse(request.body)

        const { jobId, suiteName } = await enqueueGenerationJob({
          projectId,
          suiteName:             body.suiteName,
          count:                 body.count,
          focusAreas:            body.focusAreas,
          selectedModule:        body.selectedModule,
          brdContent:            body.brdContent,
          existingTestsContent:  body.existingTestsContent,
          useJira:               body.useJira,
        })

        return reply.status(202).send({
          jobId,
          suiteName,
          message: 'Test case generation started. Poll /status/:jobId for progress.',
        })
      } catch (err: any) {
        if (err?.statusCode) return reply.status(err.statusCode).send({ detail: err.message })
        if (err?.name === 'ZodError') return reply.status(400).send({ detail: err.errors })
        throw err
      }
    },
  )

  // ── GET /projects/:projectId/generate-test-cases/status/:jobId ────────────

  app.get<{ Params: { projectId: string; jobId: string } }>(
    '/projects/:projectId/generate-test-cases/status/:jobId',
    async (request, reply) => {
      const { jobId } = request.params
      const status = getJobStatus(jobId)

      if (!status) {
        return reply.status(404).send({ detail: 'Job not found. It may have expired or never existed.' })
      }

      return reply.send(status)
    },
  )

  // ── GET /projects/:projectId/jira/stories-for-generation ─────────────────
  // Lightweight preview of Jira stories available for the project.

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/jira/stories-for-generation',
    async (request, reply) => {
      const { projectId } = request.params
      try {
        const stories = await fetchJiraStoriesForProject(projectId)
        return reply.send({ stories, count: stories.length })
      } catch (err: any) {
        return reply.status(500).send({ detail: 'Failed to fetch Jira stories', error: err?.message })
      }
    },
  )

  // ── POST /projects/:projectId/generate-steps-for-selected ─────────────────
  // Called when the user clicks "Add Selected to Tests".
  // Generates Playwright test steps for each selected test case (which currently
  // has only a name/description/priority) and persists them to the DB.

  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/generate-steps-for-selected',
    async (request, reply) => {
      try {
        const { projectId } = request.params
        const body = GenerateStepsForSelectedSchema.parse(request.body)
        const result = await generateStepsForTestCases(
          projectId,
          body.testCaseIds,
          body.selectedModule,
          body.brdContent,
          body.existingTestsContent,
        )
        return reply.send(result)
      } catch (err: any) {
        if (err?.name === 'ZodError') return reply.status(400).send({ detail: err.errors })
        throw err
      }
    },
  )

  // ── GET /projects/:projectId/generate-modules ─────────────────────────────
  // Auto-generates a list of meaningful module/feature names for this project
  // by analyzing metadata via LLM. Called once when the Generate tab opens.

  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/generate-modules',
    async (request, reply) => {
      const { projectId } = request.params
      try {
        const modules = await generateModulesForProject(projectId)
        return reply.send({ modules })
      } catch (err: any) {
        return reply.status(500).send({ detail: 'Failed to generate modules', error: err?.message })
      }
    },
  )
}
