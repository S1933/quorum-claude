import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { probeWorkspace, filterDiffByFiles, enforceDiffBudget, applyDiffLimits, globMatch } from '../src/runtime/workspace.ts';
import { DiffBudgetError } from '../src/core/errors.ts';
import type { WorkspaceInfo } from '../src/core/task.ts';

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

  test('includes text untracked files in the review diff', async () => {
    const repo = await makeRepo('main');
    await writeFile(join(repo, 'tracked.txt'), 'hello\n');
    await git(repo, ['add', 'tracked.txt']);
    await git(repo, ['commit', '-m', 'initial']);
    await writeFile(join(repo, 'new-file.ts'), 'export const value = 1;\n');

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.diff).toContain('diff --git a/new-file.ts b/new-file.ts');
    expect(workspace.diff).toContain('+export const value = 1;');
    expect(workspace.files).toEqual(['new-file.ts']);
  });

  test('lists binary untracked files without inlining their bytes', async () => {
    const repo = await makeRepo('main');
    await writeFile(join(repo, 'tracked.txt'), 'hello\n');
    await git(repo, ['add', 'tracked.txt']);
    await git(repo, ['commit', '-m', 'initial']);
    await writeFile(join(repo, 'image.bin'), new Uint8Array([0, 1, 2, 3]));

    const workspace = await probeWorkspace({ root: repo });

    expect(workspace.diff).toContain('diff --git a/image.bin b/image.bin');
    expect(workspace.diff).toContain('+(skipped: binary file)');
    expect(workspace.files).toEqual(['image.bin']);
  });
});

const MULTI_FILE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1 +1,2 @@',
  '+const x = 1;',
  'diff --git a/tests/app.test.ts b/tests/app.test.ts',
  '--- a/tests/app.test.ts',
  '+++ b/tests/app.test.ts',
  '@@ -1 +1,2 @@',
  '+test("a", () => {});',
  'diff --git a/README.md b/README.md',
  '--- a/README.md',
  '+++ b/README.md',
  '@@ -1 +1,2 @@',
  '+# Hello',
].join('\n');

function makeWorkspace(diff: string, files: string[]): WorkspaceInfo {
  return { root: '/repo', diff, files };
}

describe('globMatch', () => {
  test('matches simple extension globs', () => {
    expect(globMatch('*.ts', 'app.ts')).toBe(true);
    expect(globMatch('*.ts', 'app.js')).toBe(false);
  });

  test('single * does not match path separators', () => {
    expect(globMatch('*.ts', 'src/app.ts')).toBe(false);
  });

  test('** matches across directories', () => {
    expect(globMatch('**/*.ts', 'src/app.ts')).toBe(true);
    expect(globMatch('**/*.ts', 'src/deep/app.ts')).toBe(true);
    expect(globMatch('**/*.ts', 'app.ts')).toBe(true);
  });

  test('directory prefix patterns', () => {
    expect(globMatch('src/**', 'src/app.ts')).toBe(true);
    expect(globMatch('src/**', 'tests/app.ts')).toBe(false);
  });

  test('matches exact paths', () => {
    expect(globMatch('src/app.ts', 'src/app.ts')).toBe(true);
    expect(globMatch('src/app.ts', 'src/other.ts')).toBe(false);
  });

  test('? matches single non-separator character', () => {
    expect(globMatch('?.ts', 'a.ts')).toBe(true);
    expect(globMatch('?.ts', 'ab.ts')).toBe(false);
  });
});

