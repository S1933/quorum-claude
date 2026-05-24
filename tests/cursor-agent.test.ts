import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { createRuntime } from '../src/runtime/runtime.ts';
import { cursorAgentFactory } from '../src/providers/cursor-agent/index.ts';

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('cursor-agent provider', () => {
  test('runs cursor-agent print mode and parses structured findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-cursor-'));
    tmpRoots.push(root);
    const binary = join(root, 'cursor-agent');
    await Bun.write(binary, '#!/bin/sh\nprintf \'{"findings":\'\nsleep 0.01\nprintf \'[]}\\n\'\n');
    await chmod(binary, 0o755);
    const events: unknown[] = [];

    const provider = await cursorAgentFactory.create(
      'cursor-local',
      {
        type: 'cursor-agent',
        binary,
        model: 'gpt-5',
        output_format: 'text',
        extra_args: [],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    const result = await provider.review!(task(root), {
      bus: captureBus(events),
      signal: new AbortController().signal,
      workspace: { root },
    });

    expect(result.findings).toEqual([]);
    expect(result.rawOutput).toBe('{"findings":[]}');
    expect(tokenText(events)).toBe('{"findings":[]}\n');
  });

  test('passes model overrides and prompt as one print argument', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-cursor-'));
    tmpRoots.push(root);
    const binary = join(root, 'cursor-agent');
    const argsFile = join(root, 'args.txt');
    const envFile = join(root, 'env.txt');
    await Bun.write(
      binary,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\0' "$arg"; done > '${argsFile}'\nprintf '%s' "$CURSOR_API_KEY" > '${envFile}'\nprintf '{"findings":[]}'\n`,
    );
    await chmod(binary, 0o755);

    const reviewTask = task(root);
    reviewTask.instruction = 'Review this diff.\n--force\n$(touch /tmp/should-not-run)';
    const provider = await cursorAgentFactory.create(
      'cursor-local',
      {
        type: 'cursor-agent',
        binary,
        api_key: 'secret-cursor-key',
        model: 'auto',
        output_format: 'json',
        extra_args: [],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    await provider.review!(reviewTask, {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
      modelOverride: { model: 'gpt-5' },
    });

    const args = (await Bun.file(argsFile).text()).split('\0').filter(Boolean);
    expect(args).toContain('--print');
    expect(args.some((arg) => arg.includes(reviewTask.instruction))).toBe(true);
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5');
    expect(args.filter((arg) => arg === '--force')).toEqual([]);
    expect(await Bun.file(envFile).text()).toBe('secret-cursor-key');
  });

  test('runtime registers cursor-agent as a built-in provider', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'cursor-local': { type: 'cursor-agent' },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'cursor-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    expect(runtime.providers.list()).toContain('cursor-agent');
  });

  test('rejects unsafe cursor extra args', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'cursor-local': {
            type: 'cursor-agent',
            extra_args: ['--force'],
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'cursor-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('cursor-local')).rejects.toThrow();
  });
});

function task(root: string): ReviewTask {
  return {
    kind: 'review',
    id: 'task-1',
    reviewerId: 'security-cursor',
    systemPrompt: 'Review security issues.',
    instruction: 'Review this diff.',
    workspace: { root },
  };
}

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
