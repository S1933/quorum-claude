import type { Persona } from '../core/persona.ts';
import type { Provider, ExecCtx } from '../core/provider.ts';
import type { ReviewTask, ReviewResult, ModelConfig } from '../core/task.ts';
import type { ReviewerRef, ReviewerOverrides } from '../core/pipeline.ts';
import { CapabilityError } from '../core/errors.ts';

export interface BoundReviewer {
  id: string;
  persona: Persona;
  provider: Provider;
  overrides?: ReviewerOverrides;
  run(task: Omit<ReviewTask, 'systemPrompt' | 'reviewerId' | 'kind'>, ctx: Omit<ExecCtx, 'modelOverride'>): Promise<ReviewResult>;
}

export function bindReviewer(
  ref: ReviewerRef,
  persona: Persona,
  provider: Provider,
): BoundReviewer {
  if (!provider.review) {
    throw new CapabilityError(
      `Reviewer "${ref.id}" bound to provider "${provider.id}" which does not implement review()`,
    );
  }
  if (!provider.capabilities().review) {
    throw new CapabilityError(
      `Reviewer "${ref.id}": provider "${provider.id}" reports review capability disabled`,
    );
  }

  return {
    id: ref.id,
    persona,
    provider,
    ...(ref.overrides ? { overrides: ref.overrides } : {}),
    async run(task, ctx) {
      const fullTask: ReviewTask = {
        ...task,
        kind: 'review',
        systemPrompt: persona.system,
        reviewerId: ref.id,
      };
      const modelOverride = overridesToModelConfig(ref.overrides);
      const execCtx: ExecCtx = modelOverride
        ? { ...ctx, modelOverride, reviewerId: ref.id }
        : { ...ctx, reviewerId: ref.id };
      return provider.review!(fullTask, execCtx);
    },
  };
}

function overridesToModelConfig(o?: ReviewerOverrides): ModelConfig | undefined {
  if (!o) return undefined;
  const out: ModelConfig = { model: o.model ?? '' };
  if (o.temperature !== undefined) out.temperature = o.temperature;
  if (o.maxTokens !== undefined) out.maxTokens = o.maxTokens;
  if (o.topP !== undefined) out.topP = o.topP;
  if (!o.model && o.temperature === undefined && o.maxTokens === undefined && o.topP === undefined) {
    return undefined;
  }
  return out;
}
