import { z } from 'zod';

const NonEmpty = z.string().min(1);

export const PersonaConfigSchema = z.object({
  description: NonEmpty,
  system: NonEmpty,
  outputSchemaHint: z.string().optional(),
});

export const ReviewerOverridesSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    model: z.string().optional(),
  })
  .strict();

export const ReviewerConfigSchema = z
  .object({
    persona: NonEmpty,
    provider: NonEmpty,
    overrides: ReviewerOverridesSchema.optional(),
    fileExtensions: z.array(NonEmpty).optional(),
  })
  .strict();

export const ConsensusConfigSchema = z
  .object({
    strategy: NonEmpty,
    requireAgreement: z.number().int().positive().optional(),
  })
  .catchall(z.unknown());

export const PipelineConfigSchema = z
  .object({
    parallel: z.boolean().default(true),
    reviewers: z.array(NonEmpty).min(0),
    consensus: ConsensusConfigSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    maxConcurrency: z.number().int().positive().optional(),
  })
  .strict();

export const ProviderConfigSchema = z
  .object({
    type: NonEmpty,
  })
  .catchall(z.unknown());

export const DefaultsSchema = z
  .object({
    pipeline: NonEmpty.optional(),
    maxDiffBytes: z.number().int().positive().optional(),
    includeFiles: z.array(z.string().min(1)).optional(),
    excludeFiles: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const QuorumConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: DefaultsSchema.optional(),
    providers: z.record(NonEmpty, ProviderConfigSchema),
    personas: z.record(NonEmpty, PersonaConfigSchema),
    reviewers: z.record(NonEmpty, ReviewerConfigSchema),
    pipelines: z.record(NonEmpty, PipelineConfigSchema),
  })
  .strict();

export type QuorumConfig = z.infer<typeof QuorumConfigSchema>;
export type PersonaConfig = z.infer<typeof PersonaConfigSchema>;
export type ReviewerConfig = z.infer<typeof ReviewerConfigSchema>;
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
