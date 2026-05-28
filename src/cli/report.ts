import { mkdir } from 'node:fs/promises';
import { relative, resolve, dirname } from 'node:path';
import { ConfigError } from '../core/errors.ts';
import type { CliDeps } from './types.ts';

export async function writeReport(path: string, content: string): Promise<void> {
  const dir = dirname(resolve(path));
  await mkdir(dir, { recursive: true });
  await Bun.write(path, content);
}

export function resolveConfigPath(
  root: string,
  value: string | boolean | undefined,
  deps: CliDeps,
): string {
  const path = typeof value === 'string' ? value : deps.findConfigPath(root);
  return resolve(root, path);
}

export function assertPathInside(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'))) return;
  throw new ConfigError(`Refusing to write config outside repository: ${path}`);
}
