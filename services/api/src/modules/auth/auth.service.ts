/**
 * Auth Module — Service Layer
 *
 * Handles user creation and authentication.
 * Port of Python users.py business logic.
 */
import prisma from '../../shared/db/prisma.js'
import { hashPassword, verifyPassword } from '../../shared/auth/jwt.js'
import { createModuleLogger } from '../../shared/logger/index.js'
import type { UserCreate, UserLogin } from './auth.schema.js'

const log = createModuleLogger('auth')

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
      role: 'tester',
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

  // Match Python response exactly
  return {
    access_token: 'fake-jwt-token-for-demo',
    token_type: 'bearer',
  }
}
