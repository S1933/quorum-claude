import { z } from 'zod';

export const ClaudeCodeConfigSchema = z
  .object({
    type: z.literal('claude-code'),
    model: z.string().min(1),
    binary: z.string().default('claude'),
    extra_args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type ClaudeCodeConfig = z.infer<typeof ClaudeCodeConfigSchema>;
