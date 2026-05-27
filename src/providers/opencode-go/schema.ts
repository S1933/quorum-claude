import { z } from 'zod';

export const OpenCodeGoConfigSchema = z
  .object({
    type: z.literal('opencode-go'),
    model: z.string().min(1).optional(),
    binary: z.string().min(1).default('opencode'),
    command_style: z.enum(['prompt', 'run']).default('prompt'),
    output_format: z.enum(['text', 'json']).default('text'),
    quiet: z.boolean().default(true),
    extra_args: z.array(z.never()).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type OpenCodeGoConfig = z.infer<typeof OpenCodeGoConfigSchema>;
