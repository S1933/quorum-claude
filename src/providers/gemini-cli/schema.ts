import { z } from 'zod';

const SafeExtraArgSchema = z.enum([
  '--screen-reader',
]);

export const GeminiCliConfigSchema = z
  .object({
    type: z.literal('gemini-cli'),
    model: z.string().min(1).optional(),
    binary: z.string().min(1).default('gemini'),
    approval_mode: z.enum(['default', 'auto_edit', 'plan']).default('plan'),
    sandbox: z.boolean().default(true),
    skip_trust: z.boolean().default(true),
    extra_args: z.array(SafeExtraArgSchema).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type GeminiCliConfig = z.infer<typeof GeminiCliConfigSchema>;
