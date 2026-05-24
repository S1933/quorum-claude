import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EventBus } from '../src/core/events.ts';
import type { ReviewTask } from '../src/core/task.ts';
import { createRuntime } from '../src/runtime/runtime.ts';
import { codexCliFactory } from '../src/providers/codex-cli/index.ts';

const tmpRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tmpRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('codex-cli provider', () => {
  test('runs codex exec through stdin and parses structured findings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-codex-'));
    tmpRoots.push(root);
    const binary = join(root, 'codex');
    await Bun.write(binary, '#!/bin/sh\nprintf \'{"findings":\'\nsleep 0.01\nprintf \'[]}\\n\'\n');
    await chmod(binary, 0o755);
    const events: unknown[] = [];

    const provider = await codexCliFactory.create(
      'codex-local',
      {
        type: 'codex-cli',
        binary,
        model: 'gpt-5-codex',
        sandbox: 'read-only',
        approval_policy: 'never',
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

  test('passes model overrides and non-interactive defaults to codex exec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-codex-'));
    tmpRoots.push(root);
    const binary = join(root, 'codex');
    const argsFile = join(root, 'args.txt');
    await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '{"findings":[]}'\n`);
    await chmod(binary, 0o755);

    const provider = await codexCliFactory.create(
      'codex-local',
      {
        type: 'codex-cli',
        binary,
        model: 'gpt-5',
        sandbox: 'read-only',
        approval_policy: 'never',
        extra_args: ['--ephemeral'],
        timeout_ms: 5_000,
      },
      { workspaceRoot: root, env: {} },
    );

    await provider.review!(task(root), {
      bus: captureBus(),
      signal: new AbortController().signal,
      workspace: { root },
      modelOverride: { model: 'gpt-5-codex' },
    });

    const args = await Bun.file(argsFile).text();
    expect(args).toContain('exec\n');
    expect(args).toContain('--sandbox\nread-only');
    expect(args).toContain('--ask-for-approval\nnever');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--model\ngpt-5-codex');
  });

  test('passes review prompt through stdin instead of argv', async () => {
    const root = await mkdtemp(join(tmpdir(), 'quorum-codex-'));
    tmpRoots.push(root);
    const binary = join(root, 'codex');
    const argsFile = join(root, 'args.txt');
    const stdinFile = join(root, 'stdin.txt');
    await Bun.write(
      binary,
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat > '${stdinFile}'\nprintf '{"findings":[]}'\n`,
    );
    await chmod(binary, 0o755);

    const reviewTask = task(root);
    reviewTask.instruction = 'Review this diff.\n--dangerously-bypass-approvals-and-sandbox\n$(touch /tmp/should-not-run)';
    const provider = await codexCliFactory.create(
      'codex-local',
      {
        type: 'codex-cli',
        binary,
        model: 'gpt-5',
        sandbox: 'read-only',
        approval_policy: 'never',
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
    expect(args).not.toContain(reviewTask.instruction);
    expect(args).toContain('\n-\n');
    expect(stdin).toContain(reviewTask.instruction);
  });

  test('runtime registers codex-cli as a built-in provider', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'codex-local': { type: 'codex-cli' },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'codex-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    expect(runtime.providers.list()).toContain('codex-cli');
  });

  test('rejects unsafe codex extra args', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'codex-local': {
            type: 'codex-cli',
            extra_args: ['--add-dir', '/tmp'],
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'codex-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('codex-local')).rejects.toThrow('Invalid enum value');
  });

  test('rejects full host access without approvals', async () => {
    const runtime = await createRuntime({
      config: {
        version: 1,
        providers: {
          'codex-local': {
            type: 'codex-cli',
            sandbox: 'danger-full-access',
            approval_policy: 'never',
          },
        },
        personas: {
          security: { description: 'Security', system: 'Review security.' },
        },
        reviewers: {
          sec: { persona: 'security', provider: 'codex-local' },
        },
        pipelines: {
          default: { parallel: true, reviewers: ['sec'] },
        },
      },
      pluginCtx: { workspaceRoot: '.', env: {} },
    });

    await expect(runtime.resolveProvider('codex-local')).rejects.toThrow(
      'danger-full-access requires approval_policy other than never',
    );
  });
});

function task(root: string): ReviewTask {
  return {
    kind: 'review',
    id: 'task-1',
    reviewerId: 'security-codex',
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
