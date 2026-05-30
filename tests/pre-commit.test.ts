import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { describe, expect, test } from 'bun:test';
import { main, type CliDeps } from '../src/cli/index.ts';

describe('pre-commit', () => {
  test('true installs hook script in .git/hooks/pre-commit', async () => {
    const io = captureIo();
    const repo = await mkdtemp(join('/tmp', 'quorum-precommit-'));

    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });

    const code = await main(
      ['pre-commit', 'true'],
      baseDeps({ inferRepoRoot: async () => repo }),
      io,
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(`pre-commit hook installed: ${join(repo, '.git', 'hooks', 'pre-commit')}`);

    const hookContent = await Bun.file(join(repo, '.git', 'hooks', 'pre-commit')).text();
    expect(hookContent).toContain('$CMD review --json');
    expect(hookContent).toContain('QUORUM_BYPASS');
    expect(hookContent).toContain('high/critical findings');
  });

  test('false removes the hook script', async () => {
    const io = captureIo();
    const repo = await mkdtemp(join('/tmp', 'quorum-precommit-'));

    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await Bun.write(join(repo, '.git', 'hooks', 'pre-commit'), 'echo old');

    const code = await main(
      ['pre-commit', 'false'],
      baseDeps({ inferRepoRoot: async () => repo }),
      io,
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(`pre-commit hook removed: ${join(repo, '.git', 'hooks', 'pre-commit')}`);
    expect(await Bun.file(join(repo, '.git', 'hooks', 'pre-commit')).exists()).toBe(false);
  });

  test('false on missing hook reports not found', async () => {
    const io = captureIo();
    const repo = await mkdtemp(join('/tmp', 'quorum-precommit-'));

    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });

    const code = await main(
      ['pre-commit', 'false'],
      baseDeps({ inferRepoRoot: async () => repo }),
      io,
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain('no pre-commit hook found');
  });

  test('missing argument shows usage', async () => {
    const io = captureIo();

    const code = await main(
      ['pre-commit'],
      baseDeps({}),
      io,
    );

    expect(code).toBe(2);
    expect(io.stderrText()).toContain('Usage: quorum pre-commit true|false');
  });

  test('invalid argument shows usage', async () => {
    const io = captureIo();

    const code = await main(
      ['pre-commit', 'maybe'],
      baseDeps({}),
      io,
    );

    expect(code).toBe(2);
    expect(io.stderrText()).toContain('Usage: quorum pre-commit true|false');
  });
});

function baseDeps(overrides: Partial<CliDeps>): CliDeps {
  return {
    loadConfigFromPath: async () => ({ version: 1, providers: {}, personas: {}, reviewers: {}, pipelines: {} }),
    findConfigPath: () => '/repo/quorum.yaml',
    inferRepoRoot: async () => '/repo',
    probeWorkspace: async () => ({ root: '/repo' }),
    createRuntime: async () => ({}) as ReturnType<CliDeps['createRuntime']>,
    now: () => 1,
    ...overrides,
  };
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write(chunk: unknown) { stdout += String(chunk); } },
    stderr: { write(chunk: unknown) { stderr += String(chunk); } },
    stdoutText() { return stdout; },
    stderrText() { return stderr; },
  };
}