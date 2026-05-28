import type { Persona } from '../core/persona.ts';
import type { Provider, ExecCtx } from '../core/provider.ts';
import type { ReviewTask, ReviewResult, ModelConfig } from '../core/task.ts';
import type { ReviewerRef, ReviewerOverrides } from '../core/pipeline.ts';
import { CapabilityError, ReviewerOutputError } from '../core/errors.ts';
import { RETRY_REMINDER } from './output.ts';

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
      try {
        return await provider.review!(fullTask, execCtx);
      } catch (err) {
        // The model occasionally answers in prose instead of the JSON envelope
        // (seen with high-thinking models that narrate a clean pass). Retry once
        // with a corrective reminder appended — every provider places the
        // instruction last, so the reminder is the final thing the model sees.
        if (!(err instanceof ReviewerOutputError) || execCtx.signal.aborted) throw err;
        const retryTask: ReviewTask = {
          ...fullTask,
          instruction: `${fullTask.instruction}\n\n${RETRY_REMINDER}`,
        };
        return await provider.review!(retryTask, execCtx);
      }
    },
  };
}

function overridesToModelConfig(o?: ReviewerOverrides): ModelConfig | undefined {
  if (!o) return undefined;
  const out: ModelConfig = {};
  if (o.model !== undefined) out.model = o.model;
  if (o.temperature !== undefined) out.temperature = o.temperature;
  if (o.maxTokens !== undefined) out.maxTokens = o.maxTokens;
  if (o.topP !== undefined) out.topP = o.topP;
  if (!o.model && o.temperature === undefined && o.maxTokens === undefined && o.topP === undefined) {
    return undefined;
  }
  return out;
}
