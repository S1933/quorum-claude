import type { Provider, ProviderCapabilities, ExecCtx } from '../../core/provider.ts';
import type { AgentTask, AgentResult, ReviewTask, ReviewResult } from '../../core/task.ts';
import type { ProviderFactory } from '../registry.ts';
import type { PluginCtx } from '../../runtime/plugin.ts';
import { ProviderRuntimeError } from '../../core/errors.ts';
import { ClaudeCodeConfigSchema, type ClaudeCodeConfig } from './schema.ts';
import { parseFindings, REVIEW_OUTPUT_INSTRUCTIONS } from '../../reviewers/output.ts';

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
      agent: true,
      review: true,
      streaming: false,
      tools: true,
      mcp: true,
      localExecution: true,
      backgroundJobs: false,
      costReporting: false,
    };
  }

  private async runOnce(prompt: string, system: string | null, signal: AbortSignal): Promise<string> {
    const args = ['--print', '--model', this.cfg.model, ...this.cfg.extra_args];
    if (system) args.push('--append-system-prompt', system);

    const cwd = this.cfg.cwd ?? this.pluginCtx.workspaceRoot;

    const proc = Bun.spawn({
      cmd: [this.cfg.binary, ...args],
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const writer = (proc.stdin as unknown as { write: (s: string) => void; end: () => void });
    writer.write(prompt);
    writer.end();

    const onAbort = () => proc.kill();
    if (signal.aborted) {
      proc.kill();
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => proc.kill(), this.cfg.timeout_ms);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      if (exitCode !== 0) {
        throw new ProviderRuntimeError(
          this.id,
          `claude exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
        );
      }
      return stdout;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async execute(task: AgentTask, ctx: ExecCtx): Promise<AgentResult> {
    const output = await this.runOnce(task.instruction, null, ctx.signal);
    return { taskId: task.id, output };
  }

  async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
    const started = Date.now();
    const system = `${task.systemPrompt}\n\n${REVIEW_OUTPUT_INSTRUCTIONS}`;
    const raw = await this.runOnce(task.instruction, system, ctx.signal);
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

export const claudeCodeFactory: ProviderFactory = {
  type: PROVIDER_TYPE,
  schema: ClaudeCodeConfigSchema,
  async create(instanceId, config, ctx) {
    return new ClaudeCodeProvider(instanceId, config as ClaudeCodeConfig, ctx);
  },
};
