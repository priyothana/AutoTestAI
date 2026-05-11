/**
 * Auth Module — Routes
 *
 * POST /signup            — Create new user
 * POST /login             — Authenticate user
 * POST /forgot-password   — Request a password reset token
 * POST /reset-password    — Reset password using the token
 * GET  /google            — Redirect to Google OAuth consent screen
 * GET  /google/callback   — Handle Google OAuth callback, issue JWT
 *
 * Exact contract match with Python: app/api/v1/endpoints/users.py
 */
import type { FastifyInstance } from 'fastify'
import { UserCreateSchema, UserLoginSchema, ForgotPasswordSchema, ResetPasswordSchema } from './auth.schema.js'
import { createUser, loginUser, forgotPassword, resetPassword } from './auth.service.js'
import { getGoogleAuthUrl, handleGoogleCallback } from './google-oauth.service.js'

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

  /** POST /api/v1/users/signup — primary registration endpoint */
  app.post('/signup', signupHandler)

  /** POST /api/v1/users/register — alias (Python parity) */
  app.post('/register', signupHandler)

  /**
   * POST /api/v1/users/login
   * Response: { access_token: string, token_type: "bearer" }
   */
  app.post('/login', async (request, reply) => {
    try {
      const body = UserLoginSchema.parse(request.body)
      const result = await loginUser(body)
      return reply.send(result)
    } catch (err: any) {
      if (err.statusCode) {
        return reply.status(err.statusCode).send({ detail: err.message })
      }
      throw err
    }
  })

  /**
   * POST /api/v1/users/forgot-password
   * Body: { identifier: string }  — email OR username accepted
   * Always responds 200 to prevent enumeration.
   * The reset token is printed to the API server console (dev mode).
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
   * POST /api/v1/users/reset-password
   * Body: { token: string, new_password: string }
   * Validates the token (in-memory), hashes and stores the new password.
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
   * GET /api/v1/users/google
   * Redirects the browser to Google's OAuth 2.0 consent screen.
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
   * GET /api/v1/users/google/callback
   * Google redirects here with ?code=... after the user consents.
   * We exchange the code for a JWT, then redirect the frontend to
   * /login?token=<jwt> so it can store it and navigate to /dashboard.
   */
  app.get('/google/callback', async (request, reply) => {
    const { code, error } = request.query as { code?: string; error?: string }

    const frontendBase = process.env.NEXT_PUBLIC_FRONTEND_URL ?? 'http://localhost:3000'

    if (error || !code) {
      return reply.redirect(`${frontendBase}/login?oauth_error=${encodeURIComponent(error ?? 'no_code')}`)
    }

    try {
      const result = await handleGoogleCallback(code, app as any)
      // Redirect to frontend with the JWT in the query param
      return reply.redirect(`${frontendBase}/login?token=${encodeURIComponent(result.access_token)}`)
    } catch (err: any) {
      const msg = err.message ?? 'OAuth callback failed'
      return reply.redirect(`${frontendBase}/login?oauth_error=${encodeURIComponent(msg)}`)
    }
  })
}
