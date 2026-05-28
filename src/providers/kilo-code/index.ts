import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult, normaliseSubprocessOutput } from '../subprocess.ts';
import { KiloCodeConfigSchema, type KiloCodeConfig } from './schema.ts';

const PROVIDER_TYPE = 'kilo-code';
const STDIN_PROMPT = 'Read the review instructions from stdin and return only the requested output.';

class KiloCodeProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: KiloCodeConfig,
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
    const args = ['run', ...this.cfg.extra_args];

    if (model) args.push('--model', model);
    if (this.cfg.agent) args.push('--agent', this.cfg.agent);
    if (this.cfg.variant) args.push('--variant', this.cfg.variant);
    if (this.cfg.format === 'json') args.push('--format', 'json');
    args.push('--', STDIN_PROMPT);
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'kilo',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args: this.buildArgs(ctx),
      cwd: this.cfg.cwd ?? this.pluginCtx.workspaceRoot,
      stdin: prompt,
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    return buildSubprocessReviewResult(task, normaliseSubprocessOutput(raw), started, ctx.bus);
  }
}

export const kiloCodeFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: KiloCodeConfigSchema,
  async create(instanceId, config, ctx) {
    return new KiloCodeProvider(instanceId, config as KiloCodeConfig, ctx);
  },
};
