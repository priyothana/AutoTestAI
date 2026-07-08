/**
 * JWT Authentication Middleware
 *
 * Replaces Python's python-jose + passlib/bcrypt.
 * Uses @fastify/jwt for token handling and bcryptjs for password hashing.
 */
import fastifyJwt from '@fastify/jwt'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import bcrypt from 'bcryptjs'

/**
 * Register the JWT plugin on the Fastify instance.
 * Call this once during app setup in index.ts.
 */
export async function registerJwt(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: process.env.JWT_SECRET ?? process.env.SECRET_KEY ?? 'fallback-dev-secret-change-me',
    cookie: {
      cookieName: 'token',
      signed: false,
    },
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    },
  })

  // Authenticate decorator: verifies request JWT (either from Auth header or cookie)
  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify()
      } catch {
        reply.status(401).send({ detail: 'Not authenticated' })
      }
    },
  )

  // requireAdmin decorator: enforces ADMIN-only access
  app.decorate(
    'requireAdmin',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user as any
      if (!user || user.role !== 'ADMIN') {
        return reply.status(403).send({ detail: 'Forbidden: Admin access required' })
      }
    },
  )
}

/**
 * Hash a plain-text password using bcrypt.
 * Compatible with Python bcrypt output (same $2b$ prefix).
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(12)
  return bcrypt.hash(password, salt)
}

/**
 * Verify a plain-text password against a bcrypt hash.
 */
export async function verifyPassword(
  plainPassword: string,
  hashedPassword: string,
): Promise<boolean> {
  return bcrypt.compare(plainPassword, hashedPassword)
}
