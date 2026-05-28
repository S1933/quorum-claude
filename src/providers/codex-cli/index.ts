import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult } from '../subprocess.ts';
import { CodexCliConfigSchema, type CodexCliConfig } from './schema.ts';

const PROVIDER_TYPE = 'codex-cli';

class CodexCliProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: CodexCliConfig,
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

  private buildArgs(ctx: ExecCtx, cwd: string): string[] {
    const model = ctx.modelOverride?.model ?? this.cfg.model;
    const args = [
      'exec',
      '--sandbox',
      this.cfg.sandbox,
      '--color',
      'never',
      '-C',
      cwd,
      ...this.cfg.extra_args,
    ];

    if (this.cfg.approval_policy === 'never') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }

    if (model) args.push('--model', model);
    args.push('-');
    return args;
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const cwd = this.cfg.cwd ?? this.pluginCtx.workspaceRoot;
    const prompt = [task.systemPrompt, REVIEW_OUTPUT_INSTRUCTIONS, task.instruction].join('\n\n');

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'codex',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args: this.buildArgs(ctx, cwd),
      cwd,
      stdin: prompt,
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    return buildSubprocessReviewResult(task, raw.trim(), started, ctx.bus);
  }
}

export const codexCliFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: CodexCliConfigSchema,
  async create(instanceId, config, ctx) {
    return new CodexCliProvider(instanceId, config as CodexCliConfig, ctx);
  },
};
