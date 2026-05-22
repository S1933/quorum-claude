import { z } from 'zod';

export const OpenRouterConfigSchema = z
  .object({
    type: z.literal('openrouter'),
    api_key: z.string().min(1),
    model: z.string().min(1),
    base_url: z.string().url().default('https://openrouter.ai/api/v1'),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    referer: z.string().optional(),
    title: z.string().optional(),
  })
  .strict();

export type OpenRouterConfig = z.infer<typeof OpenRouterConfigSchema>;
