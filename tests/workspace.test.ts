import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { probeWorkspace } from '../src/runtime/workspace.ts';

describe('probeWorkspace', () => {
  test('returns no diff for a clean repository', async () => {
    const repo = await makeRepo('main');
    await writeFile(join(repo, 'a.txt'), 'hello\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-m', 'initial']);

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.baseRef).toBe('main');
    expect(workspace.diff).toBeUndefined();
    expect(workspace.files).toEqual([]);
  });

  test('falls back to working tree diff when no default base ref exists', async () => {
    const repo = await makeRepo('feature');
    await writeFile(join(repo, 'a.txt'), 'hello\n');
    await git(repo, ['add', 'a.txt']);
    await git(repo, ['commit', '-m', 'initial']);
    await writeFile(join(repo, 'a.txt'), 'hello\nchanged\n');

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.baseRef).toBeUndefined();
    expect(workspace.diff).toContain('changed');
    expect(workspace.files).toEqual(['a.txt']);
  });

  test('includes staged and unstaged changes when a base ref exists', async () => {
    const repo = await makeRepo('main');
    await writeFile(join(repo, 'staged.txt'), 'before\n');
    await writeFile(join(repo, 'worktree.txt'), 'before\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);

    await writeFile(join(repo, 'staged.txt'), 'before\nstaged\n');
    await git(repo, ['add', 'staged.txt']);
    await writeFile(join(repo, 'worktree.txt'), 'before\nworktree\n');

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.baseRef).toBe('main');
    expect(workspace.diff).toContain('staged');
    expect(workspace.diff).toContain('worktree');
    expect(workspace.files).toEqual(['staged.txt', 'worktree.txt']);
  });

  test('reports deleted and renamed files from git diff headers', async () => {
    const repo = await makeRepo('main');
    await writeFile(join(repo, 'deleted.txt'), 'delete me\n');
    await writeFile(join(repo, 'old-name.txt'), 'rename me\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);

    await git(repo, ['rm', 'deleted.txt']);
    await git(repo, ['mv', 'old-name.txt', 'new-name.txt']);

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.files).toEqual(['deleted.txt', 'new-name.txt']);
  });
});

async function makeRepo(branch: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'quorum-workspace-test-'));
  await git(repo, ['init', '-b', branch]);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test User']);
  return repo;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  }
  return stdout;
}
