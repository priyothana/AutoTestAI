/**
 * Execution Worker — BullMQ Consumer
 *
 * This is the ONLY place where Playwright runs in the entire codebase.
 *
 * Consumes jobs from `execution-queue`:
 *   1. Marks execution RUNNING in DB
 *   2. Launches Chromium headlessly via @playwright/test
 *   3. Executes each step, capturing screenshots + logs per step
 *   4. Writes ExecutionResult JSON to DB (result_metadata column)
 *   5. On failure → enqueues HealingJob to `healing-queue`
 *
 * Start with: npm run worker:execution
 *
 * Port of Python: execution_runner.py + celery_tasks/run_test.py
 */
import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { Worker, Job, Queue } from 'bullmq'
import { chromium, Browser, BrowserContext, Page } from '@playwright/test'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import type { ExecutionJob, HealingJob, StepData } from '../shared/queue/job-types.js'
import type { ExecutionStepResult } from '../modules/execution/execution.schema.js'

const log = createModuleLogger('execution-worker')

// ─── Paths ──────────────────────────────────────────────────────────────────

const BASE_DIR = path.resolve(process.cwd(), 'static')
const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'screenshots')
const TRACES_DIR = path.resolve(BASE_DIR, 'traces')

for (const dir of [SCREENSHOTS_DIR, TRACES_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// ─── Healing queue producer ──────────────────────────────────────────────────

const healingQueue = new Queue<HealingJob>(QUEUES.HEALING, getRedisOptions())

// ─── Action executor ─────────────────────────────────────────────────────────

/**
 * Execute a single step on the Playwright Page.
 * Returns step result. Never throws — errors are captured into the result.
 */
async function executeStep(
  page: Page,
  step: StepData,
  stepIndex: number,
  screenshotsDir: string,
): Promise<ExecutionStepResult> {
  const start = Date.now()
  const action = step.action.toLowerCase().replace(/[-_\s]/g, '')
  const target = step.target ?? ''
  const value = step.value ?? ''
  let screenshotPath: string | null = null

  try {
    switch (action) {
      case 'navigate':
      case 'goto':
      case 'open': {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        break
      }

      case 'click': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.scrollIntoViewIfNeeded()
        await locator.click({ timeout: 10_000 })
        break
      }

      case 'type':
      case 'fill':
      case 'input': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.fill(value, { timeout: 10_000 })
        break
      }

      case 'select':
      case 'selectoption': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.selectOption(value, { timeout: 10_000 })
        break
      }

      case 'check':
      case 'checkbox': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.check({ timeout: 10_000 })
        break
      }

      case 'uncheck': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.uncheck({ timeout: 10_000 })
        break
      }

      case 'hover': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        await locator.hover({ timeout: 10_000 })
        break
      }

      case 'press':
      case 'keyboard': {
        await page.keyboard.press(value || target)
        break
      }

      case 'wait':
      case 'waitfor': {
        // value is ms if numeric, else wait for selector
        if (/^\d+$/.test(value)) {
          await page.waitForTimeout(parseInt(value, 10))
        } else {
          const selector = value || target
          await page.waitForSelector(selector, { timeout: 30_000 })
        }
        break
      }

      case 'assert':
      case 'assertvisible':
      case 'asserttext': {
        const locator = page.locator(target).first()
        await locator.waitFor({ state: 'visible', timeout: 10_000 })
        if (value) {
          const text = await locator.textContent()
          if (!text?.includes(value)) {
            throw new Error(`Assertion failed: element "${target}" text "${text}" does not contain "${value}"`)
          }
        }
        break
      }

      case 'asserturl': {
        const currentUrl = page.url()
        if (!currentUrl.includes(target)) {
          throw new Error(`URL assertion failed: "${currentUrl}" does not contain "${target}"`)
        }
        break
      }

      case 'scroll': {
        if (target) {
          const locator = page.locator(target).first()
          await locator.scrollIntoViewIfNeeded()
        } else {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        }
        break
      }

      case 'screenshot': {
        // Explicit screenshot step
        const ssFile = `step-${stepIndex}-explicit-${Date.now()}.png`
        screenshotPath = path.join(screenshotsDir, ssFile)
        await page.screenshot({ path: screenshotPath, fullPage: false })
        screenshotPath = `/screenshots/${ssFile}`
        break
      }

      case 'clearcookies': {
        await page.context().clearCookies()
        break
      }

      default: {
        log.warn(`[EXEC] Unknown action "${step.action}" at step ${stepIndex + 1} — skipping`)
        return {
          step: stepIndex + 1,
          action: step.action,
          target: target || null,
          value: value || null,
          status: 'skipped',
          message: `Unknown action "${step.action}" — skipped`,
          duration_ms: Date.now() - start,
          screenshot_path: null,
          error: null,
        }
      }
    }

    // Capture screenshot after each step (on-step mode)
    const ssFile = `step-${stepIndex + 1}-${Date.now()}.png`
    const ssAbsPath = path.join(screenshotsDir, ssFile)
    try {
      await page.screenshot({ path: ssAbsPath, fullPage: false })
      screenshotPath = `/screenshots/${ssFile}`
    } catch {
      // Non-fatal — screenshot failure should not fail the step
    }

    return {
      step: stepIndex + 1,
      action: step.action,
      target: target || null,
      value: value || null,
      status: 'passed',
      message: `Step ${stepIndex + 1} passed`,
      duration_ms: Date.now() - start,
      screenshot_path: screenshotPath,
      error: null,
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err)

    // Attempt screenshot on failure for debugging
    const failSsFile = `step-${stepIndex + 1}-FAILED-${Date.now()}.png`
    const failSsPath = path.join(screenshotsDir, failSsFile)
    try {
      await page.screenshot({ path: failSsPath, fullPage: false })
      screenshotPath = `/screenshots/${failSsFile}`
    } catch {
      /* ignore */
    }

    return {
      step: stepIndex + 1,
      action: step.action,
      target: target || null,
      value: value || null,
      status: 'failed',
      message: `Step ${stepIndex + 1} failed: ${errMsg}`,
      duration_ms: Date.now() - start,
      screenshot_path: screenshotPath,
      error: errMsg,
    }
  }
}

