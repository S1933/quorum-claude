#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfigFromPath, findConfigPath } from '../config/loader.ts';
import type { QuorumConfig } from '../config/schema.ts';
import { createRuntime as createRuntimeDefault, type Runtime } from '../runtime/runtime.ts';
import { defaultPluginCtx } from '../runtime/plugin.ts';
import { probeWorkspace, inferRepoRoot } from '../runtime/workspace.ts';
import { PipelineExecutor } from '../pipelines/executor.ts';
import { TerminalRenderer } from '../ui/terminal.ts';
import { renderMarkdownReport } from '../ui/markdown.ts';
import { renderJsonReport } from '../ui/json.ts';
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
  loadInitPersonaTemplates(): Promise<Record<string, PersonaTemplate>>;
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
  loadInitPersonaTemplates,
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
  quorum review [pipeline-id] [--pipeline <id>] [--base <ref>] [--config <path>] [--report <path>] [--format text|json] [--json] [--no-color] [--no-preview]
  quorum config [--config <path>]
  quorum init [--config <path>] [--provider <type>] [--model <id>] [--personas <ids>] [--force]
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
  const format = reviewOutputFormat(flags);
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

  const detach =
    format === 'text'
      ? new TerminalRenderer({
          stream: io.stdout,
          color: flags['no-color'] !== true,
          showTokens: flags['no-preview'] !== true,
        }).attach(runtime.bus)
      : () => undefined;

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

    if (format === 'json') {
      const json = renderJsonReport(result);
      if (typeof flags.report === 'string') {
        await writeReport(flags.report, json);
      }
      io.stdout.write(json);
    } else {
      const reportPath = typeof flags.report === 'string' ? flags.report : `${root}/.quorum/last-review.md`;
      await writeReport(reportPath, renderMarkdownReport(result));
      io.stdout.write(`\nreport: ${reportPath}\n`);
    }
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

