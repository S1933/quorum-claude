import {
  INIT_PROVIDERS,
  defaultInitModel,
  loadInitPersonaTemplates,
  type InitConfigOptions,
} from '../../config/init.ts';
import { ConfigError } from '../../core/errors.ts';
import type { CliDeps, CliIo } from '../types.ts';
import { writeReport, resolveConfigPath, assertPathInside } from '../report.ts';

export function printInitHelp(io: CliIo): void {
  io.stdout.write(`quorum init — create a starter quorum.yaml

Usage:
  quorum init [--config <path>] [--provider <type>] [--model <id>] [--personas <ids>] [--force]
  quorum init --list-providers
  quorum init --list-personas

Options:
  --provider <type>   Provider to configure. Use comma-separated ids for multiple providers.
  --model <id>        Provider model or config id.
  --personas <ids>    Comma-separated persona ids.
  --force             Overwrite an existing config.

When run in a terminal without --provider or --personas, init shows checkbox selectors.
`);
}

export async function cmdInit(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<number> {
  if (flags.help === true || flags.h === true) {
    printInitHelp(io);
    return 0;
  }
  if (flags['list-providers'] === true) {
    for (const provider of INIT_PROVIDERS) {
      io.stdout.write(`${provider}\tdefault model: ${defaultInitModel(provider)}\n`);
    }
    return 0;
  }
  if (flags['list-personas'] === true) {
    const personas = await loadInitPersonaTemplates();
    for (const [id, persona] of Object.entries(personas)) {
      io.stdout.write(`${id}\t${persona.description}\n`);
    }
    return 0;
  }

  const root = await deps.inferRepoRoot();
  const configPath = resolveConfigPath(root, flags.config, deps);
  assertPathInside(root, configPath);

  if (await Bun.file(configPath).exists()) {
    if (flags.force !== true) {
      throw new ConfigError(`Config file already exists: ${configPath}. Pass --force to overwrite.`);
    }
  }

  const providers = await promptInitProviders(flags, deps, io);
  const personas = await promptInitPersonas(flags, deps, io);
  const model = await promptInitModel(flags, providers, deps, io);

  const initOpts: InitConfigOptions = {};
  if (providers) initOpts.providers = providers;
  if (providers === undefined && flags.provider !== undefined) initOpts.provider = flags.provider;
  if (model !== undefined) initOpts.model = model;
  if (model === undefined && typeof flags.model === 'string') initOpts.model = flags.model;
  if (personas !== undefined) initOpts.personas = personas.join(',');
  if (personas === undefined && flags.personas !== undefined) initOpts.personas = flags.personas;
  const result = await deps.createInitConfig(initOpts);

  await writeReport(configPath, result.yaml);
  io.stdout.write(`Created ${configPath}\n`);
  io.stdout.write(`Providers: ${result.providers.join(', ')}\n`);
  io.stdout.write(`Personas: ${result.personas.join(', ')}\n`);
  return 0;
}

async function promptInitProviders(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<string[] | undefined> {
  if (flags.provider !== undefined || !deps.isInteractive()) return undefined;
  return deps.selectMany(
    'Select provider(s) to configure first',
    INIT_PROVIDERS.map((provider) => ({
      value: provider,
      label: provider,
      hint: `default model: ${defaultInitModel(provider)}`,
    })),
    [INIT_PROVIDERS[0]!],
    io,
  );
}

async function promptInitPersonas(
  flags: Record<string, string | boolean>,
  deps: CliDeps,
  io: CliIo,
): Promise<string[] | undefined> {
  if (flags.personas !== undefined || !deps.isInteractive()) return undefined;
  const templates = await loadInitPersonaTemplates();
  const entries = Object.entries(templates);
  return deps.selectMany(
    'Select persona(s) to enable',
    entries.map(([id, persona]) => ({
      value: id,
      label: id,
      hint: persona.description,
    })),
    entries.map(([id]) => id),
    io,
  );
}

async function promptInitModel(
  flags: Record<string, string | boolean>,
  selectedProviders: string[] | undefined,
  deps: CliDeps,
  io: CliIo,
): Promise<string | undefined> {
  if (flags.model !== undefined || !deps.isInteractive()) return undefined;
  const providers =
    selectedProviders ?? (typeof flags.provider === 'string' ? parseProviderSelection(flags.provider) : undefined);
  if (!providers || providers.length !== 1) return undefined;
  const provider = providers[0] as (typeof INIT_PROVIDERS)[number];
  const defaultModel = defaultInitModel(provider);
  const answer = await deps.prompt(`Model for ${provider} [${defaultModel}]: `, io);
  const model = answer.trim();
  return model || defaultModel;
}

function parseProviderSelection(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [INIT_PROVIDERS[0]!];
  if (raw.toLowerCase() === 'all') return [...INIT_PROVIDERS];
  return parseSelection(value, [...INIT_PROVIDERS]);
}

function parseSelection(value: string, available: string[]): string[] {
  const raw = value.trim();
  if (!raw || raw.toLowerCase() === 'all') return available;
  const selected = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (/^\d+$/.test(item)) {
        const persona = available[Number(item) - 1];
        if (persona) return persona;
      }
      if (available.includes(item)) return item;
      throw new ConfigError(
        `Unsupported init selection "${item}"; expected numbers 1-${available.length}, ids, or "all"`,
      );
    });
  return [...new Set(selected)];
}
