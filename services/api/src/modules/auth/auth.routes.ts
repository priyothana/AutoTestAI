/**
 * Auth Module — Routes
 *
 * POST /signup            — Create new user
 * POST /login             — Authenticate user
 * POST /logout            — Log out user and clear cookie
 * GET  /me                — Get current authenticated user details
 * POST /forgot-password   — Request a password reset token
 * POST /reset-password    — Reset password using the token
 * GET  /google            — Redirect to Google OAuth consent screen
 * GET  /google/callback   — Handle Google OAuth callback, issue JWT
 *
 * Exact contract match with Python: app/api/v1/endpoints/users.py
 */
import type { FastifyInstance } from 'fastify'
import { UserCreateSchema, UserLoginSchema, ForgotPasswordSchema, ResetPasswordSchema, UserProfileUpdateSchema } from './auth.schema.js'
import { createUser, loginUser, forgotPassword, resetPassword } from './auth.service.js'
import { getGoogleAuthUrl, handleGoogleCallback } from './google-oauth.service.js'
import prisma from '../../shared/db/prisma.js'
import { hashPassword, verifyPassword } from '../../shared/auth/jwt.js'

// ─── Sliding-Window Rate Limiting for Login ─────────────────────────────────
const loginAttempts = new Map<string, { count: number; resetTime: number }>()
const LIMIT_WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const MAX_ATTEMPTS = 5 // max 5 attempts per window

function isRateLimited(ip: string): boolean {
  const now = Date.now()
  const attempt = loginAttempts.get(ip)

  if (!attempt) {
    loginAttempts.set(ip, { count: 1, resetTime: now + LIMIT_WINDOW_MS })
    return false
  }

  if (now > attempt.resetTime) {
    loginAttempts.set(ip, { count: 1, resetTime: now + LIMIT_WINDOW_MS })
    return false
  }

  attempt.count++
  if (attempt.count > MAX_ATTEMPTS) {
    return true
  }

  return false
}

