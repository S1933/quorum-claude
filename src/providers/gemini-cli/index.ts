import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult } from '../subprocess.ts';
import { GeminiCliConfigSchema, type GeminiCliConfig } from './schema.ts';

const PROVIDER_TYPE = 'gemini-cli';
const STDIN_PROMPT = 'Read the review instructions from stdin and return only the requested output.';

class GeminiCliProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: GeminiCliConfig,
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
      '--prompt',
      STDIN_PROMPT,
      '--approval-mode',
      this.cfg.approval_mode,
      '--output-format',
      'text',
      ...this.cfg.extra_args,
    ];

    if (this.cfg.sandbox) args.push('--sandbox');
    if (this.cfg.skip_trust) args.push('--skip-trust');
    if (model) args.push('--model', model);
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'gemini',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args: this.buildArgs(ctx),
      cwd: this.cfg.cwd ?? this.pluginCtx.workspaceRoot,
      stdin: prompt,
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    return buildSubprocessReviewResult(task, raw.trim(), started, ctx.bus);
  }
}

export const geminiCliFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: GeminiCliConfigSchema,
  async create(instanceId, config, ctx) {
    return new GeminiCliProvider(instanceId, config as GeminiCliConfig, ctx);
  },
};
