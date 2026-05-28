#!/usr/bin/env bun
import { loadConfigFromPath, findConfigPath } from '../config/loader.ts';
import { createInitConfig } from '../config/init.ts';
import { createRuntime as createRuntimeDefault } from '../runtime/runtime.ts';
import { probeWorkspace, inferRepoRoot } from '../runtime/workspace.ts';
import { promptQuestion, selectManyCheckbox } from '../ui/select.ts';
import { QuorumError } from '../core/errors.ts';
import { parseArgs } from './args.ts';
import { cmdReview } from './commands/review.ts';
import { cmdConfig } from './commands/config.ts';
import { cmdInit } from './commands/init.ts';
import type { CliDeps, CliIo } from './types.ts';

export type { CliDeps, CliIo } from './types.ts';
export { redactConfig } from './commands/config.ts';
export { buildSafeFence, buildReviewInstruction, resolveDiffLimits } from './commands/review.ts';

const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
};

const defaultDeps: CliDeps = {
  loadConfigFromPath,
  findConfigPath,
  createInitConfig,
  inferRepoRoot,
  probeWorkspace,
  createRuntime: createRuntimeDefault,
  isInteractive: () => process.stdin.isTTY === true,
  prompt: promptQuestion,
  selectMany: selectManyCheckbox,
  now: Date.now,
};

function printHelp(io: CliIo): void {
  io.stdout.write(`quorum — multi-model consensus reviewer

Usage:
  quorum review [pipeline-id] [--pipeline <id>] [--base <ref>] [--config <path>] [--report <path>] [--format text|json] [--json] [--no-color] [--no-preview] [--max-diff-bytes <n>] [--include <glob>] [--exclude <glob>]
  quorum config [--config <path>]
  quorum init [--config <path>] [--provider <type>] [--model <id>] [--personas <ids>] [--force] [--list-providers] [--list-personas]
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
      case 'init':
        return await cmdInit(flags, deps, io);
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
