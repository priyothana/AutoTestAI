/**
 * Salesforce Module — Connection Pool (Hardened)
 *
 * Maintains one persistent JSforce Connection per projectId.
 * Handles both username+password and OAuth2 access token flows.
 * Automatically re-authenticates on INVALID_SESSION_ID errors.
 *
 * Gap 2 hardening (Session 2):
 *   • Pool health check via conn.identity()
 *   • Stale-connection eviction every 30 minutes
 *   • Concurrent-request deduplication (pending Map)
 *   • Graceful shutdown via drainPool() on SIGTERM
 *
 * Export: getConnection(projectId)
 *         invalidateConnection(projectId)
 *         executeWithRetry(projectId, fn)
 *         drainPool()
 *         wrapJsforceError(err, objectName?)
 */
import jsforce from 'jsforce'
import type { Connection } from 'jsforce'
import { getIntegrationByProject, getDecryptedTokens } from '../../project/project.service.js'
import { createModuleLogger } from '../../../shared/logger/index.js'
import { SalesforceError, type SFCredential } from './sf-types.js'

const log = createModuleLogger('salesforce:connection')

// ─── Connection pool ──────────────────────────────────────────────

const pool = new Map<string, Connection>()

/**
 * In-flight login promises per projectId.
 * If two requests arrive for the same project before the first login
 * completes, both await the SAME promise — no duplicate logins.
 */
const pending = new Map<string, Promise<Connection>>()

// ─── Health check ─────────────────────────────────────────────────

/**
 * Lightweight liveness probe — calls conn.identity() which is a single
 * GET to /services/oauth2/userinfo and validates the session token.
 * Returns false on any error; never throws to the caller.
 */
async function isConnectionAlive(conn: Connection): Promise<boolean> {
  try {
    await conn.identity()
    return true
  } catch {
    return false
  }
}

// ─── Stale-connection eviction (every 30 minutes) ─────────────────

const EVICTION_INTERVAL_MS = 30 * 60 * 1000

const _evictionTimer = setInterval(async () => {
  log.debug(`[connection] Running stale-connection eviction (pool size=${pool.size})`)
  for (const [projectId, conn] of pool.entries()) {
    const alive = await isConnectionAlive(conn)
    if (!alive) {
      pool.delete(projectId)
      log.info(`[connection] Evicted stale connection for project ${projectId}`)
    }
  }
}, EVICTION_INTERVAL_MS)

// Allow Node.js to exit even if the interval is active
if (_evictionTimer.unref) _evictionTimer.unref()

// ─── Credential resolver ──────────────────────────────────────────

/** Resolve the SFCredential from the project integration via project.service.ts */
async function resolveCredential(projectId: string): Promise<SFCredential> {
  const integration = await getIntegrationByProject(projectId)
  if (!integration || integration.category !== 'salesforce') {
    throw new SalesforceError({
      message: 'No Salesforce integration configured for this project',
      errorCode: 'NO_INTEGRATION',
      statusCode: 400,
    })
  }

  const tokens = await getDecryptedTokens(integration.id)

  // Determine auth flow: if the integration has a client_id → OAuth2, else password
  const authType: 'password' | 'oauth2' =
    tokens.client_id && tokens.access_token ? 'oauth2' : 'password'

  const instanceUrl =
    integration.instance_url ??
    integration.salesforce_login_url ??
    'https://login.salesforce.com'

  if (authType === 'oauth2') {
    return {
      instanceUrl,
      authType: 'oauth2',
      accessToken: tokens.access_token ?? undefined,
      refreshToken: tokens.refresh_token ?? undefined,
      clientId: tokens.client_id ?? undefined,
      clientSecret: tokens.client_secret ?? undefined,
    }
  }

  // password flow — requires username + password + security_token
  if (!tokens.username || !tokens.password) {
    throw new SalesforceError({
      message:
        'Salesforce credentials incomplete. Username and password are required for password flow.',
      errorCode: 'INCOMPLETE_CREDENTIALS',
      statusCode: 400,
    })
  }

  return {
    instanceUrl,
    authType: 'password',
    username: tokens.username,
    password: tokens.password,
    securityToken: tokens.security_token ?? undefined,
  }
}

