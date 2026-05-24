import { z } from 'zod';

const SafeExtraArgSchema = z.enum([
  '--silent',
]);

export const ContinueDevConfigSchema = z
  .object({
    type: z.literal('continue-dev'),
    binary: z.string().min(1).default('cn'),
    config: z.string().min(1).optional(),
    silent: z.boolean().default(true),
    format: z.enum(['text', 'json']).default('text'),
    extra_args: z.array(SafeExtraArgSchema).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type ContinueDevConfig = z.infer<typeof ContinueDevConfigSchema>;
