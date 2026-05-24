import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';
import { parseFindings, REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { readPreviewedStdout } from '../subprocess.ts';
import { GeminiCliConfigSchema, type GeminiCliConfig } from './schema.ts';

const PROVIDER_TYPE = 'gemini-cli';

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

  private args(prompt: string, ctx: ExecCtx): string[] {
    const model = ctx.modelOverride?.model ?? this.cfg.model;
    const args = [
      '--prompt',
      prompt,
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

  private async runOnce(prompt: string, ctx: ExecCtx, reviewerId: string): Promise<string> {
    const cwd = this.cfg.cwd ?? this.pluginCtx.workspaceRoot;
    const proc = Bun.spawn({
      cmd: [this.cfg.binary, ...this.args(prompt, ctx)],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const onAbort = () => proc.kill();
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    if (ctx.signal.aborted) {
      onAbort();
      throw new DOMException('Aborted', 'AbortError');
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, this.cfg.timeout_ms);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readPreviewedStdout(proc.stdout, {
          onToken: (text) => {
            ctx.bus.emit({
              type: 'reviewer.event',
              reviewerId,
              event: { type: 'token', text },
            });
          },
        }),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (timedOut) {
        throw new ProviderRuntimeError(this.id, `gemini timed out after ${this.cfg.timeout_ms}ms`);
      }

      if (exitCode !== 0) {
        throw new ProviderRuntimeError(
          this.id,
          `gemini exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        );
      }
      return stdout.trim();
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const prompt = [
      task.systemPrompt,
      REVIEW_OUTPUT_INSTRUCTIONS,
      task.instruction,
    ].join('\n\n');
    const raw = await this.runOnce(prompt, ctx, task.reviewerId);
    const findings = parseFindings(raw, task.reviewerId);

    for (const finding of findings) {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: task.reviewerId,
        event: { type: 'finding', finding },
      });
    }

    return {
      taskId: task.id,
      reviewerId: task.reviewerId,
      findings,
      rawOutput: raw,
      durationMs: Date.now() - started,
    };
  }
}

export const geminiCliFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: GeminiCliConfigSchema,
  async create(instanceId, config, ctx) {
    return new GeminiCliProvider(instanceId, config as GeminiCliConfig, ctx);
  },
};
