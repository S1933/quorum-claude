import { z } from 'zod';

export const CursorAgentConfigSchema = z
  .object({
    type: z.literal('cursor-agent'),
    model: z.string().min(1).optional(),
    binary: z.string().min(1).default('cursor-agent'),
    api_key: z.string().min(1).optional(),
    output_format: z.enum(['text', 'json', 'stream-json']).default('text'),
    extra_args: z.array(z.never()).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type CursorAgentConfig = z.infer<typeof CursorAgentConfigSchema>;
