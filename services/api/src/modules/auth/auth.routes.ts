/**
 * Auth Module — Routes
 *
 * POST /signup — Create new user
 * POST /login  — Authenticate user
 *
 * Exact contract match with Python: app/api/v1/endpoints/users.py
 */
import type { FastifyInstance } from 'fastify'
import { UserCreateSchema, UserLoginSchema } from './auth.schema.js'
import { createUser, loginUser } from './auth.service.js'

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
}