/** Create a new authenticated JSforce Connection from a credential object */
async function _createAndAuth(projectId: string): Promise<Connection> {
  try {
    const credential = await resolveCredential(projectId)

    if (credential.authType === 'oauth2') {
      // OAuth2: set the access token directly — no login() call needed
      const conn = new jsforce.Connection({
        instanceUrl: credential.instanceUrl,
        accessToken: credential.accessToken,
        oauth2: credential.clientId
          ? {
              clientId: credential.clientId,
              clientSecret: credential.clientSecret,
            }
          : undefined,
      })
      return conn
    }

    // Username + Password flow
    const loginUrl = credential.instanceUrl.includes('test.salesforce.com')
      ? 'https://test.salesforce.com'
      : 'https://login.salesforce.com'

    const conn = new jsforce.Connection({ loginUrl })
    await conn.login(
      credential.username!,
      `${credential.password!}${credential.securityToken ?? ''}`,
    )
    log.debug(`[connection] Authenticated via password flow — instanceUrl=${conn.instanceUrl}`)
    return conn
  } catch (err: unknown) {
    throw wrapJsforceError(err, undefined)
  }
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Return a cached (or freshly authenticated) JSforce Connection for a project.
 *
 * Concurrent-request safety:
 *   If two calls arrive for the same projectId before the first login
 *   completes, both await the same pending promise — only one login occurs.
 *
 * Token-expiry recovery:
 *   If you receive an INVALID_SESSION_ID error, call `invalidateConnection()`
 *   then call `getConnection()` again. Or use `executeWithRetry()` which does
 *   this automatically.
 */
export async function getConnection(projectId: string): Promise<Connection> {
  // 1 — Cache hit
  const cached = pool.get(projectId)
  if (cached) {
    log.debug(`[connection] Pool hit for project ${projectId}`)
    return cached
  }

  // 2 — Deduplicate concurrent requests for the same projectId
  const inFlight = pending.get(projectId)
  if (inFlight) {
    log.debug(`[connection] Awaiting in-flight login for project ${projectId}`)
    return inFlight
  }

  // 3 — Start new login; register in pending before await
  log.info(`[connection] Creating new connection for project ${projectId}`)
  const promise = _createAndAuth(projectId)
  pending.set(projectId, promise)

  try {
    const conn = await promise
    pool.set(projectId, conn)
    return conn
  } finally {
    // Always clean up the pending entry, even on error
    pending.delete(projectId)
  }
}

/**
 * Remove a project's cached connection so the next `getConnection()` call
 * will re-authenticate. Call this when you receive an INVALID_SESSION_ID error.
 */
export function invalidateConnection(projectId: string): void {
  pool.delete(projectId)
  log.info(`[connection] Invalidated pool entry for project ${projectId}`)
}

/**
 * Execute a JSforce operation with automatic session-expiry recovery.
 * On INVALID_SESSION_ID: invalidates the cached connection, re-authenticates
 * once, and retries the operation.
 *
 * @param projectId  Project whose connection to use
 * @param fn         Async function receiving the live JSforce Connection
 */
export async function executeWithRetry<T>(
  projectId: string,
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  let conn = await getConnection(projectId)
  try {
    return await fn(conn)
  } catch (err: unknown) {
    if (isSessionExpiredError(err)) {
      log.warn(`[connection] Session expired for project ${projectId} — re-authenticating`)
      invalidateConnection(projectId)
      conn = await getConnection(projectId)
      try {
        return await fn(conn)
      } catch (retryErr: unknown) {
        throw wrapJsforceError(retryErr, undefined)
      }
    }
    throw wrapJsforceError(err, undefined)
  }
}

/**
 * Gracefully close all pooled connections and clear the pool.
 * Should be called on SIGTERM before process exit.
 *
 * Each conn.logout() is attempted; errors are swallowed so the
 * process can still exit cleanly even if Salesforce is unreachable.
 */
export async function drainPool(): Promise<void> {
  log.info(`[connection] Draining pool — ${pool.size} active connection(s)`)
  const entries = [...pool.entries()]
  pool.clear()

  await Promise.allSettled(
    entries.map(async ([projectId, conn]) => {
      try {
        await conn.logout()
        log.info(`[connection] Logged out project ${projectId}`)
      } catch (err) {
        log.warn({ err }, `[connection] logout() failed for project ${projectId} — ignoring`)
      }
    }),
  )
}

// ─── SIGTERM handler ──────────────────────────────────────────────

process.once('SIGTERM', async () => {
  log.info('[connection] SIGTERM received — draining pool before exit')
  await drainPool()
  process.exit(0)
})

// ─── Error helpers ────────────────────────────────────────────────

function isSessionExpiredError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  return (
    e['errorCode'] === 'INVALID_SESSION_ID' ||
    String(e['message'] ?? '').includes('INVALID_SESSION_ID')
  )
}

/**
 * Convert any raw JSforce error into a typed SalesforceError.
 * Never leaks raw jsforce errors to callers.
 */
export function wrapJsforceError(err: unknown, objectName?: string): SalesforceError {
  if (err instanceof SalesforceError) return err

  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    return new SalesforceError({
      message: String(e['message'] ?? 'Salesforce operation failed'),
      errorCode: String(e['errorCode'] ?? e['name'] ?? 'UNKNOWN_ERROR'),
      statusCode:
        typeof e['statusCode'] === 'number'
          ? e['statusCode']
          : typeof e['status'] === 'number'
            ? e['status']
            : (e['errorCode'] === 'INVALID_LOGIN' || String(e['message']).includes('INVALID_LOGIN') ? 400 : 500),
      objectName,
    })
  }

  return new SalesforceError({
    message: String(err ?? 'Salesforce operation failed'),
    errorCode: 'UNKNOWN_ERROR',
    statusCode: 500,
    objectName,
  })
}