// ─── Salesforce login ────────────────────────────────────────────────────────

async function loginToSalesforce(page: Page, context: ExecutionJob['context']): Promise<void> {
  const loginUrl = context.sfLoginUrl ?? 'https://login.salesforce.com'

  if (context.sfAccessToken && context.sfInstanceUrl) {
    // Inject access token via cookie (preferred — avoids login page)
    await page.goto(context.sfInstanceUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.context().addCookies([
      {
        name: 'sid',
        value: context.sfAccessToken,
        domain: new URL(context.sfInstanceUrl).hostname,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
      },
    ])
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    log.info('[EXEC-SF] Injected Salesforce session cookie')
    return
  }

  if (context.sfUsername && context.sfPassword) {
    await page.goto(`${loginUrl}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.fill('#username', context.sfUsername)
    await page.fill('#password', context.sfPassword)
    await page.click('#Login')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    log.info('[EXEC-SF] Logged in with username/password')
    return
  }

  log.warn('[EXEC-SF] No Salesforce credentials — proceeding without login')
}

// ─── WebApp login ─────────────────────────────────────────────────────────────

async function loginToWebApp(page: Page, context: ExecutionJob['context']): Promise<void> {
  if (!context.webLoginUrl || !context.webUsername || !context.webPassword) {
    log.info('[EXEC-WEB] No web credentials — skipping login')
    return
  }

  const strategy = context.webLoginStrategy ?? 'form'

  if (strategy === 'basic_auth') {
    const url = new URL(context.webLoginUrl)
    url.username = context.webUsername
    url.password = context.webPassword
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    return
  }

  // Default: form-based login
  await page.goto(context.webLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // Heuristic: fill first visible username/email + password input, then submit
  const emailInput = page.locator('input[type="email"], input[name*="user"], input[name*="email"]').first()
  const passwordInput = page.locator('input[type="password"]').first()

  try {
    await emailInput.waitFor({ state: 'visible', timeout: 8_000 })
    await emailInput.fill(context.webUsername)
    await passwordInput.fill(context.webPassword)
    await page.keyboard.press('Enter')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    log.info('[EXEC-WEB] Form login submitted')
  } catch {
    log.warn('[EXEC-WEB] Login form heuristic failed — continuing without login')
  }
}

// ─── Core worker function ─────────────────────────────────────────────────────

async function processExecution(job: Job<ExecutionJob>): Promise<void> {
  const { testRunId: executionId, testCaseId, projectId, triggeredBy, context } = job.data
  log.info(`[EXEC] Starting execution ${executionId} (testCase=${testCaseId}, project=${projectId}, trigger=${triggeredBy})`)

  const startTime = Date.now()

  // Mark RUNNING
  await prisma.executions.update({
    where: { id: executionId },
    data: {
      status: 'RUNNING',
      result_metadata: { triggered_by: triggeredBy } as object,
    },
  })

  let browser: Browser | null = null
  let browserContext: BrowserContext | null = null
  const stepResults: ExecutionStepResult[] = []
  let finalStatus: 'PASSED' | 'FAILED' | 'ERROR' = 'PASSED'
  let errorMessage: string | null = null
  let tracePath: string | null = null

  // Per-execution screenshot dir
  const execScreenDir = path.join(SCREENSHOTS_DIR, executionId)
  fs.mkdirSync(execScreenDir, { recursive: true })

  try {
    browser = await chromium.launch({ headless: true })

    browserContext = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
      recordVideo: undefined,
    })

    // Enable Playwright trace
    const traceFile = path.join(TRACES_DIR, `${executionId}.zip`)
    await browserContext.tracing.start({ screenshots: true, snapshots: true })

    const page = await browserContext.newPage()

    // ── Login phase ──────────────────────────────────────────────────
    if (!context.isLoginTest) {
      if (context.projectCategory === 'salesforce') {
        await loginToSalesforce(page, context)
      } else if (context.projectCategory === 'webapp' && context.webLoginStrategy !== 'none') {
        await loginToWebApp(page, context)
      }
    }

    // ── Step execution phase ─────────────────────────────────────────
    let firstFailedLocator: string | null = null
    let failedScreenshotBase64: string | null = null
    let failedHtmlSnippet: string | null = null

    for (let i = 0; i < context.steps.length; i++) {
      const step = context.steps[i]
      const result = await executeStep(page, step, i, execScreenDir)
      stepResults.push(result)

      log.info(`[EXEC] Step ${i + 1}/${context.steps.length}: ${result.status} — ${step.action}`)

      if (result.status === 'failed') {
        finalStatus = 'FAILED'

        // Capture data needed for healing
        if (!firstFailedLocator) {
          firstFailedLocator = step.target ?? ''

          // Read screenshot as base64
          if (result.screenshot_path) {
            const absPath = path.join(process.cwd(), result.screenshot_path)
            try {
              failedScreenshotBase64 = fs.readFileSync(absPath).toString('base64')
            } catch { /* ignore */ }
          }

          // Capture HTML snippet around the failing locator
          try {
            failedHtmlSnippet = await page.evaluate((selector) => {
              try {
                const el = document.querySelector(selector)
                return el ? el.outerHTML.slice(0, 2048) : document.body.innerHTML.slice(0, 2048)
              } catch {
                return document.body.innerHTML.slice(0, 2048)
              }
            }, firstFailedLocator)
          } catch { /* ignore */ }
        }

        // Stop on first failure (matches Python behaviour)
        break
      }
    }

    // ── Stop trace ───────────────────────────────────────────────────
    try {
      await browserContext.tracing.stop({ path: traceFile })
      tracePath = `/static/traces/${executionId}.zip`
    } catch (traceErr) {
      log.warn({ traceErr }, '[EXEC] Failed to stop trace')
    }

    // ── If failed, enqueue healing job ───────────────────────────────
    if (finalStatus === 'FAILED' && firstFailedLocator !== null) {
      const healingJob: HealingJob = {
        executionId,
        testRunId: executionId,
        testCaseId,
        projectId,
        failedLocator: firstFailedLocator,
        screenshotBase64: failedScreenshotBase64 ?? '',
        htmlSnippet: failedHtmlSnippet ?? '',
        logs: stepResults as unknown as Record<string, unknown>[],
        steps: context.steps,
      }

      await healingQueue.add('heal', healingJob, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
      })

      log.info(`[EXEC] Enqueued healing job for execution ${executionId}`)
    }
  } catch (err: unknown) {
    log.error({ err }, `[EXEC] Execution ${executionId} encountered fatal error`)
    finalStatus = 'ERROR'
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      await browserContext?.close()
      await browser?.close()
    } catch { /* ignore */ }
  }

  // ── Write final result to DB ─────────────────────────────────────
  const durationMs = Date.now() - startTime
  const lastScreenshot = stepResults
    .slice()
    .reverse()
    .find((s) => s.screenshot_path)?.screenshot_path ?? null

  const resultMetadata = {
    triggered_by: triggeredBy,
    steps: stepResults,
    duration_ms: durationMs,
    screenshot_path: lastScreenshot,
    trace_path: tracePath,
    error_message: errorMessage,
  }

  await prisma.executions.update({
    where: { id: executionId },
    data: {
      status: finalStatus,
      completed_at: new Date(),
      logs: stepResults.map((s) => s.message).join('\n'),
      result_metadata: resultMetadata as object,
    },
  })

  log.info(`[EXEC] Execution ${executionId} completed: ${finalStatus} in ${durationMs}ms`)

  if (finalStatus === 'ERROR') {
    throw new Error(errorMessage ?? 'Unknown execution error')
  }
}

// ─── Worker boot ─────────────────────────────────────────────────────────────

const worker = new Worker<ExecutionJob>(
  QUEUES.EXECUTION,
  processExecution,
  {
    ...getRedisOptions(),
    concurrency: 3,
    limiter: {
      max: 5,
      duration: 60_000, // max 5 executions per minute
    },
  },
)

worker.on('completed', (job) => {
  log.info(`[EXEC] Job ${job.id} completed`)
})

worker.on('failed', (job, err) => {
  log.error({ err }, `[EXEC] Job ${job?.id} failed: ${err.message}`)
})

worker.on('error', (err) => {
  log.error({ err }, '[EXEC] Worker error')
})

log.info('🔧 Execution worker started — Playwright headless runner active')

export default worker
