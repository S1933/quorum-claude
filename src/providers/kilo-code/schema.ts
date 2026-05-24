import { z } from 'zod';

const SafeExtraArgSchema = z.enum([
  '--thinking',
]);

export const KiloCodeConfigSchema = z
  .object({
    type: z.literal('kilo-code'),
    model: z.string().min(1).optional(),
    binary: z.string().min(1).default('kilo'),
    agent: z.string().min(1).optional(),
    variant: z.string().min(1).optional(),
    format: z.enum(['default', 'json']).default('default'),
    extra_args: z.array(SafeExtraArgSchema).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type KiloCodeConfig = z.infer<typeof KiloCodeConfigSchema>;
