import { readdir, symlink, stat, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CliDeps, CliIo } from '../types.ts';

function isEntryExists(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object'
    && 'code' in err
    && (err as { code: string }).code === 'EEXIST',
  );
}

interface SetupPaths {
  root: string;
  home: string;
}

async function installSkills(io: CliIo, paths?: SetupPaths): Promise<number> {
  const root = paths?.root ?? resolve(import.meta.dir, '..', '..', '..');
  const home = paths?.home ?? homedir();

  const skillsSource = join(root, 'skills');
  const skillsTarget = join(home, '.agents', 'skills');

  let sourceStat;
  try {
    sourceStat = await stat(skillsSource);
  } catch {
    io.stderr.write(`skills directory not found: ${skillsSource}\n`);
    return 0;
  }

  if (!sourceStat.isDirectory()) {
    io.stderr.write(`skills path is not a directory: ${skillsSource}\n`);
    return 0;
  }

  await mkdir(skillsTarget, { recursive: true });

  const entries = await readdir(skillsSource, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = join(skillsSource, entry.name);
    const skillFile = join(skillDir, 'SKILL.md');
    try {
      await stat(skillFile);
    } catch {
      continue;
    }

    const linkPath = join(skillsTarget, `quorum-${entry.name}`);
    try {
      await symlink(skillDir, linkPath);
      io.stdout.write(`symlink ${entry.name} → ${linkPath}\n`);
    } catch (err) {
      if (isEntryExists(err)) {
        io.stdout.write(`exists, skipping: ${linkPath}\n`);
      } else {
        throw err;
      }
    }
  }

  return 0;
}

export async function cmdInstallSkills(
  _positional: string[],
  _flags: Record<string, string | boolean>,
  _deps: CliDeps,
  io: CliIo,
): Promise<number> {
  return installSkills(io);
}