/**
 * Execution Worker — BullMQ Consumer
 *
 * This is the ONLY place where Playwright runs in the entire codebase.
 *
 * Session management (mirrors Python playwright_service.py):
 *   • Saves Playwright storageState to  sessions/{projectId}.json  after every successful login
 *   • Loads that file on the next run so no re-login is required
 *   • For Salesforce: validates the loaded session by navigating to /lightning/page/home
 *     → if redirected to /login the file is deleted and a fresh login performed
 *   • For MCP-connected SF orgs with an access_token: uses frontdoor.jsp (silent, no 2FA)
 *   • Falls back to form login (username + password + security_token) if frontdoor fails
 *
 * Locator strategy:
 *   • Each StepData carries an optional `locator_type` field set by the AI generator
 *   • resolveLocator() maps it to the correct Playwright API:
 *       label → getByLabel, placeholder → getByPlaceholder, text → getByText,
 *       role  → getByRole,  testid → getByTestId,  default → locator() (CSS/XPath)
 */
import 'dotenv/config'
import path from 'path'
import fs from 'fs'
import { Worker, Job, Queue } from 'bullmq'
import { chromium, Browser, BrowserContext, Page, Locator } from '@playwright/test'
import { QUEUES } from '../shared/queue/queues.js'
import { getRedisOptions } from '../shared/queue/connection.js'
import prisma from '../shared/db/prisma.js'
import { createModuleLogger } from '../shared/logger/index.js'
import { getConnection, invalidateConnection } from '../modules/salesforce/lib/sf-connection.js'
import type { ExecutionJob, HealingJob, StepData } from '../shared/queue/job-types.js'
import type { ExecutionStepResult } from '../modules/execution/execution.schema.js'

const log = createModuleLogger('execution-worker')

// ─── Directory setup ──────────────────────────────────────────────────────────

const BASE_DIR        = path.resolve(process.cwd(), 'static')
const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'screenshots')
const TRACES_DIR      = path.resolve(BASE_DIR, 'traces')
const SESSIONS_DIR    = path.resolve(process.cwd(), 'sessions')

for (const dir of [SCREENSHOTS_DIR, TRACES_DIR, SESSIONS_DIR]) {
  fs.mkdirSync(dir, { recursive: true })
}

// ─── Session helpers ──────────────────────────────────────────────────────────

function getSessionPath(projectId: string): string {
  return path.join(SESSIONS_DIR, `${projectId}.json`)
}

function sessionExists(projectId: string): boolean {
  const p = getSessionPath(projectId)
  try { return fs.existsSync(p) && fs.statSync(p).size > 10 } catch { return false }
}

/** Save the browser's cookies + localStorage to disk and mark the project active in the DB. */
async function saveSession(projectId: string, browserCtx: BrowserContext): Promise<void> {
  try {
    await browserCtx.storageState({ path: getSessionPath(projectId) })
    log.info(`[SESSION] ✅ Session saved → sessions/${projectId}.json`)
    // Update the project's session flag (non-fatal if it fails)
    await prisma.projects.update({
      where: { id: projectId },
      data: {
        ui_session_active:          true,
        ui_session_source:          'login',
        ui_session_last_created_at: new Date(),
      },
    }).catch((e: unknown) => log.warn({ e }, '[SESSION] DB flag update failed (non-fatal)'))
  } catch (err) {
    log.warn({ err }, '[SESSION] Failed to save session (non-fatal)')
  }
}

/** Delete the stored session file and clear the DB flag. */
async function deleteSession(projectId: string): Promise<void> {
  const p = getSessionPath(projectId)
  try { if (fs.existsSync(p)) fs.unlinkSync(p) } catch { /* ignore */ }
  try {
    await prisma.projects.update({ where: { id: projectId }, data: { ui_session_active: false } })
  } catch { /* ignore */ }
  log.info(`[SESSION] Invalidated session for project ${projectId}`)
}

// ─── Healing queue producer ───────────────────────────────────────────────────

const healingQueue = new Queue<HealingJob>(QUEUES.HEALING, getRedisOptions())

// ─── Smart locator resolver ───────────────────────────────────────────────────

/**
 * Resolve the correct Playwright locator based on the `locator_type` field
 * that the AI generator attaches to each step.
 *
 * Supported values (case-insensitive):
 *   label       → page.getByLabel(target)
 *   placeholder → page.getByPlaceholder(target)
 *   text        → page.getByText(target)
 *   role        → page.getByRole(role, { name }) — target format: "button:Save"
 *   testid      → page.getByTestId(target)
 *   title       → page.getByTitle(target)
 *   alt / alttext → page.getByAltText(target)
 *   (default)   → page.locator(target)  — CSS selector or XPath
 */
