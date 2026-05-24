import { fileURLToPath } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import type { QuorumConfig } from './schema.ts';
import { loadConfigFromPath } from './loader.ts';
import { ConfigError } from '../core/errors.ts';

export type InitProvider =
  | 'claude-code'
  | 'openrouter'
  | 'codex-cli'
  | 'continue-dev'
  | 'cursor-agent'
  | 'gemini-cli'
  | 'kilo-code'
  | 'opencode-go'
  | 'ollama';

export interface PersonaTemplate {
  description: string;
  system: string;
}

export interface InitConfigOptions {
  provider?: string | boolean;
  model?: string;
  personas?: string | boolean;
  personaTemplates?: Record<string, PersonaTemplate>;
}

export interface InitConfigResult {
  yaml: string;
  provider: InitProvider;
  personas: string[];
}

type ProviderInitConfig = { type: string } & Record<string, unknown>;

const INIT_PROVIDERS: InitProvider[] = [
  'claude-code',
  'openrouter',
  'codex-cli',
  'continue-dev',
  'cursor-agent',
  'gemini-cli',
  'kilo-code',
  'opencode-go',
  'ollama',
];

export async function createInitConfig(opts: InitConfigOptions = {}): Promise<InitConfigResult> {
  const provider = initProvider(opts.provider);
  const model = typeof opts.model === 'string' ? opts.model : defaultModel(provider);
  const personaTemplates = opts.personaTemplates ?? await loadInitPersonaTemplates();
  const personas = initPersonas(opts.personas, personaTemplates);
  const config = buildInitConfig({ provider, model, personas, personaTemplates });
  return {
    yaml: stringifyYaml(config, { lineWidth: 0 }),
    provider,
    personas,
  };
}

export async function loadInitPersonaTemplates(): Promise<Record<string, PersonaTemplate>> {
  const path = fileURLToPath(new URL('../../quorum.yaml.example', import.meta.url));
  const cfg = await loadConfigFromPath(path);
  return Object.fromEntries(
    Object.entries(cfg.personas).map(([id, persona]) => [
      id,
      { description: persona.description, system: persona.system },
    ]),
  );
}

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
): string[] {
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
  return personas;
}

function buildInitConfig(opts: {
  provider: InitProvider;
  model: string;
  personas: string[];
  personaTemplates: Record<string, PersonaTemplate>;
}): QuorumConfig {
  const provider = providerId(opts.provider);
  return {
    version: 1,
    defaults: { pipeline: 'default' },
    providers: {
      [provider]: providerConfig(opts.provider, opts.model),
    },
    personas: Object.fromEntries(
      opts.personas.map((persona) => {
        const template = opts.personaTemplates[persona]!;
        return [
          persona,
          {
            description: template.description,
            system: template.system,
          },
        ];
      }),
    ),
    reviewers: Object.fromEntries(
      opts.personas.map((persona) => [
        reviewerId(persona),
        {
          persona,
          provider,
        },
      ]),
    ),
    pipelines: {
      default: {
        parallel: true,
        reviewers: opts.personas.map(reviewerId),
        consensus: { strategy: 'overlap-v1' },
      },
    },
  };
}

function providerConfig(provider: InitProvider, model: string): ProviderInitConfig {
  const cfg: ProviderInitConfig = { type: provider };
  if (provider === 'openrouter') cfg.api_key = 'env:OPENROUTER_API_KEY';
  if (provider === 'continue-dev') {
    cfg.config = model;
  } else {
    cfg.model = model;
  }
  if (provider === 'opencode-go') cfg.command_style = 'prompt';
  if (provider === 'ollama') cfg.base_url = 'http://localhost:11434';
  return cfg;
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
    case 'cursor-agent':
      return 'auto';
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
    case 'cursor-agent':
      return 'cursor-local';
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

function reviewerId(persona: string): string {
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
