/**
 * Self-Healing Module — Schemas
 */
import { z } from 'zod'

export const HealRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.string(),
    content: z.string(),
  })).optional(),
  message: z.string().optional(),
})

export type HealRequest = z.infer<typeof HealRequestSchema>
