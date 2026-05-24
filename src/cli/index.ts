#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { loadConfigFromPath, findConfigPath } from '../config/loader.ts';
import type { QuorumConfig } from '../config/schema.ts';
import { createRuntime as createRuntimeDefault, type Runtime } from '../runtime/runtime.ts';
import { defaultPluginCtx } from '../runtime/plugin.ts';
import { probeWorkspace, inferRepoRoot } from '../runtime/workspace.ts';
import { PipelineExecutor } from '../pipelines/executor.ts';
import { TerminalRenderer } from '../ui/terminal.ts';
import { renderMarkdownReport } from '../ui/markdown.ts';
import { QuorumError, ConfigError } from '../core/errors.ts';
import type { WorkspaceInfo } from '../core/task.ts';
import type { WriteStreamLike } from '../ui/terminal.ts';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface CliIo {
  stdout: WriteStreamLike;
  stderr: WriteStreamLike;
}

export interface CliDeps {
  loadConfigFromPath(path: string): Promise<QuorumConfig>;
  findConfigPath(cwd?: string): string;
  inferRepoRoot(start?: string): Promise<string>;
  probeWorkspace(opts: { root: string; baseRef?: string }): Promise<WorkspaceInfo>;
  createRuntime(opts: Parameters<typeof createRuntimeDefault>[0]): Promise<Runtime>;
  now(): number;
}

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
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next && !next.startsWith('--')) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function printHelp(io: CliIo): void {
  io.stdout.write(`quorum — multi-model consensus reviewer

Usage:
  quorum review [pipeline-id] [--pipeline <id>] [--base <ref>] [--config <path>] [--report <path>] [--no-color]
  quorum config [--config <path>]
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

async function cmdReview(
  positional: string[],
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<number> {
  if (positional.length > 1) {
    throw new ConfigError(`Unexpected review arguments: ${positional.slice(1).join(' ')}`);
  }
  const configPath = typeof flags.config === 'string' ? flags.config : deps.findConfigPath();
  const config = await deps.loadConfigFromPath(configPath);
  const pipelineId =
    (typeof flags.pipeline === 'string' && flags.pipeline) || positional[0] || config.defaults?.pipeline;
  if (!pipelineId) throw new ConfigError('No pipeline specified and no defaults.pipeline configured');

  const root = await deps.inferRepoRoot();
  const workspace = await deps.probeWorkspace({
    root,
    ...(typeof flags.base === 'string' ? { baseRef: flags.base } : {}),
  });

  if (!workspace.diff) {
    io.stderr.write('No diff detected against base ref — nothing to review.\n');
    return 0;
  }

  const pluginCtx = defaultPluginCtx(root);
  const runtime = await deps.createRuntime({ config, pluginCtx });

  const pipeline = runtime.resolvePipeline(pipelineId);
  const reviewers = await runtime.resolveReviewers(pipeline.reviewers);

  const renderer = new TerminalRenderer({
    stream: io.stdout,
    color: flags['no-color'] !== true,
  });
  const detach = renderer.attach(runtime.bus);

  const executor = new PipelineExecutor();
  const instruction = buildReviewInstruction(workspace.diff, workspace.files ?? []);

  try {
    const result = await executor.run({
      pipeline,
      reviewers,
      workspace,
      instruction,
      taskId: `review-${deps.now()}`,
      bus: runtime.bus,
      consensus: runtime.consensus,
    });

    const reportPath = typeof flags.report === 'string' ? flags.report : `${root}/.quorum/last-review.md`;
    await writeReport(reportPath, renderMarkdownReport(result));
    io.stdout.write(`\nreport: ${reportPath}\n`);
    return result.errors.length > 0 && result.reviews.length === 0 ? 1 : 0;
  } finally {
    detach();
    await runtime.dispose();
  }
}

async function cmdConfig(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<number> {
  const configPath = typeof flags.config === 'string' ? flags.config : deps.findConfigPath();
  const config = await deps.loadConfigFromPath(configPath);
  const redacted = redactConfig(config);
  io.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  return 0;
}

function redactConfig(cfg: unknown): unknown {
  if (typeof cfg !== 'object' || cfg === null) return cfg;
  if (Array.isArray(cfg)) return cfg.map(redactConfig);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    if (isSensitiveKey(k)) {
      out[k] = '***redacted***';
    } else {
      out[k] = redactConfig(v);
    }
  }
  return out;
}

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[\s-]/g, '_');
  return (
    k === 'apikey' ||
    k === 'api_key' ||
    k === 'token' ||
    k.endsWith('_token') ||
    k === 'secret' ||
    k.endsWith('_secret') ||
    k === 'password' ||
    k.endsWith('_password')
  );
}

function buildReviewInstruction(diff: string, files: string[]): string {
  const fileList = files.length > 0 ? `Changed files:\n${files.map((f) => `  - ${f}`).join('\n')}\n\n` : '';
  return `${fileList}Review the following diff and report findings as structured JSON per the system prompt.\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

async function writeReport(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }
  await Bun.write(path, content);
}

if (import.meta.main) {
  const exitCode = await main();
  process.exit(exitCode);
}
