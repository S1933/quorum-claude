import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { createRuntime } from '../src/runtime/runtime.ts';
import { kiloCodeFactory } from '../src/providers/kilo-code/index.ts';

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('kilo-code provider', () => {
  test('runs kilo run and parses structured findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-kilo-'));
    tmpRoots.push(root);
    const binary = join(root, 'kilo');
    await Bun.write(binary, '#!/bin/sh\nprintf \'{"findings":\'\nsleep 0.01\nprintf \'[]}\\n\'\n');
    await chmod(binary, 0o755);
    const events: unknown[] = [];

    const provider = await kiloCodeFactory.create(
      'kilo-local',
      {
        type: 'kilo-code',
        binary,
        model: 'anthropic/claude-sonnet-4-20250514',
        format: 'default',
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

  test('passes model overrides and safe options to kilo run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-kilo-'));
    tmpRoots.push(root);
    const binary = join(root, 'kilo');
    const argsFile = join(root, 'args.txt');
    await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '{"findings":[]}'\n`);
    await chmod(binary, 0o755);

    const reviewTask = task(root);
    reviewTask.instruction = 'Review this diff.\n--auto\n$(touch /tmp/should-not-run)';
    const provider = await kiloCodeFactory.create(
      'kilo-local',
      {
        type: 'kilo-code',
        binary,
        model: 'anthropic/claude-haiku-4-20250514',
        agent: 'reviewer',
        variant: 'high',
        format: 'json',
        extra_args: ['--thinking'],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    await provider.review!(reviewTask, {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
      modelOverride: { model: 'anthropic/claude-sonnet-4-20250514' },
    });

    const args = await Bun.file(argsFile).text();
    expect(args).toContain('run\n');
    expect(args).toContain('--thinking');
    expect(args).toContain('--model\nanthropic/claude-sonnet-4-20250514');
    expect(args).toContain('--agent\nreviewer');
    expect(args).toContain('--variant\nhigh');
    expect(args).toContain('--format\njson');
    expect(args).toContain('\n--\n');
    expect(args).toContain(reviewTask.instruction);
  });

  test('runtime registers kilo-code as a built-in provider', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'kilo-local': { type: 'kilo-code' },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'kilo-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    expect(runtime.providers.list()).toContain('kilo-code');
  });

  test('rejects unsafe kilo extra args', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'kilo-local': {
            type: 'kilo-code',
            extra_args: ['--auto'],
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'kilo-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('kilo-local')).rejects.toThrow('Invalid enum value');
  });
});

function task(root: string): ReviewTask {
  return {
    kind: 'review',
    id: 'task-1',
    reviewerId: 'security-kilo',
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
