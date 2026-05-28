import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult, normaliseSubprocessOutput } from '../subprocess.ts';
import { CursorAgentConfigSchema, type CursorAgentConfig } from './schema.ts';

const PROVIDER_TYPE = 'cursor-agent';
const STDIN_PROMPT = 'Read the review instructions from stdin and return only the requested output.';

class CursorAgentProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: CursorAgentConfig,
    private readonly pluginCtx: PluginCtx,
  ) {}

  capabilities(): ProviderCapabilities {
    return {
      review: true,
      streaming: false,
      tools: true,
      mcp: true,
      localExecution: true,
      backgroundJobs: false,
      costReporting: false,
    };
  }

  private buildArgs(ctx: ExecCtx): string[] {
    const model = ctx.modelOverride?.model ?? this.cfg.model;
    const args = [
      '--print',
      STDIN_PROMPT,
      '--output-format',
      this.cfg.output_format,
      ...this.cfg.extra_args,
    ];
    if (model) args.push('--model', model);
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'cursor-agent',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args: this.buildArgs(ctx),
      cwd: this.cfg.cwd ?? this.pluginCtx.workspaceRoot,
      stdin: prompt,
      env: {
        ...this.pluginCtx.env,
        ...(this.cfg.api_key ? { CURSOR_API_KEY: this.cfg.api_key } : {}),
      },
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    const CURSOR_UNWRAP_KEYS = ['output', 'response', 'text', 'content', 'result'];
    return buildSubprocessReviewResult(task, normaliseSubprocessOutput(raw, CURSOR_UNWRAP_KEYS), started, ctx.bus);
  }
}

export const cursorAgentFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: CursorAgentConfigSchema,
  async create(instanceId, config, ctx) {
    return new CursorAgentProvider(instanceId, config as CursorAgentConfig, ctx);
  },
};