export async function authRoutes(app: FastifyInstance) {

  // Shared signup handler — used by both /signup and /register
  const signupHandler = async (request: any, reply: any) => {
    try {
      const body = UserCreateSchema.parse(request.body)
      const user = await createUser(body)
      return reply.status(201).send({
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        is_active: user.is_active,
        role: user.role,
      })
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  }

  /** POST /signup — primary registration endpoint */
  app.post('/signup', signupHandler)

  /** POST /register — alias (Python parity) */
  app.post('/register', signupHandler)

  /**
   * POST /login
   * Response: { access_token: string, token_type: "bearer", user: {...} }
   */
  app.post('/login', async (request, reply) => {
    // 1. Check Rate Limiting
    const ip = request.ip || '127.0.0.1'
    if (isRateLimited(ip)) {
      return reply.status(429).send({
        detail: 'Too many login attempts. Please try again after 15 minutes.'
      })
    }

    try {
      const body = UserLoginSchema.parse(request.body)
      const user = await loginUser(body)

      // 2. Generate Real JWT
      const token = app.jwt.sign({
        sub: String(user.id),
        email: user.email,
        username: user.username,
        role: user.role,
      })

      // 3. Set Secure HTTP-Only Cookie
      reply.setCookie('token', token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60, // 7 days (matches JWT expiration)
      })

      // 4. Return same contract
      return reply.send({
        access_token: token,
        token_type: 'bearer',
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          full_name: user.full_name,
          role: user.role,
        }
      })
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  })

  /**
   * POST /logout
   * Clears the HTTP-only session cookie
   */
  app.post('/logout', async (request, reply) => {
    reply.clearCookie('token', {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    })
    return reply.send({ success: true, message: 'Logged out successfully' })
  })

  /**
   * GET /me
   * Returns details of currently authenticated user.
   */
  app.get('/me', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    try {
      const userId = (request.user as any).sub
      const user = await prisma.users.findUnique({
        where: { id: parseInt(userId, 10) },
        select: {
          id: true,
          email: true,
          username: true,
          full_name: true,
          is_active: true,
          role: true,
          avatar_url: true,
          created_at: true,
        }
      })

      if (!user) {
        return reply.status(404).send({ detail: 'User not found' })
      }

      return reply.send(user)
    } catch (err: any) {
      return reply.status(401).send({ detail: 'Not authenticated' })
    }
  })

  /**
   * PUT /profile
   * Updates details of the currently authenticated user.
   */
  app.put('/profile', {
    preHandler: [(app as any).authenticate]
  }, async (request, reply) => {
    try {
      const userId = parseInt((request.user as any).sub, 10)
      const body = UserProfileUpdateSchema.parse(request.body)

      const user = await prisma.users.findUnique({
        where: { id: userId }
      })

      if (!user) {
        return reply.status(404).send({ detail: 'User not found' })
      }

      // Check unique constraints for username
      if (body.username && body.username !== user.username) {
        const existing = await prisma.users.findUnique({
          where: { username: body.username }
        })
        if (existing) {
          return reply.status(400).send({ detail: 'Username already taken' })
        }
      }

      // Check unique constraints for email
      if (body.email && body.email !== user.email) {
        const existing = await prisma.users.findUnique({
          where: { email: body.email }
        })
        if (existing) {
          return reply.status(400).send({ detail: 'Email already registered' })
        }
      }

      const updateData: Record<string, any> = {}
      if (body.full_name !== undefined) updateData.full_name = body.full_name
      if (body.username !== undefined) updateData.username = body.username
      if (body.email !== undefined) updateData.email = body.email
      if (body.avatar_url !== undefined) updateData.avatar_url = body.avatar_url

      // Handle password updates
      if (body.new_password) {
        if (!body.current_password) {
          return reply.status(400).send({ detail: 'Current password is required to set a new password' })
        }
        const isValidPassword = await verifyPassword(body.current_password, user.hashed_password)
        if (!isValidPassword) {
          return reply.status(400).send({ detail: 'Incorrect current password' })
        }
        updateData.hashed_password = await hashPassword(body.new_password)
      }

      const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          username: true,
          full_name: true,
          is_active: true,
          role: true,
          avatar_url: true,
          created_at: true
        }
      })

      // Re-sign JWT Token and update HTTP-only Cookie
      const token = app.jwt.sign({
        sub: String(updatedUser.id),
        email: updatedUser.email,
        username: updatedUser.username,
        role: updatedUser.role,
      })

      reply.setCookie('token', token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60,
      })

      return reply.send({
        user: updatedUser,
        access_token: token,
        token_type: 'bearer'
      })
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  })

  /**
   * POST /forgot-password
   */
  app.post('/forgot-password', async (request, reply) => {
    try {
      const body = ForgotPasswordSchema.parse(request.body)
      const result = await forgotPassword(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  })

  /**
   * POST /reset-password
   */
  app.post('/reset-password', async (request, reply) => {
    try {
      const body = ResetPasswordSchema.parse(request.body)
      const result = await resetPassword(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  })

  /**
   * GET /google
   */
  app.get('/google', async (_request, reply) => {
    try {
      const url = getGoogleAuthUrl()
      return reply.redirect(url)
    } catch (err: any) {
      const msg = err.message ?? 'Google OAuth not configured'
      return reply.status(503).send({ detail: msg })
    }
  })

  /**
   * GET /google/callback
   */
  app.get('/google/callback', async (request, reply) => {
    const { code, error } = request.query as { code?: string; error?: string }

    const frontendBase = process.env.NEXT_PUBLIC_FRONTEND_URL ?? 'http://localhost:3000'

    if (error || !code) {
      return reply.redirect(`${frontendBase}/login?oauth_error=${encodeURIComponent(error ?? 'no_code')}`)
    }

    try {
      const result = await handleGoogleCallback(code, app as any)
      // Set the token cookie here too for Google OAuth callback!
      reply.setCookie('token', result.access_token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60,
      })

      // Redirect to frontend with the JWT in the query param so client-side localStorage is updated
      return reply.redirect(`${frontendBase}/login?token=${encodeURIComponent(result.access_token)}`)
    } catch (err: any) {
      const msg = err.message ?? 'OAuth callback failed'
      return reply.redirect(`${frontendBase}/login?oauth_error=${encodeURIComponent(msg)}`)
    }
  })
}
