import { z } from 'zod';

export const aiChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(4000),
});

export const aiChatSchema = z.object({
  message: z.string().min(1, 'Message cannot be empty').max(2000).trim(),
  history: z.array(aiChatMessageSchema).max(20).optional().default([]),
});

export type AIChatInput = z.infer<typeof aiChatSchema>;
