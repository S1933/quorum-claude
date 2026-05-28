import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult, normaliseSubprocessOutput } from '../subprocess.ts';
import { ContinueDevConfigSchema, type ContinueDevConfig } from './schema.ts';

const PROVIDER_TYPE = 'continue-dev';
const STDIN_PROMPT = 'Read the review instructions from stdin and return only the requested output.';

class ContinueDevProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: ContinueDevConfig,
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

  private buildArgs(): string[] {
    const args = ['-p', STDIN_PROMPT, ...this.cfg.extra_args];
    if (this.cfg.silent && !args.includes('--silent')) args.push('--silent');
    if (this.cfg.format === 'json') args.push('--format', 'json');
    if (this.cfg.config) args.push('--config', this.cfg.config);
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'continue.dev',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args: this.buildArgs(),
      cwd: this.cfg.cwd ?? this.pluginCtx.workspaceRoot,
      stdin: prompt,
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    return buildSubprocessReviewResult(task, normaliseSubprocessOutput(raw), started, ctx.bus);
  }
}

export const continueDevFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: ContinueDevConfigSchema,
  async create(instanceId, config, ctx) {
    return new ContinueDevProvider(instanceId, config as ContinueDevConfig, ctx);
  },
};
