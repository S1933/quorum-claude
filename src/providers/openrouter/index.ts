import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { AgentTask, AgentResult, ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';
import { OpenRouterConfigSchema, type OpenRouterConfig } from './schema.ts';
import { OpenRouterClient, type ChatMessage } from './client.ts';
import { parseFindings, REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';

const PROVIDER_TYPE = 'openrouter';

class OpenRouterProvider implements Provider {
  readonly kind = 'http' as const;
  private readonly client: OpenRouterClient;

  constructor(readonly id: string, private readonly cfg: OpenRouterConfig) {
    this.client = new OpenRouterClient(cfg, id);
  }

  capabilities(): ProviderCapabilities {
    return {
      agent: true,
      review: true,
      streaming: true,
      tools: false,
      mcp: false,
      localExecution: false,
      backgroundJobs: false,
      costReporting: true,
    };
  }

  async execute(task: AgentTask, ctx: ExecCtx): Promise<AgentResult> {
    const messages: ChatMessage[] = [
      { role: 'user', content: task.instruction },
    ];
    const res = await this.client.chat(
      {
        model: ctx.modelOverride?.model ?? this.cfg.model,
        messages,
        temperature: ctx.modelOverride?.temperature ?? this.cfg.temperature,
        max_tokens: ctx.modelOverride?.maxTokens ?? this.cfg.max_tokens,
        top_p: ctx.modelOverride?.topP ?? this.cfg.top_p,
      },
      ctx.signal,
    );

    const output = res.choices[0]?.message.content ?? '';
    const usage = res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
      : undefined;

    if (usage) {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: ctx.reviewerId ?? this.id,
        event: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      });
    }

    return usage ? { taskId: task.id, output, usage } : { taskId: task.id, output };
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const messages: ChatMessage[] = [
      { role: 'system', content: `${task.systemPrompt}\n\n${REVIEW_OUTPUT_INSTRUCTIONS}` },
      { role: 'user', content: task.instruction },
    ];

    const res = await this.client.chat(
      {
        model: ctx.modelOverride?.model ?? this.cfg.model,
        messages,
        temperature: ctx.modelOverride?.temperature ?? this.cfg.temperature,
        max_tokens: ctx.modelOverride?.maxTokens ?? this.cfg.max_tokens,
        top_p: ctx.modelOverride?.topP ?? this.cfg.top_p,
        response_format: { type: 'json_object' },
      },
      ctx.signal,
    );

    const raw = res.choices[0]?.message.content ?? '';
    const findings = parseFindings(raw, task.reviewerId);

    for (const finding of findings) {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: task.reviewerId,
        event: { type: 'finding', finding },
      });
    }

    const usage = res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens }
      : undefined;

    if (usage) {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: task.reviewerId,
        event: { type: 'usage', inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      });
    }

    const base = {
      taskId: task.id,
      reviewerId: task.reviewerId,
      findings,
      rawOutput: raw,
      durationMs: Date.now() - started,
    };
    return usage ? { ...base, usage } : base;
  }

  async *stream(task: AgentTask | ReviewTask, ctx: ExecCtx) {
    const messages: ChatMessage[] =
      task.kind === 'review'
        ? [
            { role: 'system', content: `${task.systemPrompt}\n\n${REVIEW_OUTPUT_INSTRUCTIONS}` },
            { role: 'user', content: task.instruction },
          ]
        : [{ role: 'user', content: task.instruction }];

    try {
      for await (const chunk of this.client.chatStream(
        {
          model: ctx.modelOverride?.model ?? this.cfg.model,
          messages,
          temperature: ctx.modelOverride?.temperature ?? this.cfg.temperature,
          max_tokens: ctx.modelOverride?.maxTokens ?? this.cfg.max_tokens,
          top_p: ctx.modelOverride?.topP ?? this.cfg.top_p,
        },
        ctx.signal,
      )) {
        yield { type: 'token' as const, text: chunk };
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new ProviderRuntimeError(this.id, `stream failed: ${(err as Error).message}`, err);
    }
  }
}

export const openRouterFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: OpenRouterConfigSchema,
  async create(instanceId, config, _ctx) {
    return new OpenRouterProvider(instanceId, config as OpenRouterConfig);
  },
};
