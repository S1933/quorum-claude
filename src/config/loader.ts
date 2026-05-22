import { parse as parseYaml } from 'yaml';
import { QuorumConfigSchema, type QuorumConfig } from './schema.ts';
import { interpolateDeep } from './interpolate.ts';
import { ConfigError } from '../core/errors.ts';

export interface LoadOptions {
  env?: Record<string, string | undefined>;
}

export async function loadConfigFromString(
  source: string,
  opts: LoadOptions = {},
): Promise<QuorumConfig> {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML: ${(err as Error).message}`, err);
  }

  const interpolated = interpolateDeep(raw, { env: opts.env, lazy: true });

  const parsed = QuorumConfigSchema.safeParse(interpolated);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid quorum config:\n${issues}`);
  }

  validateCrossRefs(parsed.data);
  return parsed.data;
}

export async function loadConfigFromPath(
  path: string,
  opts: LoadOptions = {},
): Promise<QuorumConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new ConfigError(`Config file not found: ${path}`);
  }
  const text = await file.text();
  return loadConfigFromString(text, opts);
}

function validateCrossRefs(cfg: QuorumConfig): void {
  const errors: string[] = [];

  for (const [revId, rev] of Object.entries(cfg.reviewers)) {
    if (!cfg.personas[rev.persona]) {
      errors.push(`reviewer "${revId}" references unknown persona "${rev.persona}"`);
    }
    if (!cfg.providers[rev.provider]) {
      errors.push(`reviewer "${revId}" references unknown provider "${rev.provider}"`);
    }
  }

  for (const [pipeId, pipe] of Object.entries(cfg.pipelines)) {
    for (const revId of pipe.reviewers) {
      if (!cfg.reviewers[revId]) {
        errors.push(`pipeline "${pipeId}" references unknown reviewer "${revId}"`);
      }
    }
    if (pipe.consensus?.requireAgreement && pipe.consensus.requireAgreement > pipe.reviewers.length) {
      errors.push(
        `pipeline "${pipeId}".consensus.requireAgreement (${pipe.consensus.requireAgreement}) exceeds reviewer count (${pipe.reviewers.length})`,
      );
    }
  }

  if (cfg.defaults?.provider && !cfg.providers[cfg.defaults.provider]) {
    errors.push(`defaults.provider "${cfg.defaults.provider}" not found in providers`);
  }
  if (cfg.defaults?.pipeline && !cfg.pipelines[cfg.defaults.pipeline]) {
    errors.push(`defaults.pipeline "${cfg.defaults.pipeline}" not found in pipelines`);
  }

  if (errors.length > 0) {
    throw new ConfigError(`Config validation failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

export function findConfigPath(cwd: string = process.cwd()): string {
  return `${cwd}/quorum.yaml`;
}
