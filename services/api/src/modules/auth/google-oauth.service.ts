/**
 * Google OAuth 2.0 Service
 *
 * Generates the Google authorization URL and handles the callback:
 *   1. Exchanges the authorization code for tokens via Google's token endpoint.
 *   2. Fetches the user's Google profile (sub, email, name, picture).
 *   3. Upserts the user in the local database (no password required for OAuth users).
 *   4. Signs and returns our own JWT so the frontend can use a single token strategy.
 */
import { OAuth2Client } from 'google-auth-library'
import prisma from '../../shared/db/prisma.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { randomBytes } from 'crypto'

const log = createModuleLogger('google-oauth')

// ─── Lazy-init the OAuth2 client ─────────────────────────────────────────────
function getClient(): OAuth2Client {
  const clientId     = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const redirectUri  = process.env.GOOGLE_REDIRECT_URI ?? 'http://localhost:4000/api/v1/users/google/callback'

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env')
  }

  return new OAuth2Client(clientId, clientSecret, redirectUri)
}

/**
 * Build the URL the browser should be redirected to in order to start
 * the Google OAuth consent flow.
 */
export function getGoogleAuthUrl(): string {
  const client = getClient()
  const scopes = ['openid', 'email', 'profile']

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: scopes,
    prompt: 'select_account',
  })

  log.info('[GOOGLE] Generated auth URL')
  return url
}

/**
 * Handle the OAuth callback.
 *   - Exchanges `code` for Google tokens.
 *   - Decodes the ID token to get user info (no extra HTTP call needed).
 *   - Upserts the user into the `users` table.
 *   - Returns an opaque access_token identical to the regular login response
 *     so the frontend can treat both flows uniformly.
 */
export async function handleGoogleCallback(
  code: string,
  app: { jwt: { sign: (payload: object) => string } },
): Promise<{ access_token: string; token_type: string }> {
  const client = getClient()

  // Exchange code → tokens
  const { tokens } = await client.getToken(code)
  client.setCredentials(tokens)

  if (!tokens.id_token) {
    throw { statusCode: 400, message: 'No ID token returned from Google.' }
  }

  // Verify & decode the ID token (also validates audience/expiry)
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID!,
  })
  const payload = ticket.getPayload()
  if (!payload || !payload.email) {
    throw { statusCode: 400, message: 'Could not retrieve email from Google token.' }
  }

  const { sub: googleId, email, name, picture } = payload
  log.info(`[GOOGLE] OAuth callback for email: ${email}`)

  // Derive a unique, deterministic username from email
  const baseUsername = email.split('@')[0].replace(/[^a-z0-9_]/gi, '_')

  // Upsert: find existing user by email, or create new
  let user = await prisma.users.findUnique({ where: { email } })

  if (!user) {
    // New user — no password hash (OAuth-only account)
    // Generate a random secure placeholder so the `hashed_password` NOT NULL constraint is satisfied
    const placeholder = randomBytes(32).toString('hex')

    // Ensure username is unique
    let username = baseUsername
    const existing = await prisma.users.findUnique({ where: { username } })
    if (existing) {
      username = `${baseUsername}_${randomBytes(3).toString('hex')}`
    }

    user = await prisma.users.create({
      data: {
        email,
        username,
        full_name: name ?? null,
        hashed_password: placeholder,
        role: 'tester',
        is_active: true,
      },
    })
    log.info(`[GOOGLE] Created new OAuth user: ${email} (ID: ${user.id})`)
  } else {
    // Existing user — optionally update full_name / picture if empty
    const updates: Record<string, unknown> = {}
    if (!user.full_name && name)  updates.full_name = name
    if (Object.keys(updates).length > 0) {
      user = await prisma.users.update({ where: { id: user.id }, data: updates })
    }
    log.info(`[GOOGLE] Existing user signed in via Google: ${email} (ID: ${user.id})`)
  }

  // Sign our own JWT (matches the app's JWT secret/strategy)
  const access_token = app.jwt.sign({
    sub:      String(user.id),
    email:    user.email,
    username: user.username,
    role:     user.role,
  })

  return { access_token, token_type: 'bearer' }
}
