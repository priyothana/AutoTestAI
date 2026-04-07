/**
 * Self-Healing Module — Chat Schemas
 *
 * Matches the Python HealChatRequest shape used by AiFixAssistant.tsx:
 *   POST /api/v1/test-runs/:id/heal
 *   Body: { message, chat_history, current_corrected_steps }
 */
import { z } from 'zod'

const CorrectedStepSchema = z.object({
  step_order:   z.number(),
  action:       z.string(),
  target:       z.string().default(''),
  value:        z.string().default(''),
  locator_type: z.string().optional().default(''),
})

const ChatMessageSchema = z.object({
  role:    z.string(),  // 'user' | 'assistant'
  content: z.string(),
})

export const HealRequestSchema = z.object({
  /** The user's latest message (required for conversational edit) */
  message: z.string().optional(),

  /** Rolling conversation history (last N turns) */
  chat_history: z.array(ChatMessageSchema).optional().default([]),

  /** The current corrected steps the user is editing (null = initial healing) */
  current_corrected_steps: z.array(CorrectedStepSchema).nullable().optional(),

  /** Legacy: array of message objects */
  messages: z.array(ChatMessageSchema).optional(),
})

export type HealRequest        = z.infer<typeof HealRequestSchema>
export type CorrectedStep      = z.infer<typeof CorrectedStepSchema>
export type HealChatMessage    = z.infer<typeof ChatMessageSchema>
