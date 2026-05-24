import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult, UsageInfo } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';
import { parseFindings, REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { OllamaClient, type OllamaChatRequest, type OllamaMessage } from './client.ts';
import { OllamaConfigSchema, type OllamaConfig } from './schema.ts';

const PROVIDER_TYPE = 'ollama';

class OllamaProvider implements Provider {
  readonly kind = 'http' as const;
  private readonly client: OllamaClient;

  constructor(readonly id: string, private readonly cfg: OllamaConfig) {
    this.client = new OllamaClient(cfg, id);
  }

  capabilities(): ProviderCapabilities {
    return {
      review: true,
      streaming: true,
      tools: false,
      mcp: false,
      localExecution: true,
      backgroundJobs: false,
      costReporting: false,
    };
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const res = await this.client.chat(reviewRequest(this.cfg, ctx, messagesFor(task)), ctx.signal);
    const raw = res.message?.content?.trim() ?? '';
    if (!raw) {
      throw new ProviderRuntimeError(this.id, 'Ollama returned no message content');
    }

    const findings = parseFindings(raw, task.reviewerId);
    for (const finding of findings) {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: task.reviewerId,
        event: { type: 'finding', finding },
      });
    }

    const usage = toUsage(res);
    const result = {
      taskId: task.id,
      reviewerId: task.reviewerId,
      findings,
      rawOutput: raw,
      durationMs: Date.now() - started,
    };
    return usage ? { ...result, usage } : result;
  }

  async *stream(task: ReviewTask, ctx: ExecCtx) {
    try {
      for await (const event of this.client.chatStream(chatRequest(this.cfg, ctx, messagesFor(task)), ctx.signal)) {
        if (event.type === 'token') {
          yield { type: 'token' as const, text: event.text };
        } else {
          yield {
            type: 'usage' as const,
            inputTokens: event.prompt_eval_count,
            outputTokens: event.eval_count,
          };
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new ProviderRuntimeError(this.id, `stream failed: ${(err as Error).message}`, err);
    }
  }
}

function messagesFor(task: ReviewTask): OllamaMessage[] {
  return [
    { role: 'system', content: `${task.systemPrompt}\n\n${REVIEW_OUTPUT_INSTRUCTIONS}` },
    { role: 'user', content: task.instruction },
  ];
}

function chatRequest(
  cfg: OllamaConfig,
  ctx: ExecCtx,
  messages: OllamaMessage[],
): OllamaChatRequest {
  const req: OllamaChatRequest = {
    model: ctx.modelOverride?.model ?? cfg.model,
    messages,
  };
  const options = toOptions(cfg, ctx);
  if (Object.keys(options).length > 0) req.options = options;
  if (cfg.keep_alive !== undefined) req.keep_alive = cfg.keep_alive;
  return req;
}

function reviewRequest(
  cfg: OllamaConfig,
  ctx: ExecCtx,
  messages: OllamaMessage[],
): OllamaChatRequest {
  return {
    ...chatRequest(cfg, ctx, messages),
    format: 'json',
  };
}

function toOptions(cfg: OllamaConfig, ctx: ExecCtx): NonNullable<OllamaChatRequest['options']> {
  const options: NonNullable<OllamaChatRequest['options']> = {};
  const temperature = ctx.modelOverride?.temperature ?? cfg.temperature;
  const maxTokens = ctx.modelOverride?.maxTokens ?? cfg.max_tokens;
  const topP = ctx.modelOverride?.topP ?? cfg.top_p;
  if (temperature !== undefined) options.temperature = temperature;
  if (maxTokens !== undefined) options.num_predict = maxTokens;
  if (topP !== undefined) options.top_p = topP;
  return options;
}

function toUsage(res: { prompt_eval_count?: number; eval_count?: number }): UsageInfo | undefined {
  if (typeof res.prompt_eval_count !== 'number' || typeof res.eval_count !== 'number') {
    return undefined;
  }
  return {
    inputTokens: res.prompt_eval_count,
    outputTokens: res.eval_count,
  };
}

export const ollamaFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: OllamaConfigSchema,
  async create(instanceId, config, _ctx) {
    return new OllamaProvider(instanceId, config as OllamaConfig);
  },
};