describe('filterDiffByFiles', () => {
  test('returns workspace unchanged when no filters provided', () => {
    const ws = makeWorkspace(MULTI_FILE_DIFF, ['src/app.ts', 'tests/app.test.ts', 'README.md']);
    const result = filterDiffByFiles(ws);
    expect(result).toBe(ws);
  });

  test('includeFiles keeps only matching files', () => {
    const ws = makeWorkspace(MULTI_FILE_DIFF, ['src/app.ts', 'tests/app.test.ts', 'README.md']);
    const result = filterDiffByFiles(ws, ['**/*.ts']);
    expect(result.files).toEqual(['src/app.ts', 'tests/app.test.ts']);
    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).toContain('tests/app.test.ts');
    expect(result.diff).not.toContain('README.md');
  });

  test('excludeFiles removes matching files', () => {
    const ws = makeWorkspace(MULTI_FILE_DIFF, ['src/app.ts', 'tests/app.test.ts', 'README.md']);
    const result = filterDiffByFiles(ws, undefined, ['**/*.test.ts']);
    expect(result.files).toEqual(['src/app.ts', 'README.md']);
    expect(result.diff).not.toContain('tests/app.test.ts');
    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).toContain('README.md');
  });

  test('include and exclude combine correctly', () => {
    const ws = makeWorkspace(MULTI_FILE_DIFF, ['src/app.ts', 'tests/app.test.ts', 'README.md']);
    const result = filterDiffByFiles(ws, ['**/*.ts'], ['**/*.test.ts']);
    expect(result.files).toEqual(['src/app.ts']);
    expect(result.diff).toContain('src/app.ts');
    expect(result.diff).not.toContain('tests/app.test.ts');
    expect(result.diff).not.toContain('README.md');
  });

  test('returns undefined diff when all files are excluded', () => {
    const ws = makeWorkspace(MULTI_FILE_DIFF, ['src/app.ts', 'tests/app.test.ts', 'README.md']);
    const result = filterDiffByFiles(ws, ['**/*.py']);
    expect(result.diff).toBeUndefined();
    expect(result.files).toEqual([]);
  });

  test('passes through workspace with no diff unchanged', () => {
    const ws: WorkspaceInfo = { root: '/repo', files: [] };
    const result = filterDiffByFiles(ws, ['**/*.ts']);
    expect(result.diff).toBeUndefined();
  });
});

describe('enforceDiffBudget', () => {
  test('does not throw when diff is within budget', () => {
    expect(() => enforceDiffBudget('short diff', 1024, ['a.ts'])).not.toThrow();
  });

  test('throws DiffBudgetError when diff exceeds budget', () => {
    const diff = 'x'.repeat(2000);
    expect(() => enforceDiffBudget(diff, 1024, ['a.ts', 'b.ts'])).toThrow(DiffBudgetError);
  });

  test('error message includes size, budget, and file count', () => {
    const diff = 'x'.repeat(2000);
    try {
      enforceDiffBudget(diff, 1024, ['a.ts', 'b.ts']);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(DiffBudgetError);
      const e = err as DiffBudgetError;
      expect(e.actualBytes).toBe(2000);
      expect(e.maxBytes).toBe(1024);
      expect(e.fileCount).toBe(2);
      expect(e.message).toContain('2 files');
      expect(e.message).toContain('budget');
    }
  });

  test('measures bytes not characters for multibyte content', () => {
    const diff = '🔴'.repeat(300);
    const byteLen = Buffer.byteLength(diff, 'utf8');
    expect(() => enforceDiffBudget(diff, byteLen, [])).not.toThrow();
    expect(() => enforceDiffBudget(diff, byteLen - 1, [])).toThrow(DiffBudgetError);
  });
});

describe('applyDiffLimits', () => {
  test('filters files before checking budget', () => {
    const bigSection = 'x'.repeat(2000);
    const diff = [
      'diff --git a/small.ts b/small.ts',
      '+ok',
      `diff --git a/big.txt b/big.txt`,
      `+${bigSection}`,
    ].join('\n');
    const ws = makeWorkspace(diff, ['small.ts', 'big.txt']);
    const result = applyDiffLimits(ws, {
      includeFiles: ['**/*.ts'],
      maxDiffBytes: 1024,
    });
    expect(result.files).toEqual(['small.ts']);
    expect(result.diff).toContain('small.ts');
    expect(result.diff).not.toContain('big.txt');
  });

  test('throws budget error after filtering if still too large', () => {
    const ws = makeWorkspace('x'.repeat(2000), ['a.ts']);
    expect(() => applyDiffLimits(ws, { maxDiffBytes: 100 })).toThrow(DiffBudgetError);
  });

  test('passes through when no limits are set', () => {
    const ws = makeWorkspace('diff content', ['a.ts']);
    const result = applyDiffLimits(ws, {});
    expect(result).toBe(ws);
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
