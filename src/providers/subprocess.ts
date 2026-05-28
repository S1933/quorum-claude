import type { EventBus } from '../core/events.ts';
import type { ReviewTask, ReviewResult } from '../core/task.ts';
import { ProviderRuntimeError } from '../core/errors.ts';
import { parseFindings } from '../reviewers/output.ts';

export interface SubprocessRunOptions {
  providerId: string;
  providerLabel: string;
  reviewerId: string;
  binary: string;
  args: string[];
  cwd: string;
  stdin: string;
  env?: Record<string, string | undefined>;
  timeoutMs: number;
  signal: AbortSignal;
  bus: EventBus;
}

export async function runSubprocess(opts: SubprocessRunOptions): Promise<string> {
  const proc = Bun.spawn({
    cmd: [opts.binary, ...opts.args],
    cwd: opts.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    ...(opts.env ? { env: opts.env } : {}),
  });

  const writer = proc.stdin as unknown as { write: (s: string) => void; end: () => void };
  writer.write(opts.stdin);
  writer.end();

  const onAbort = () => proc.kill();
  if (opts.signal.aborted) {
    proc.kill();
    throw new DOMException('Aborted', 'AbortError');
  }
  opts.signal.addEventListener('abort', onAbort, { once: true });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readPreviewedStdout(proc.stdout, {
        onToken: (text) => {
          opts.bus.emit({
            type: 'reviewer.event',
            reviewerId: opts.reviewerId,
            event: { type: 'token', text },
          });
        },
      }),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (timedOut) {
      throw new ProviderRuntimeError(
        opts.providerId,
        `${opts.providerLabel} timed out after ${opts.timeoutMs}ms`,
      );
    }

    if (exitCode !== 0) {
      throw new ProviderRuntimeError(
        opts.providerId,
        `${opts.providerLabel} exited with code ${exitCode}: ${stderr.slice(0, 500)}`,
      );
    }
    return stdout;
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

export function buildSubprocessReviewResult(
  task: ReviewTask,
  raw: string,
  started: number,
  bus: EventBus,
): ReviewResult {
  const findings = parseFindings(raw, task.reviewerId);
  for (const finding of findings) {
    bus.emit({
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

const DEFAULT_UNWRAP_KEYS = ['output', 'response', 'text', 'content', 'message'];

export function normaliseSubprocessOutput(raw: string, unwrapKeys: string[] = DEFAULT_UNWRAP_KEYS): string {
  const text = raw.trim();
  if (!text) return text;

  const direct = parseJsonObject(text);
  if (direct) return unwrapJsonOutput(direct, unwrapKeys) ?? text;

  const chunks = text
    .split('\n')
    .map((line) => parseJsonObject(line))
    .filter((value): value is Record<string, unknown> => value !== null)
    .map((value) => unwrapJsonOutput(value, unwrapKeys))
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  return chunks.length > 0 ? chunks.join('\n') : text;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function unwrapJsonOutput(value: Record<string, unknown>, keys: string[]): string | null {
  if (Array.isArray(value.findings)) return JSON.stringify(value);

  for (const key of keys) {
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

export async function readPreviewedStdout(
  stream: ReadableStream<Uint8Array>,
  opts: { onToken(text: string): void },
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    chunks.push(chunk);
    opts.onToken(chunk);
  }

  const tail = decoder.decode();
  if (tail) chunks.push(tail);
  return chunks.join('');
}
