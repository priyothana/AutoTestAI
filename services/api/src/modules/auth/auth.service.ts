/**
 * Auth Module — Service Layer
 *
 * Handles user creation and authentication.
 * Port of Python users.py business logic.
 */
import prisma from '../../shared/db/prisma.js'
import { hashPassword, verifyPassword } from '../../shared/auth/jwt.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import { randomBytes } from 'crypto'
import { sendPasswordResetEmail } from '../../shared/email/email.service.js'
import type { UserCreate, UserLogin, ForgotPassword, ResetPassword } from './auth.schema.js'

const log = createModuleLogger('auth')

// ─── In-memory password reset token store ────────────────────────────────────
// Keyed by token → { email, expiresAt }. No DB migration needed.
// Tokens are 32-byte hex strings; TTL = 15 minutes.
const resetTokenStore = new Map<string, { email: string; expiresAt: number }>()
const RESET_TOKEN_TTL_MS = 15 * 60 * 1000 // 15 minutes

/**
 * Create a new user. Throws if email or username already exists.
 */
export async function createUser(data: UserCreate) {
  const username = data.username ?? data.email.split('@')[0]
  log.info(`[AUTH] Signup triggered for username: ${username}, email: ${data.email}`)

  // Check existing email
  const existingEmail = await prisma.users.findUnique({
    where: { email: data.email },
  })
  if (existingEmail) {
    log.info(`[AUTH] Signup failed: Email ${data.email} already exists`)
    throw { statusCode: 400, message: 'Email already registered' }
  }

  // Check existing username
  const existingUsername = await prisma.users.findUnique({
    where: { username },
  })
  if (existingUsername) {
    log.info(`[AUTH] Signup failed: Username ${username} already exists`)
    throw { statusCode: 400, message: 'Username already taken' }
  }

  const hashedPassword = await hashPassword(data.password)

  const newUser = await prisma.users.create({
    data: {
      username,
      email: data.email,
      hashed_password: hashedPassword,
      full_name: data.full_name ?? null,
      role: data.role,
      is_active: true,
    },
  })

  log.info(`[AUTH] User successfully inserted into DB with ID: ${newUser.id}`)
  return newUser
}

/**
 * Authenticate a user by username + password.
 * Returns user record or throws 400.
 *
 * NOTE: Python returns { access_token: "fake-jwt-token-for-demo", token_type: "bearer" }
 * We preserve this exact response for frontend compatibility.
 */
export async function loginUser(data: UserLogin) {
  const identifier = data.username ?? data.email ?? ''
  log.info(`[AUTH] Login attempt for: ${identifier}`)

  // Try username first, then email
  let user = await prisma.users.findUnique({
    where: { username: identifier },
  })
  if (!user) {
    user = await prisma.users.findUnique({
      where: { email: identifier },
    })
  }

  if (!user) {
    log.info(`[AUTH] Login failed: User ${identifier} not found`)
    throw { statusCode: 400, message: 'Incorrect username or password' }
  }

  const valid = await verifyPassword(data.password, user.hashed_password)
  if (!valid) {
    log.info(`[AUTH] Login failed: Invalid password for ${identifier}`)
    throw { statusCode: 400, message: 'Incorrect username or password' }
  }

  log.info(`[AUTH] Login successful for: ${identifier} (ID: ${user.id})`)

  return user
}

/**
 * Initiate a password reset for the given email.
 * - Always responds with success to prevent email enumeration.
 * - Generates a secure token (32 bytes hex, 15-min TTL).
 * - In production, send this token via email. Here it is logged to stdout
 *   so developers can copy it from the terminal during development.
 */
export async function forgotPassword(data: ForgotPassword): Promise<{ message: string }> {
  const { identifier } = data
  log.info(`[AUTH] Forgot-password request for identifier: ${identifier}`)

  // Resolve by email first, then by username — covers both login strategies
  let user = await prisma.users.findUnique({ where: { email: identifier } })
  if (!user) {
    user = await prisma.users.findUnique({ where: { username: identifier } })
  }

  if (user) {
    const resolvedEmail = user.email

    // Purge any existing token for this user
    for (const [tok, entry] of resetTokenStore.entries()) {
      if (entry.email === resolvedEmail) resetTokenStore.delete(tok)
    }

    const token = randomBytes(32).toString('hex')
    const expiresInMin = RESET_TOKEN_TTL_MS / 60_000
    resetTokenStore.set(token, { email: resolvedEmail, expiresAt: Date.now() + RESET_TOKEN_TTL_MS })

    // ── Try to send reset email ─────────────────────────────────────────────
    const emailSent = await sendPasswordResetEmail({
      toEmail: resolvedEmail,
      identifier,
      token,
      expiresInMin,
    })

    // ── Fallback: always log to console (useful when SMTP not configured) ──
    if (!emailSent) {
      log.warn(`[AUTH] SMTP not configured — token logged to console for ${resolvedEmail}`)
      console.log(`\n[AUTH] ====================================================`)
      console.log(`[AUTH]  PASSWORD RESET TOKEN (expires in ${expiresInMin} min)`)
      console.log(`[AUTH]  Account : ${identifier}`)
      console.log(`[AUTH]  Email   : ${resolvedEmail}`)
      console.log(`[AUTH]  Token   : ${token}`)
      console.log(`[AUTH]  NOTE    : Set SMTP_HOST/SMTP_USER/SMTP_PASS in .env to email tokens`)
      console.log(`[AUTH] ====================================================\n`)
    } else {
      log.info(`[AUTH] ✉️  Password-reset email sent to ${resolvedEmail}`)
    }
  } else {
    log.info(`[AUTH] Forgot-password: no user found for identifier ${identifier} — silent success`)
  }

  return { message: 'If an account exists for that identifier, a reset token has been sent to the registered email.' }
}

/**
 * Reset a user's password using a valid reset token.
 * Token is deleted immediately after use (one-time).
 */
export async function resetPassword(data: ResetPassword): Promise<{ message: string }> {
  const entry = resetTokenStore.get(data.token)

  if (!entry) {
    log.warn('[AUTH] Reset-password: token not found')
    throw { statusCode: 400, message: 'Invalid or expired reset token.' }
  }

  if (Date.now() > entry.expiresAt) {
    resetTokenStore.delete(data.token)
    log.warn(`[AUTH] Reset-password: token expired for ${entry.email}`)
    throw { statusCode: 400, message: 'Reset token has expired. Please request a new one.' }
  }

  const user = await prisma.users.findUnique({ where: { email: entry.email } })
  if (!user) {
    resetTokenStore.delete(data.token)
    throw { statusCode: 400, message: 'User not found.' }
  }

  const hashed = await hashPassword(data.new_password)
  await prisma.users.update({
    where: { email: entry.email },
    data: { hashed_password: hashed },
  })

  // One-time use — delete immediately
  resetTokenStore.delete(data.token)

  log.info(`[AUTH] Password successfully reset for ${entry.email}`)
  return { message: 'Password reset successfully. You can now log in with your new password.' }
}