function resolveLocator(page: Page, step: StepData) {
  let target      = step.target ?? ''
  let locatorType = (step.locator_type ?? '').toLowerCase().trim()

  // API Name to Label Normalization
  if (target.endsWith('__c') || target.endsWith('__r') || target.endsWith('__C') || target.endsWith('__R')) {
    target = target.slice(0, -3).replace(/_/g, ' ').trim()
  }

  // 1. Auto-detect locator_type from target pattern
  // This handles test cases generated by the old Python engine that pack the type into the target string.
  if (!locatorType || locatorType === 'css') {
    if (/^role=\w+,\s*name=/.test(target)) {
      locatorType = 'role'
    } else if (target.startsWith('label=')) {
      locatorType = 'label'
      target = target.substring(6)
    } else if (target.startsWith('text=')) {
      locatorType = 'text'
      target = target.substring(5)
    } else if (!target.match(/[.#\[\]>:=]/) && target.length > 0) {
      // Plain text target (e.g. "Account Name", "Phone") — treat as label safely
      locatorType = 'label'
    }
  }

  // 2. Normalise AI-generated variants
  if (['role_button', 'button_role', 'button', 'btn'].includes(locatorType)) {
    locatorType = 'role'
    if (!/^role=\w+,\s*name=/.test(target) && !target.includes(':')) {
      target = `button:${target}` 
    }
  }
  
  if (['field_label', 'get_by_label', 'by_label', 'field_name'].includes(locatorType)) locatorType = 'label'
  if (['get_by_text', 'by_text', 'inner_text'].includes(locatorType)) locatorType = 'text'

  switch (locatorType) {
    case 'label':
      return page.getByLabel(target, { exact: false })

    case 'placeholder':
      return page.getByPlaceholder(target, { exact: false })

    case 'text':
      return page.getByText(target, { exact: false })

    case 'role': {
      // Parse "role=button, name=New" format
      const roleMatch = target.match(/^role=(\w+),\s*name=(.+)$/)
      if (roleMatch) {
         const role = roleMatch[1].trim() as Parameters<Page['getByRole']>[0]
         const name = roleMatch[2].trim()
         return page.getByRole(role, { name, exact: false })
      }
      
      // Accepts "button:Save and Close"
      const colonIdx = target.indexOf(':')
      if (colonIdx > -1) {
        const role = target.slice(0, colonIdx).trim() as Parameters<Page['getByRole']>[0]
        const name = target.slice(colonIdx + 1).trim()
        return page.getByRole(role, { name, exact: false })
      }
      return page.getByRole(target as Parameters<Page['getByRole']>[0], { exact: false })
    }

    case 'testid':
    case 'test-id':
    case 'data-testid':
      return page.getByTestId(target)

    case 'title':
      return page.getByTitle(target, { exact: false })

    case 'alt':
    case 'alttext':
    case 'alt-text':
      return page.getByAltText(target, { exact: false })

    default:
      // Final fallback to CSS/XPath
      return page.locator(target)
  }
}

// ─── Action executor ──────────────────────────────────────────────────────────

/**
 * Salesforce often has hidden elements in the DOM (like column headers in the table view)
 * that match the same labels as form inputs in active modals.
 * This helper implements a Visibility-First Strategy to find the actual interactive element.
 */
async function getFirstVisibleLocator(baseLocator: Locator, timeout: number = 15000): Promise<Locator> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeout) {
    const count = await baseLocator.count()
    for (let i = 0; i < count; i++) {
       const l = baseLocator.nth(i)
       if (await l.isVisible()) {
         return l
       }
    }
    // Wait a short bit before re-checking
    await baseLocator.page().waitForTimeout(500)
  }
  // Fallback to first if none visible within timeout
  return baseLocator.first()
}

/**
 * Execute a single step on the Playwright Page.
 * Returns a step result. Never throws — errors are captured into the result.
 */
