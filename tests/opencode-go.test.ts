import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { createRuntime } from '../src/runtime/runtime.ts';
import { openCodeGoFactory } from '../src/providers/opencode-go/index.ts';

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('opencode-go provider', () => {
  test('runs the prompt-style CLI and parses structured findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-opencode-'));
    tmpRoots.push(root);
    const binary = join(root, 'opencode');
    await Bun.write(binary, '#!/bin/sh\nprintf \'{"findings":\'\nsleep 0.01\nprintf \'[]}\'\n');
    await chmod(binary, 0o755);
    const events: unknown[] = [];
    const bus = captureBus(events);

    const provider = await openCodeGoFactory.create(
      'opencode-local',
      {
        type: 'opencode-go',
        binary,
        command_style: 'prompt',
        output_format: 'text',
        quiet: true,
        extra_args: [],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    const task: ReviewTask = {
      kind: 'review',
      id: 'task-1',
      reviewerId: 'security-open',
      systemPrompt: 'Review security issues.',
      instruction: 'Review this diff.',
      workspace: { root },
    };

    const result = await provider.review!(task, {
      bus,
      signal: new AbortController().signal,
      workspace: { root },
    });

    expect(result.findings).toEqual([]);
    expect(result.rawOutput).toBe('{"findings":[]}');
    expect(tokenText(events)).toBe('{"findings":[]}');
  });

  test('passes model overrides to the prompt-style CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-opencode-'));
    tmpRoots.push(root);
    const binary = join(root, 'opencode');
    const argsFile = join(root, 'args.txt');
    const stdinFile = join(root, 'stdin.txt');
    await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${stdinFile}'\nprintf '{"findings":[]}'\n`);
    await chmod(binary, 0o755);

    const provider = await openCodeGoFactory.create(
      'opencode-local',
      {
        type: 'opencode-go',
        binary,
        command_style: 'prompt',
        output_format: 'text',
        quiet: true,
        extra_args: [],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    const task: ReviewTask = {
      kind: 'review',
      id: 'task-1',
      reviewerId: 'security-open',
      systemPrompt: 'Review security issues.',
      instruction: 'Review this diff.\n--dangerous\n$(touch /tmp/should-not-run)',
      workspace: { root },
    };

    await provider.review!(task, {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
      modelOverride: { model: 'anthropic/claude-sonnet-4' },
    });

    const args = await Bun.file(argsFile).text();
    const stdin = await Bun.file(stdinFile).text();
    expect(args).toContain('--model\nanthropic/claude-sonnet-4');
    expect(args).not.toContain(task.instruction);
    expect(stdin).toContain(task.instruction);
  });

  test('reports timeout errors distinctly from process failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-opencode-'));
    tmpRoots.push(root);
    const binary = join(root, 'opencode');
    await Bun.write(binary, '#!/bin/sh\nsleep 1\nprintf \'{"findings":[]}\'\n');
    await chmod(binary, 0o755);

    const provider = await openCodeGoFactory.create(
      'opencode-local',
      {
        type: 'opencode-go',
        binary,
        command_style: 'prompt',
        output_format: 'text',
        quiet: true,
        extra_args: [],
        timeout_ms: 10,
      },
      { workspaceRoot: root, env: {} },
    );

    const task: ReviewTask = {
      kind: 'review',
      id: 'task-1',
      reviewerId: 'security-open',
      systemPrompt: 'Review security issues.',
      instruction: 'Review this diff.',
      workspace: { root },
    };

    await expect(provider.review!(task, {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
    })).rejects.toThrow('opencode timed out after 10ms');
  });

  test('rejects unsafe opencode extra args', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'opencode-local': {
            type: 'opencode-go',
            extra_args: ['--trust-all'],
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'opencode-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('opencode-local')).rejects.toThrow('extra_args.0');
  });
});

function captureBus(events: unknown[] = []): EventBus {
  return {
    emit(e) {
      events.push(e);
    },
    on() {
      return () => {};
    },
    onAny() {
      return () => {};
    },
  };
}

function tokenText(events: unknown[]): string {
  return events
    .map((event) => event as { event?: { type?: string; text?: string } })
    .filter((event) => event.event?.type === 'token')
    .map((event) => event.event?.text ?? '')
    .join('');
}
