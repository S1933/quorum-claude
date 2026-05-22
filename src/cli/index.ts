#!/usr/bin/env bun
import { loadConfigFromPath, findConfigPath } from '../config/loader.ts';
import { createRuntime } from '../runtime/runtime.ts';
import { defaultPluginCtx } from '../runtime/plugin.ts';
import { probeWorkspace, inferRepoRoot } from '../runtime/workspace.ts';
import { PipelineExecutor } from '../pipelines/executor.ts';
import { TerminalRenderer } from '../ui/terminal.ts';
import { renderMarkdownReport } from '../ui/markdown.ts';
import { QuorumError, ConfigError } from '../core/errors.ts';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

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

function printHelp(): void {
  process.stdout.write(`quorum — multi-model consensus reviewer

Usage:
  quorum review [--pipeline <id>] [--base <ref>] [--config <path>] [--report <path>] [--no-color]
  quorum agent <task...> [--provider <id>] [--config <path>]
  quorum config [--config <path>]
  quorum help

Defaults are read from quorum.yaml in the working directory.
`);
}

async function main(): Promise<number> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  try {
    switch (command) {
      case 'help':
      case '-h':
      case '--help':
        printHelp();
        return 0;
      case 'review':
        return await cmdReview(flags);
      case 'agent':
        return await cmdAgent(positional, flags);
      case 'config':
        return await cmdConfig(flags);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n`);
        printHelp();
        return 2;
    }
  } catch (err) {
    if (err instanceof QuorumError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function cmdReview(flags: Record<string, string | boolean>): Promise<number> {
  const configPath = typeof flags.config === 'string' ? flags.config : findConfigPath();
  const config = await loadConfigFromPath(configPath);
  const pipelineId = (typeof flags.pipeline === 'string' && flags.pipeline) || config.defaults?.pipeline;
  if (!pipelineId) throw new ConfigError('No pipeline specified and no defaults.pipeline configured');

  const root = await inferRepoRoot();
  const workspace = await probeWorkspace({
    root,
    ...(typeof flags.base === 'string' ? { baseRef: flags.base } : {}),
  });

  if (!workspace.diff) {
    process.stderr.write('No diff detected against base ref — nothing to review.\n');
    return 0;
  }

  const pluginCtx = defaultPluginCtx(root);
  const runtime = await createRuntime({ config, pluginCtx });

  const pipeline = runtime.resolvePipeline(pipelineId);
  const reviewers = await runtime.resolveReviewers(pipeline.reviewers);

  const renderer = new TerminalRenderer({
    stream: process.stdout,
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
      taskId: `review-${Date.now()}`,
      bus: runtime.bus,
      consensus: runtime.consensus,
    });

    const reportPath = typeof flags.report === 'string' ? flags.report : `${root}/.quorum/last-review.md`;
    await writeReport(reportPath, renderMarkdownReport(result));
    process.stdout.write(`\nreport: ${reportPath}\n`);
    return result.errors.length > 0 && result.reviews.length === 0 ? 1 : 0;
  } finally {
    detach();
    await runtime.dispose();
  }
}

async function cmdAgent(positional: string[], flags: Record<string, string | boolean>): Promise<number> {
  if (positional.length === 0) {
    process.stderr.write('agent: missing task instruction\n');
    return 2;
  }
  const configPath = typeof flags.config === 'string' ? flags.config : findConfigPath();
  const config = await loadConfigFromPath(configPath);
  const providerId =
    (typeof flags.provider === 'string' && flags.provider) || config.defaults?.provider;
  if (!providerId) throw new ConfigError('No provider specified and no defaults.provider configured');

  const root = await inferRepoRoot().catch(() => process.cwd());
  const pluginCtx = defaultPluginCtx(root);
  const runtime = await createRuntime({ config, pluginCtx });

  try {
    const provider = await runtime.resolveProvider(providerId);
    if (!provider.execute) {
      throw new ConfigError(`Provider "${providerId}" does not support agent execution`);
    }
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);

    try {
      const instruction = positional.join(' ');
      const result = await provider.execute(
        { kind: 'agent', id: `agent-${Date.now()}`, instruction, workspace: { root } },
        { bus: runtime.bus, signal: ac.signal, workspace: { root } },
      );
      process.stdout.write(`${result.output}\n`);
      if (result.usage) {
        process.stderr.write(
          `\n[usage] in=${result.usage.inputTokens} out=${result.usage.outputTokens}\n`,
        );
      }
      return 0;
    } finally {
      process.removeListener('SIGINT', onSig);
      process.removeListener('SIGTERM', onSig);
    }
  } finally {
    await runtime.dispose();
  }
}

async function cmdConfig(flags: Record<string, string | boolean>): Promise<number> {
  const configPath = typeof flags.config === 'string' ? flags.config : findConfigPath();
  const config = await loadConfigFromPath(configPath);
  const redacted = redactConfig(config);
  process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
  return 0;
}

function redactConfig(cfg: unknown): unknown {
  if (typeof cfg !== 'object' || cfg === null) return cfg;
  if (Array.isArray(cfg)) return cfg.map(redactConfig);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg as Record<string, unknown>)) {
    if (/api[_-]?key|token|secret|password/i.test(k)) {
      out[k] = '***redacted***';
    } else {
      out[k] = redactConfig(v);
    }
  }
  return out;
}

function buildReviewInstruction(diff: string, files: string[]): string {
  const fileList = files.length > 0 ? `Changed files:\n${files.map((f) => `  - ${f}`).join('\n')}\n\n` : '';
  return `${fileList}Review the following diff and report findings as structured JSON per the system prompt.\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

async function writeReport(path: string, content: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf('/'));
  if (dir) {
    await Bun.spawn({ cmd: ['mkdir', '-p', dir] }).exited;
  }
  await Bun.write(path, content);
}

const exitCode = await main();
process.exit(exitCode);
