import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceInfo } from '../core/task.ts';
import { ProviderRuntimeError, DiffBudgetError } from '../core/errors.ts';

export interface WorkspaceProbeOptions {
  root: string;
  baseRef?: string;
}

const MAX_UNTRACKED_BYTES = 24 * 1024;

export async function probeWorkspace(opts: WorkspaceProbeOptions): Promise<WorkspaceInfo> {
  const { root } = opts;
  const baseRef = opts.baseRef ?? (await defaultBaseRef(root));
  const diff = await gitDiff(root, baseRef);
  const untrackedDiff = await gitUntrackedDiff(root);
  const combinedDiff = [diff, untrackedDiff].filter(Boolean).join('\n\n') || undefined;
  const files = parseDiffFiles(combinedDiff);
  const ws: WorkspaceInfo = { root, files };
  if (baseRef) ws.baseRef = baseRef;
  if (combinedDiff) ws.diff = combinedDiff;
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
    const mergeBase = await getMergeBase(root, baseRef);
    if (!mergeBase) return undefined;
    const branchDiff = await runGitDiff(root, ['diff', mergeBase]);
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

async function getMergeBase(root: string, baseRef: string): Promise<string | undefined> {
  const proc = Bun.spawn({
    cmd: ['git', 'merge-base', baseRef, 'HEAD'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? out.trim() : undefined;
}

async function runGitDiff(root: string, args: string[]): Promise<string | null> {
  return runGit(root, args);
}

async function runGit(root: string, args: string[]): Promise<string | null> {
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

async function gitUntrackedDiff(root: string): Promise<string | undefined> {
  const out = await runGit(root, ['ls-files', '--others', '--exclude-standard']);
  if (out === null || !out.trim()) return undefined;

  const chunks: string[] = [];
  for (const file of out.split('\n').map((line) => line.trim()).filter(Boolean)) {
    chunks.push(await formatUntrackedFile(root, file));
  }
  return chunks.length > 0 ? chunks.join('\n\n') : undefined;
}

async function formatUntrackedFile(root: string, file: string): Promise<string> {
  const header = [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`];
  const absolute = join(root, file);

  try {
    const info = await stat(absolute);
    if (!info.isFile()) return [...header, `@@ -0,0 +1 @@`, `+(skipped: not a regular file)`].join('\n');
    if (info.size > MAX_UNTRACKED_BYTES) {
      return [...header, '@@ -0,0 +1 @@', `+(skipped: ${info.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`].join('\n');
    }

    const data = await readFile(absolute);
    if (!isProbablyText(data)) {
      return [...header, '@@ -0,0 +1 @@', '+(skipped: binary file)'].join('\n');
    }

    const text = data.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const lineCount = text.length === 0 ? 0 : lines.length;
    return [...header, `@@ -0,0 +1,${lineCount} @@`, ...lines.map((line) => `+${line}`)].join('\n');
  } catch {
    return [...header, '@@ -0,0 +1 @@', '+(skipped: unreadable file)'].join('\n');
  }
}

function isProbablyText(data: Uint8Array): boolean {
  if (data.length === 0) return true;
  return !data.includes(0);
}

export interface DiffLimits {
  maxDiffBytes?: number;
  includeFiles?: string[];
  excludeFiles?: string[];
}

export function applyDiffLimits(workspace: WorkspaceInfo, limits: DiffLimits): WorkspaceInfo {
  let ws = workspace;
  if (limits.includeFiles?.length || limits.excludeFiles?.length) {
    ws = filterDiffByFiles(ws, limits.includeFiles, limits.excludeFiles);
  }
  if (limits.maxDiffBytes !== undefined && ws.diff) {
    enforceDiffBudget(ws.diff, limits.maxDiffBytes, ws.files ?? []);
  }
  return ws;
}

export function filterDiffByFiles(
  workspace: WorkspaceInfo,
  include?: string[],
  exclude?: string[],
): WorkspaceInfo {
  if (!workspace.diff) return workspace;
  if (!include?.length && !exclude?.length) return workspace;

  const sections = splitDiffSections(workspace.diff);
  const kept = sections.filter(({ file }) => {
    if (include?.length && !include.some((p) => globMatch(p, file))) return false;
    if (exclude?.length && exclude.some((p) => globMatch(p, file))) return false;
    return true;
  });

  const joined = kept.map((s) => s.raw).join('\n');
  const files = kept.map((s) => s.file);
  const { diff: _stripped, ...rest } = workspace;
  const out: WorkspaceInfo = { ...rest, files };
  if (joined) out.diff = joined;
  return out;
}

export function enforceDiffBudget(diff: string, maxBytes: number, files: string[]): void {
  const actual = Buffer.byteLength(diff, 'utf8');
  if (actual > maxBytes) {
    throw new DiffBudgetError(actual, maxBytes, files.length);
  }
}

interface DiffSection {
  file: string;
  raw: string;
}

function splitDiffSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const headerRe = /^diff --git a\/(.+) b\/(.+)$/;
  const lines = diff.split('\n');
  let current: { file: string; startIdx: number } | undefined;

  for (let i = 0; i < lines.length; i++) {
    const m = headerRe.exec(lines[i]!);
    if (m) {
      if (current) {
        sections.push({ file: current.file, raw: lines.slice(current.startIdx, i).join('\n') });
      }
      current = { file: m[2]!, startIdx: i };
    }
  }
  if (current) {
    sections.push({ file: current.file, raw: lines.slice(current.startIdx).join('\n') });
  }
  return sections;
}

export function globMatch(pattern: string, path: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  let src = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*' && pattern[i + 1] === '*') {
      src += pattern[i + 2] === '/' ? '(?:.+/)?' : '.*';
      i += pattern[i + 2] === '/' ? 3 : 2;
    } else if (ch === '*') {
      src += '[^/]*';
      i++;
    } else if (ch === '?') {
      src += '[^/]';
      i++;
    } else {
      src += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${src}$`);
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
