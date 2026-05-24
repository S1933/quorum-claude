import { z } from 'zod';

export const CodexCliConfigSchema = z
  .object({
    type: z.literal('codex-cli'),
    model: z.string().min(1).optional(),
    binary: z.string().min(1).default('codex'),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).default('read-only'),
    approval_policy: z.enum(['untrusted', 'on-request', 'never']).default('never'),
    extra_args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type CodexCliConfig = z.infer<typeof CodexCliConfigSchema>;