async function executeStep(
  page: Page,
  step: StepData,
  stepIndex: number,
  screenshotsDir: string,
): Promise<ExecutionStepResult> {
  const start  = Date.now()
  const action = step.action.toLowerCase().replace(/[-_\s]/g, '')
  const target = step.target ?? ''
  const value  = step.value  ?? ''
  let screenshotPath: string | null = null

  try {
    switch (action) {

      case 'navigate':
      case 'goto':
      case 'open': {
        // AI puts relative path in `value`; target is a human-readable label
        const navUrl = value || target
        if (!navUrl) {
          log.warn(`[EXEC] NAVIGATE step ${stepIndex + 1} has no URL — skipping`)
          break
        }
        let resolvedUrl = navUrl
        if (navUrl.startsWith('/')) {
          try { resolvedUrl = `${new URL(page.url()).origin}${navUrl}` } catch { /* first step */ }
        }
        try {
          await page.goto(resolvedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        } catch (navErr: unknown) {
          const msg = navErr instanceof Error ? navErr.message : String(navErr)
          // Salesforce SPA router often aborts standard navigations — treat as success
          if (!msg.includes('ERR_ABORTED')) throw navErr
          log.warn(`[EXEC] NAVIGATE: ERR_ABORTED ignored (SF SPA) at step ${stepIndex + 1}`)
        }
        break
      }

      case 'click': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 15_000 })
        await loc.scrollIntoViewIfNeeded()
        await loc.click({ timeout: 15_000 })
        break
      }

      case 'type':
      case 'fill':
      case 'input': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 15_000 })
        try {
          await loc.fill(value, { timeout: 10_000 })
        } catch (fillErr) {
          // Try-Fill-First Pattern: Target might be a container matching the label
          const innerLoc = loc.locator('input:not([type="hidden"]), textarea').first()
          if (await innerLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
            await innerLoc.fill(value, { timeout: 10_000 })
          } else {
            throw fillErr
          }
        }
        break
      }

      case 'select':
      case 'selectoption': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.selectOption(value, { timeout: 10_000 })
        break
      }

      case 'check':
      case 'checkbox': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.check({ timeout: 10_000 })
        break
      }

      case 'uncheck': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.uncheck({ timeout: 10_000 })
        break
      }

      case 'hover': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        await loc.hover({ timeout: 10_000 })
        break
      }

      case 'press':
      case 'keyboard': {
        await page.keyboard.press(value || target)
        break
      }

      case 'wait':
      case 'waitfor': {
        if (/^\d+$/.test(value)) {
          await page.waitForTimeout(parseInt(value, 10))
        } else {
          await page.waitForSelector(value || target, { timeout: 30_000 })
        }
        break
      }

      case 'assert':
      case 'assertvisible':
      case 'asserttext': {
        const loc = await getFirstVisibleLocator(resolveLocator(page, step))
        await loc.waitFor({ state: 'visible', timeout: 10_000 })
        if (value) {
          const text = await loc.textContent()
          if (!text?.includes(value)) {
            throw new Error(
              `Assertion failed: element "${target}" text "${text}" does not contain "${value}"`,
            )
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
          await (await getFirstVisibleLocator(resolveLocator(page, step))).scrollIntoViewIfNeeded()
        } else {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        }
        break
      }

      case 'screenshot': {
        const ssFile = `step-${stepIndex}-explicit-${Date.now()}.png`
        const ssPath = path.join(screenshotsDir, ssFile)
        await page.screenshot({ path: ssPath, fullPage: false })
        const executionId = path.basename(screenshotsDir)
        screenshotPath = `/screenshots/${executionId}/${ssFile}`
        break
      }

      case 'clearcookies': {
        await page.context().clearCookies()
        break
      }

      default: {
        log.warn(`[EXEC] Unknown action "${step.action}" at step ${stepIndex + 1} — skipping`)
        return {
          step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
          status: 'skipped', message: `Unknown action "${step.action}" — skipped`,
          duration_ms: Date.now() - start, screenshot_path: null, error: null,
        }
      }
    }

    // Per-step screenshot (on-step mode)
    const ssFile   = `step-${stepIndex + 1}-${Date.now()}.png`
    const ssAbsPath = path.join(screenshotsDir, ssFile)
    const executionId = path.basename(screenshotsDir)
    try {
      await page.screenshot({ path: ssAbsPath, fullPage: false })
      screenshotPath = `/screenshots/${executionId}/${ssFile}`
    } catch { /* non-fatal */ }

    return {
      step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
      status: 'passed', message: `Step ${stepIndex + 1} passed`,
      duration_ms: Date.now() - start, screenshot_path: screenshotPath, error: null,
    }

  } catch (err: unknown) {
    const errMsg     = err instanceof Error ? err.message : String(err)
    const failSsFile = `step-${stepIndex + 1}-FAILED-${Date.now()}.png`
    const executionId = path.basename(screenshotsDir)
    try {
      await page.screenshot({ path: path.join(screenshotsDir, failSsFile), fullPage: false })
      screenshotPath = `/screenshots/${executionId}/${failSsFile}`
    } catch { /* ignore */ }

    return {
      step: stepIndex + 1, action: step.action, target: target || null, value: value || null,
      status: 'failed', message: `Step ${stepIndex + 1} failed: ${errMsg}`,
      duration_ms: Date.now() - start, screenshot_path: screenshotPath, error: errMsg,
    }
  }
}

