import type { WorkspaceInfo } from '../core/task.ts';
import { ProviderRuntimeError } from '../core/errors.ts';

export interface WorkspaceProbeOptions {
  root: string;
  baseRef?: string;
}

export async function probeWorkspace(opts: WorkspaceProbeOptions): Promise<WorkspaceInfo> {
  const { root } = opts;
  const baseRef = opts.baseRef ?? (await defaultBaseRef(root));
  const diff = await gitDiff(root, baseRef);
  const files = parseDiffFiles(diff);
  const ws: WorkspaceInfo = { root, files };
  if (baseRef) ws.baseRef = baseRef;
  if (diff) ws.diff = diff;
  return ws;
}

async function defaultBaseRef(root: string): Promise<string | undefined> {
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    if (await refExists(root, candidate)) return candidate;
  }
  return undefined;
}

async function refExists(root: string, ref: string): Promise<boolean> {
  const proc = Bun.spawn({
    cmd: ['git', 'rev-parse', '--verify', '--quiet', ref],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  return code === 0;
}

async function gitDiff(root: string, baseRef: string | undefined): Promise<string | undefined> {
  if (baseRef) {
    const branchDiff = await runGitDiff(root, ['diff', baseRef]);
    return branchDiff === null ? undefined : branchDiff || undefined;
  }

  const chunks: string[] = [];
  const stagedDiff = await runGitDiff(root, ['diff', '--cached']);
  if (stagedDiff === null) return undefined;
  if (stagedDiff) chunks.push(stagedDiff);

  const worktreeDiff = await runGitDiff(root, ['diff']);
  if (worktreeDiff === null) return undefined;
  if (worktreeDiff) chunks.push(worktreeDiff);

  return chunks.length > 0 ? chunks.join('\n') : undefined;
}

async function runGitDiff(root: string, args: string[]): Promise<string | null> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return null;
  const trimmed = out.trim();
  return trimmed ? trimmed : '';
}

function parseDiffFiles(diff: string | undefined): string[] {
  if (!diff) return [];
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const git = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (git) {
      files.add(git[2]!);
      continue;
    }
    const added = /^\+\+\+ b\/(.+)$/.exec(line);
    if (added) files.add(added[1]!);
  }
  return [...files];
}

export async function inferRepoRoot(start: string = process.cwd()): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', 'rev-parse', '--show-toplevel'],
    cwd: start,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new ProviderRuntimeError('workspace', `Not inside a git repository (cwd=${start})`);
  }
  return out.trim();
}
