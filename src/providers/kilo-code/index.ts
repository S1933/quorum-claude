import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';
import { parseFindings, REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';
import { readPreviewedStdout } from '../subprocess.ts';
import { KiloCodeConfigSchema, type KiloCodeConfig } from './schema.ts';

const PROVIDER_TYPE = 'kilo-code';

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

  private args(prompt: string, ctx: ExecCtx): string[] {
    const model = ctx.modelOverride?.model ?? this.cfg.model;
    const args = ['run', ...this.cfg.extra_args];

    if (model) args.push('--model', model);
    if (this.cfg.agent) args.push('--agent', this.cfg.agent);
    if (this.cfg.variant) args.push('--variant', this.cfg.variant);
    if (this.cfg.format === 'json') args.push('--format', 'json');
    args.push('--', prompt);
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
    if (ctx.signal.aborted) {
      proc.kill();
      throw new DOMException('Aborted', 'AbortError');
    }
    ctx.signal.addEventListener('abort', onAbort, { once: true });

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
        throw new ProviderRuntimeError(this.id, `kilo timed out after ${this.cfg.timeout_ms}ms`);
      }

      if (exitCode !== 0) {
        throw new ProviderRuntimeError(
          this.id,
          `kilo exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        );
      }
      return normaliseKiloOutput(stdout);
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

function normaliseKiloOutput(raw: string): string {
  const text = raw.trim();
  if (!text) return text;

  const direct = parseJson(text);
  if (direct) return unwrapJsonOutput(direct) ?? text;

  const chunks = text
    .split('\n')
    .map((line) => parseJson(line))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map(unwrapJsonOutput)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return chunks.length > 0 ? chunks.join('\n') : text;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function unwrapJsonOutput(value: Record<string, unknown>): string | null {
  if (Array.isArray(value.findings)) return JSON.stringify(value);

  for (const key of ['output', 'response', 'text', 'content', 'message']) {
    const candidate = value[key];
    if (typeof candidate === 'string') return candidate;
  }

  const message = value.message;
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
  }

  return null;
}

export const kiloCodeFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: KiloCodeConfigSchema,
  async create(instanceId, config, ctx) {
    return new KiloCodeProvider(instanceId, config as KiloCodeConfig, ctx);
  },
};