async function cmdInit(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<number> {
  const configPath = typeof flags.config === 'string' ? flags.config : deps.findConfigPath();
  if (await Bun.file(configPath).exists()) {
    if (flags.force !== true) {
      throw new ConfigError(`Config file already exists: ${configPath}. Pass --force to overwrite.`);
    }
  }

  const provider = initProvider(flags.provider);
  const model = typeof flags.model === 'string' ? flags.model : defaultModel(provider);
  const personaTemplates = await deps.loadInitPersonaTemplates();
  const personas = initPersonas(flags.personas, personaTemplates);
  const yaml = renderInitConfig({ provider, model, personas, personaTemplates });

  await writeReport(configPath, yaml);
  io.stdout.write(`Created ${configPath}\n`);
  io.stdout.write(`Provider: ${provider}\n`);
  io.stdout.write(`Personas: ${personas.join(', ')}\n`);
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

function reviewOutputFormat(flags: Record<string, string | boolean>): 'text' | 'json' {
  if (flags.json === true) return 'json';
  if (flags.format === undefined) return 'text';
  if (flags.format === 'text' || flags.format === 'json') return flags.format;
  throw new ConfigError(`Unsupported review format "${String(flags.format)}"; expected "text" or "json"`);
}

type InitProvider =
  | 'claude-code'
  | 'openrouter'
  | 'codex-cli'
  | 'continue-dev'
  | 'gemini-cli'
  | 'kilo-code'
  | 'opencode-go'
  | 'ollama';

type InitPersona = string;

interface PersonaTemplate {
  description: string;
  system: string;
}

const INIT_PROVIDERS: InitProvider[] = [
  'claude-code',
  'openrouter',
  'codex-cli',
  'continue-dev',
  'gemini-cli',
  'kilo-code',
  'opencode-go',
  'ollama',
];

function initProvider(value: string | boolean | undefined): InitProvider {
  const provider = value === undefined ? 'claude-code' : String(value);
  if (INIT_PROVIDERS.includes(provider as InitProvider)) return provider as InitProvider;
  throw new ConfigError(
    `Unsupported init provider "${provider}"; expected one of ${INIT_PROVIDERS.join(', ')}`,
  );
}

function initPersonas(
  value: string | boolean | undefined,
  templates: Record<string, PersonaTemplate>,
): InitPersona[] {
  const available = Object.keys(templates);
  if (available.length === 0) throw new ConfigError('No personas found in quorum.yaml.example');
  if (value === undefined || value === true) return available;
  const personas = String(value)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (personas.length === 0) throw new ConfigError('At least one persona is required');
  for (const persona of personas) {
    if (!templates[persona]) {
      throw new ConfigError(
        `Unsupported init persona "${persona}"; expected one of ${available.join(', ')}`,
      );
    }
  }
  return personas as InitPersona[];
}

function defaultModel(provider: InitProvider): string {
  switch (provider) {
    case 'claude-code':
      return 'claude-opus-4-7';
    case 'openrouter':
      return 'anthropic/claude-opus-4';
    case 'codex-cli':
      return 'gpt-5-codex';
    case 'continue-dev':
      return 'continuedev/default-cli-config';
    case 'gemini-cli':
      return 'gemini-2.5-pro';
    case 'kilo-code':
      return 'anthropic/claude-sonnet-4-20250514';
    case 'opencode-go':
      return 'anthropic/claude-sonnet-4';
    case 'ollama':
      return 'llama3.1';
  }
}

function providerId(provider: InitProvider): string {
  switch (provider) {
    case 'claude-code':
      return 'claude-code-local';
    case 'openrouter':
      return 'openrouter-local';
    case 'codex-cli':
      return 'codex-local';
    case 'continue-dev':
      return 'continue-local';
    case 'gemini-cli':
      return 'gemini-local';
    case 'kilo-code':
      return 'kilo-local';
    case 'opencode-go':
      return 'opencode-local';
    case 'ollama':
      return 'ollama-local';
  }
}

function reviewerId(persona: InitPersona): string {
  switch (persona) {
    case 'security':
      return 'sec-reviewer';
    case 'backend-senior':
      return 'backend-reviewer';
    case 'architecture':
      return 'arch-reviewer';
    case 'performance':
      return 'perf-reviewer';
    default:
      return `${persona.replace(/[^a-zA-Z0-9_-]/g, '-')}-reviewer`;
  }
}

function renderInitConfig(opts: {
  provider: InitProvider;
  model: string;
  personas: InitPersona[];
  personaTemplates: Record<string, PersonaTemplate>;
}): string {
  const provider = providerId(opts.provider);
  const reviewers = opts.personas.map(reviewerId);
  return [
    'version: 1',
    '',
    'defaults:',
    '  pipeline: default',
    '',
    'providers:',
    renderProvider(provider, opts.provider, opts.model),
    '',
    'personas:',
    ...opts.personas.map((persona) => renderPersona(persona, opts.personaTemplates[persona]!)),
    '',
    'reviewers:',
    ...opts.personas.map((persona) => renderReviewer(reviewerId(persona), persona, provider)),
    '',
    'pipelines:',
    '  default:',
    '    parallel: true',
    `    reviewers: [${reviewers.join(', ')}]`,
    '    consensus: { strategy: overlap-v1 }',
    '',
  ].join('\n');
}

function renderProvider(id: string, type: InitProvider, model: string): string {
  const lines = [`  ${id}:`, `    type: ${type}`];
  if (type === 'openrouter') lines.push('    api_key: env:OPENROUTER_API_KEY');
  if (type === 'continue-dev') {
    lines.push(`    config: ${model}`);
  } else {
    lines.push(`    model: ${model}`);
  }
  if (type === 'opencode-go') lines.push('    command_style: prompt');
  if (type === 'ollama') lines.push('    base_url: http://localhost:11434');
  return lines.join('\n');
}

function renderPersona(persona: InitPersona, data: PersonaTemplate): string {
  return [
    `  ${persona}:`,
    `    description: ${data.description}`,
    '    system: |',
    ...data.system.split('\n').map((line) => `      ${line}`),
    '',
  ].join('\n');
}

function renderReviewer(id: string, persona: InitPersona, provider: string): string {
  return [
    `  ${id}:`,
    `    persona: ${persona}`,
    `    provider: ${provider}`,
    '',
  ].join('\n');
}

async function loadInitPersonaTemplates(): Promise<Record<string, PersonaTemplate>> {
  const path = fileURLToPath(new URL('../../quorum.yaml.example', import.meta.url));
  const cfg = await loadConfigFromPath(path);
  return Object.fromEntries(
    Object.entries(cfg.personas).map(([id, persona]) => [
      id,
      { description: persona.description, system: persona.system },
    ]),
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
