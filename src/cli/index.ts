#!/usr/bin/env bun
import { loadConfigFromPath, findConfigPath } from '../config/loader.ts';
import { createRuntime as createRuntimeDefault } from '../runtime/runtime.ts';
import { probeWorkspace, inferRepoRoot } from '../runtime/workspace.ts';
import { QuorumError } from '../core/errors.ts';
import { parseArgs } from './args.ts';
import { cmdReview } from './commands/review.ts';
import { cmdConfig } from './commands/config.ts';
import { cmdInstallSkills } from './commands/setup.ts';
import { cmdReviewer } from './commands/reviewer.ts';
import type { CliDeps, CliIo } from './types.ts';

export type { CliDeps, CliIo } from './types.ts';
export { redactConfig } from './commands/config.ts';
export {
  buildSafeFence,
  buildReviewInstruction,
  filterReviewersByChangedFiles,
  resolveDiffLimits,
} from './commands/review.ts';

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

const defaultDeps: CliDeps = {
  loadConfigFromPath,
  findConfigPath,
  inferRepoRoot,
  probeWorkspace,
  createRuntime: createRuntimeDefault,
  now: Date.now,
  initConfigIfMissing: async (configPath, examplePath) => {
    if (await Bun.file(configPath).exists()) return false;
    await Bun.write(configPath, await Bun.file(examplePath).text());
    return true;
  },
  readConfigFile: async (configPath) => await Bun.file(configPath).text(),
  writeConfigFile: async (configPath, content) => await Bun.write(configPath, content),
};

function printHelp(io: CliIo): void {
  io.stdout.write(`quorum — multi-model consensus reviewer

Usage:
  quorum review [pipeline-id] [--pipeline <id>] [--base <ref>] [--config <path>] [--report <path>] [--format text|json] [--json] [--no-color] [--no-preview] [--max-diff-bytes <n>] [--include <glob>] [--exclude <glob>]
  quorum config [--config <path>]
  quorum install-skills
  quorum help

Defaults are read from quorum.yaml in the working directory.
`);
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: CliDeps = defaultDeps,
  io: CliIo = defaultIo,
): Promise<number> {
  const { command, positional, flags } = parseArgs(argv);

  try {
    switch (command) {
      case 'help':
      case '-h':
      case '--help':
        printHelp(io);
        return 0;
      case 'review':
        return await cmdReview(positional, flags, deps, io);
      case 'config':
        return await cmdConfig(flags, deps, io);
      case 'install-skills':
        return await cmdInstallSkills(positional, flags, deps, io);
      case 'reviewer':
        return await cmdReviewer(positional, flags, deps, io);
      default:
        io.stderr.write(`Unknown command: ${command}\n\n`);
        printHelp(io);
        return 2;
    }
  } catch (err) {
    if (err instanceof QuorumError) {
      io.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
