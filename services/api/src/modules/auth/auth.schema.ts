/**
 * Auth Module — Zod Schemas
 *
 * Maps from Python Pydantic: UserCreate, UserLogin, UserResponse
 */
import { z } from 'zod'

export const UserCreateSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1),
  password: z.string().min(1),
  full_name: z.string().optional().nullable(),
  role: z.string().default('TESTER'),
})

export const UserLoginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const UserResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  full_name: z.string().nullable().optional(),
  is_active: z.boolean(),
  role: z.string(),
})

export type UserCreate = z.infer<typeof UserCreateSchema>
export type UserLogin = z.infer<typeof UserLoginSchema>
export type UserResponse = z.infer<typeof UserResponseSchema>
