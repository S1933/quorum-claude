import { z } from 'zod';

export const OllamaConfigSchema = z
  .object({
    type: z.literal('ollama'),
    model: z.string().min(1),
    base_url: z.string().url().default('http://localhost:11434'),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    keep_alive: z.union([z.string().min(1), z.number()]).optional(),
  })
  .strict();

export type OllamaConfig = z.infer<typeof OllamaConfigSchema>;
