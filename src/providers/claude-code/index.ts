import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { ClaudeCodeConfigSchema, type ClaudeCodeConfig } from './schema.ts';
import { REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { runSubprocess, buildSubprocessReviewResult } from '../subprocess.ts';

const PROVIDER_TYPE = 'claude-code';

class ClaudeCodeProvider implements Provider {
  readonly kind = 'subprocess' as const;

  constructor(
    readonly id: string,
    private readonly cfg: ClaudeCodeConfig,
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

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const system = `${task.systemPrompt}\n\n${REVIEW_OUTPUT_INSTRUCTIONS}`;
    const args = ['--print', '--model', this.cfg.model, ...this.cfg.extra_args, '--append-system-prompt', system];

    const raw = await runSubprocess({
      providerId: this.id,
      providerLabel: 'claude',
      reviewerId: task.reviewerId,
      binary: this.cfg.binary,
      args,
      cwd: this.cfg.cwd ?? this.pluginCtx.workspaceRoot,
      stdin: task.instruction,
      timeoutMs: this.cfg.timeout_ms,
      signal: ctx.signal,
      bus: ctx.bus,
    });

    return buildSubprocessReviewResult(task, raw, started, ctx.bus);
  }
}

export const claudeCodeFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: ClaudeCodeConfigSchema,
  async create(instanceId, config, ctx) {
    return new ClaudeCodeProvider(instanceId, config as ClaudeCodeConfig, ctx);
  },
};
