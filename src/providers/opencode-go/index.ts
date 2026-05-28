import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult, normaliseSubprocessOutput } from '../subprocess.ts';
import { OpenCodeGoConfigSchema, type OpenCodeGoConfig } from './schema.ts';

const PROVIDER_TYPE = 'opencode-go';
const STDIN_PROMPT = 'Read the review instructions from stdin and return only the requested output.';

class OpenCodeGoProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: OpenCodeGoConfig,
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
    const args =
      this.cfg.command_style === 'run'
        ? ['run', ...this.cfg.extra_args]
        : ['-p', STDIN_PROMPT, ...this.cfg.extra_args];

    if (this.cfg.command_style === 'run') {
      if (model) args.push('--model', model);
      if (this.cfg.output_format === 'json') args.push('--format', 'json');
      if (this.cfg.quiet) args.push('--log-level', 'ERROR');
      args.push(STDIN_PROMPT);
      return args;
    }

    if (model) args.push('--model', model);
    if (this.cfg.output_format === 'json') args.push('-f', 'json');
    if (this.cfg.quiet) args.push('-q');
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'opencode',
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

export const openCodeGoFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: OpenCodeGoConfigSchema,
  async create(instanceId, config, ctx) {
    return new OpenCodeGoProvider(instanceId, config as OpenCodeGoConfig, ctx);
  },
};