// ─── Salesforce login ─────────────────────────────────────────────────────────

/**
 * Authenticate a Playwright page against Salesforce using JSForce.
 *
 * 1. Uses JSForce getConnection() to ensure an active API session exists.
 * 2. Uses the active API accessToken to perform a silent login via frontdoor.jsp.
 *
 * This completely bypasses the Salesforce UI login screen and 2FA prompts.
 */
async function loginToSalesforce(
  page:        Page,
  browserCtx:  BrowserContext,
  projectId:   string,
): Promise<void> {
  log.info(`[EXEC-SF] Getting JSForce connection for project ${projectId}...`)
  try {
    const conn = await getConnection(projectId)

    if (!conn.accessToken || !conn.instanceUrl) {
      throw new Error('JSForce connection missing accessToken or instanceUrl')
    }

    log.info('[EXEC-SF] JSForce API session ready. Attempting silent login via frontdoor.jsp')

    const instanceUrl = conn.instanceUrl.startsWith('http')
      ? conn.instanceUrl
      : `https://${conn.instanceUrl}`

    const frontdoorUrl = `${instanceUrl}/secur/frontdoor.jsp?sid=${conn.accessToken}`

    await page.goto(frontdoorUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(2_000)

    const currentUrl = page.url().toLowerCase()
    if (!currentUrl.includes('/login') && !currentUrl.includes('/authorize')) {
      log.info(`[EXEC-SF] ✅ frontdoor.jsp login OK → ${page.url()}`)
      await saveSession(projectId, browserCtx)
      return
    }

    // Token might be stale, invalidate JSForce connection and try ONE more time
    log.warn('[EXEC-SF] frontdoor.jsp redirected to login. Invalidating JSForce session and retrying...')
    invalidateConnection(projectId)
    const freshConn = await getConnection(projectId)
    const freshUrl = `${freshConn.instanceUrl}/secur/frontdoor.jsp?sid=${freshConn.accessToken}`

    await page.goto(freshUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForTimeout(2_000)

    const finalUrl = page.url().toLowerCase()
    if (finalUrl.includes('/login') || finalUrl.includes('/authorize')) {
      throw new Error('Salesforce silent login failed twice. Session could not be established via frontdoor.jsp')
    }

    log.info(`[EXEC-SF] ✅ Retry frontdoor.jsp login OK → ${page.url()}`)
    await saveSession(projectId, browserCtx)

  } catch (err) {
    log.error({ err }, '[EXEC-SF] Failed to login to Salesforce via JSForce')
    throw err
  }
}

// ─── WebApp login ─────────────────────────────────────────────────────────────

async function loginToWebApp(
  page:       Page,
  browserCtx: BrowserContext,
  context:    ExecutionJob['context'],
  projectId:  string,
): Promise<void> {
  if (!context.webLoginUrl || !context.webUsername || !context.webPassword) {
    log.info('[EXEC-WEB] No web credentials — skipping login')
    return
  }

  const strategy = context.webLoginStrategy ?? 'form'

  if (strategy === 'basic_auth') {
    const url      = new URL(context.webLoginUrl)
    url.username   = context.webUsername
    url.password   = context.webPassword
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await saveSession(projectId, browserCtx)
    return
  }

  // Default: form-based login (heuristic fill)
  await page.goto(context.webLoginUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const emailInput    = page.locator('input[type="email"], input[name*="user"], input[name*="email"]').first()
  const passwordInput = page.locator('input[type="password"]').first()

  try {
    await emailInput.waitFor({ state: 'visible', timeout: 8_000 })
    await emailInput.fill(context.webUsername)
    await passwordInput.fill(context.webPassword)
    await page.keyboard.press('Enter')
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    log.info('[EXEC-WEB] ✅ Form login submitted')
    await saveSession(projectId, browserCtx)
  } catch {
    log.warn('[EXEC-WEB] Login form heuristic failed — continuing without session save')
  }
}

// ─── Core worker function ─────────────────────────────────────────────────────

async function processExecution(job: Job<ExecutionJob>): Promise<void> {
  const { testRunId: executionId, testCaseId, projectId, triggeredBy, context } = job.data
  log.info(
    `[EXEC] Starting ${executionId} ` +
    `(testCase=${testCaseId}, project=${projectId}, trigger=${triggeredBy})`,
  )

  const startTime = Date.now()

  // Mark RUNNING
  await prisma.test_runs.update({ where: { id: executionId }, data: { status: 'running' } })

  let browser:        Browser | null       = null
  let browserContext: BrowserContext | null = null
  let page:           Page | null          = null

  const stepResults: ExecutionStepResult[]     = []
  let finalStatus: 'PASSED' | 'FAILED' | 'ERROR' = 'PASSED'
  let errorMessage: string | null              = null

  const execScreenDir = path.join(SCREENSHOTS_DIR, executionId)
  fs.mkdirSync(execScreenDir, { recursive: true })

  try {
    browser = await chromium.launch({ headless: true })

    const traceFile    = path.join(TRACES_DIR, `${executionId}.zip`)
    const useSession   = context.useSessionReuse !== false && !!projectId
    const hasSession   = useSession && sessionExists(projectId)

    // Helper: create a fresh (unauthenticated) browser context + page
    const createFresh = async (): Promise<{ ctx: BrowserContext; pg: Page }> => {
      const ctx = await browser!.newContext({
        viewport:          { width: 1280, height: 800 },
        ignoreHTTPSErrors: true,
      })
      await ctx.tracing.start({ screenshots: true, snapshots: true })
      return { ctx, pg: await ctx.newPage() }
    }

    // ── Load or create browser context ───────────────────────────
    if (hasSession) {
      log.info(`[SESSION] Loading stored session for project ${projectId}`)
      try {
        browserContext = await browser.newContext({
          storageState:      getSessionPath(projectId),
          viewport:          { width: 1280, height: 800 },
          ignoreHTTPSErrors: true,
        })
        await browserContext.tracing.start({ screenshots: true, snapshots: true })
        page = await browserContext.newPage()
      } catch (loadErr) {
        log.warn({ loadErr }, '[SESSION] Failed to load stored session — starting fresh')
        const fresh = await createFresh()
        browserContext = fresh.ctx
        page           = fresh.pg
      }
    } else {
      const fresh = await createFresh()
      browserContext = fresh.ctx
      page           = fresh.pg
    }

    // ── Login / session-validation phase ─────────────────────────
    if (!context.isLoginTest) {

      if (context.projectCategory === 'salesforce') {
        if (hasSession) {
          // Validate the restored session — navigate to SF home
          const sfBase = context.sfInstanceUrl ?? context.baseUrl
          log.info('[SESSION] Validating Salesforce session...')
          try {
            await page.goto(`${sfBase}/lightning/page/home`, {
              waitUntil: 'domcontentloaded',
              timeout:   30_000,
            })
            await page.waitForTimeout(2_000)
            const url = page.url().toLowerCase()

            if (url.includes('/login') || url.includes('/authorize')) {
              // Session expired — delete it and re-authenticate
              log.warn('[SESSION] Salesforce session expired — invalidating and re-authenticating')
              await deleteSession(projectId)
              try { await browserContext!.tracing.stop() } catch { /* ignore */ }
              await browserContext!.close()
              const fresh    = await createFresh()
              browserContext = fresh.ctx
              page           = fresh.pg
              await loginToSalesforce(page, browserContext, projectId)
            } else {
              log.info(`[SESSION] ✅ Salesforce session valid → ${page.url()}`)
            }
          } catch (validErr) {
            log.warn({ validErr }, '[SESSION] Validation error — proceeding with current page')
          }
        } else {
          // No stored session — do a fresh login via JSForce
          await loginToSalesforce(page, browserContext, projectId)
        }

      } else if (context.projectCategory === 'webapp' && context.webLoginStrategy !== 'none') {
        if (hasSession) {
          log.info('[SESSION] Using stored web app session — skipping login')
        } else {
          await loginToWebApp(page, browserContext, context, projectId)
        }
      }
    }

    // ── Step execution phase ──────────────────────────────────────
    let firstFailedLocator:    string | null = null
    let failedScreenshotBase64: string | null = null
    let failedHtmlSnippet:      string | null = null

    for (let i = 0; i < context.steps.length; i++) {
      const step   = context.steps[i]
      const result = await executeStep(page!, step, i, execScreenDir)
      stepResults.push(result)

      log.info(
        `[EXEC] Step ${i + 1}/${context.steps.length}: ${result.status}` +
        ` — ${step.action} "${step.target ?? ''}"`,
      )

      if (result.status === 'failed') {
        finalStatus = 'FAILED'

        if (!firstFailedLocator) {
          firstFailedLocator = step.target ?? ''

          if (result.screenshot_path) {
            try {
              failedScreenshotBase64 = fs.readFileSync(
                path.join(process.cwd(), result.screenshot_path),
              ).toString('base64')
            } catch { /* ignore */ }
          }

          try {
            failedHtmlSnippet = await page!.evaluate((sel) => {
              try {
                const el = document.querySelector(sel)
                return el ? el.outerHTML.slice(0, 2048) : document.body.innerHTML.slice(0, 2048)
              } catch { return document.body.innerHTML.slice(0, 2048) }
            }, firstFailedLocator)
          } catch { /* ignore */ }
        }

        break // Stop on first failure
      }
    }

    // ── Stop trace ────────────────────────────────────────────────
    try {
      await browserContext!.tracing.stop({ path: traceFile })
    } catch (traceErr) {
      log.warn({ traceErr }, '[EXEC] Failed to stop trace')
    }

    // ── Enqueue healing if failed ─────────────────────────────────
    if (finalStatus === 'FAILED' && firstFailedLocator !== null) {
      const healingJob: HealingJob = {
        executionId,
        testRunId:        executionId,
        testCaseId,
        projectId,
        failedLocator:    firstFailedLocator,
        screenshotBase64: failedScreenshotBase64 ?? '',
        htmlSnippet:      failedHtmlSnippet ?? '',
        logs:             stepResults as unknown as Record<string, unknown>[],
        steps:            context.steps,
      }
      await healingQueue.add('heal', healingJob, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 3000 },
      })
      log.info(`[EXEC] Healing job enqueued for ${executionId}`)
    }

  } catch (err: unknown) {
    log.error({ err }, `[EXEC] Fatal error in execution ${executionId}`)
    finalStatus  = 'ERROR'
    errorMessage = err instanceof Error ? err.message : String(err)
    stepResults.push({
      step:            stepResults.length + 1,
      action:          'SYSTEM',
      target:          null,
      value:           null,
      status:          'failed',
      message:         `Fatal execution error: ${errorMessage}`,
      duration_ms:     Date.now() - startTime,
      screenshot_path: null,
      error:           errorMessage,
    })
  } finally {
    try { await browserContext?.close() } catch { /* ignore */ }
    try { await browser?.close()        } catch { /* ignore */ }
  }

  // ── Write final result to test_runs ──────────────────────────
  const durationMs     = Date.now() - startTime
  const lastScreenshot = stepResults.slice().reverse().find((s) => s.screenshot_path)
    ?.screenshot_path ?? null
  const testRunStatus  =
    finalStatus === 'PASSED' ? 'passed'
    : finalStatus === 'FAILED' ? 'failed'
    : 'error'

  try {
    await prisma.test_runs.update({
      where: { id: executionId },
      data: {
        status:          testRunStatus,
        result:          testRunStatus,
        logs:            stepResults as unknown as object[],
        duration:        durationMs / 1000,
        screenshot_path: lastScreenshot,
      },
    })
    log.info(`[EXEC] test_runs ${executionId} → ${testRunStatus} in ${durationMs}ms`)
  } catch (writeErr) {
    log.error({ writeErr }, `[EXEC] Failed to write final status for ${executionId}`)
  }

  if (finalStatus === 'ERROR') {
    throw new Error(errorMessage ?? 'Unknown execution error')
  }
}

// ─── Worker boot ──────────────────────────────────────────────────────────────

const worker = new Worker<ExecutionJob>(
  QUEUES.EXECUTION,
  processExecution,
  {
    ...getRedisOptions(),
    concurrency: 3,
    limiter: { max: 5, duration: 60_000 },
  },
)

worker.on('completed', (job)      => log.info(`[EXEC] Job ${job.id} completed`))
worker.on('failed',    (job, err) => log.error({ err }, `[EXEC] Job ${job?.id} failed: ${err.message}`))
worker.on('error',     (err)      => log.error({ err }, '[EXEC] Worker error'))

log.info('🔧 Execution worker started — Playwright headless runner active')

export default worker
