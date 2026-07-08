/**
 * Auth Module — Zod Schemas
 *
 * Maps from Python Pydantic: UserCreate, UserLogin, UserResponse
 */
import { z } from 'zod'

export const UserCreateSchema = z.object({
  email: z.string().email(),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
  full_name: z.string().optional().nullable(),
  role: z.string().default('USER'),
})

export const UserLoginSchema = z.object({
  username: z.string().min(1).optional(),
  email: z.string().optional(),
  password: z.string().min(1),
}).refine((data) => data.username || data.email, {
  message: 'Either username or email is required',
})

export const UserResponseSchema = z.object({
  id: z.number(),
  email: z.string(),
  full_name: z.string().nullable().optional(),
  is_active: z.boolean(),
  role: z.string(),
})

export const ForgotPasswordSchema = z.object({
  // Accepts email OR username — backend resolves to user record either way
  identifier: z.string().min(1, { message: 'Email or username is required' }),
})

export const ResetPasswordSchema = z.object({
  token: z.string().min(1, { message: 'Reset token is required' }),
  new_password: z.string().min(6, { message: 'Password must be at least 6 characters' }),
})

export const UserProfileUpdateSchema = z.object({
  full_name: z.string().optional().nullable(),
  username: z.string().min(1).optional(),
  email: z.string().email().optional(),
  avatar_url: z.string().url().or(z.string().length(0)).optional().nullable(),
  current_password: z.string().min(1).optional(),
  new_password: z.string().min(6).optional(),
})

export type UserCreate = z.infer<typeof UserCreateSchema>
export type UserLogin = z.infer<typeof UserLoginSchema>
export type UserResponse = z.infer<typeof UserResponseSchema>
export type ForgotPassword = z.infer<typeof ForgotPasswordSchema>
export type ResetPassword = z.infer<typeof ResetPasswordSchema>
export type UserProfileUpdate = z.infer<typeof UserProfileUpdateSchema>
