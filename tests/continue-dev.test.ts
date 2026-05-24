import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { createRuntime } from '../src/runtime/runtime.ts';
import { continueDevFactory } from '../src/providers/continue-dev/index.ts';

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('continue-dev provider', () => {
  test('runs cn headless mode through stdin and parses structured findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-continue-'));
    tmpRoots.push(root);
    const binary = join(root, 'cn');
    await Bun.write(binary, '#!/bin/sh\nprintf \'{"findings":\'\nsleep 0.01\nprintf \'[]}\\n\'\n');
    await chmod(binary, 0o755);
    const events: unknown[] = [];

    const provider = await continueDevFactory.create(
      'continue-local',
      {
        type: 'continue-dev',
        binary,
        config: 'continuedev/default-cli-config',
        silent: true,
        format: 'text',
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

  test('passes safe headless defaults and review prompt through stdin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-continue-'));
    tmpRoots.push(root);
    const binary = join(root, 'cn');
    const argsFile = join(root, 'args.txt');
    const stdinFile = join(root, 'stdin.txt');
    await Bun.write(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${stdinFile}'\nprintf '{"findings":[]}'\n`,
    );
    await chmod(binary, 0o755);

    const reviewTask = task(root);
    reviewTask.instruction = 'Review this diff.\n--allow "*"\n$(touch /tmp/should-not-run)';
    const provider = await continueDevFactory.create(
      'continue-local',
      {
        type: 'continue-dev',
        binary,
        config: 'my-org/review-assistant',
        silent: true,
        format: 'json',
        extra_args: [],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    await provider.review!(reviewTask, {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
    });

    const args = await Bun.file(argsFile).text();
    const stdin = await Bun.file(stdinFile).text();
    expect(args).toContain('-p\n');
    expect(args).not.toContain(reviewTask.instruction);
    expect(args).toContain('--silent');
    expect(args).toContain('--format\njson');
    expect(args).toContain('--config\nmy-org/review-assistant');
    expect(args).not.toContain('--allow');
    expect(stdin).toContain(reviewTask.instruction);
  });

  test('runtime registers continue-dev as a built-in provider', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'continue-local': { type: 'continue-dev' },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'continue-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    expect(runtime.providers.list()).toContain('continue-dev');
  });

  test('rejects unsafe continue extra args', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'continue-local': {
            type: 'continue-dev',
            extra_args: ['--allow'],
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'continue-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('continue-local')).rejects.toThrow('Invalid enum value');
  });
});

function task(root: string): ReviewTask {
  return {
    kind: 'review',
    id: 'task-1',
    reviewerId: 'security-continue',
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
