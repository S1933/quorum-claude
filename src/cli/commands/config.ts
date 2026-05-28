import { isLazyEnvRef } from '../../config/interpolate.ts';
import { getSensitiveFields } from '../../config/sensitive-fields.ts';
import type { CliDeps, CliIo } from '../types.ts';

export async function cmdConfig(
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

export function redactConfig(cfg: unknown, providerType?: string): unknown {
  if (isLazyEnvRef(cfg)) return '***redacted***';
  if (typeof cfg !== 'object' || cfg === null) return cfg;
  if (Array.isArray(cfg)) return cfg.map((v) => redactConfig(v, providerType));

  const obj = cfg as Record<string, unknown>;
  const typeFromConfig = typeof obj.type === 'string' ? obj.type : undefined;
  const effectiveType = typeFromConfig ?? providerType;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k) || isProviderSensitiveField(effectiveType, k)) {
      out[k] = '***redacted***';
    } else {
      out[k] = redactConfig(v, k === 'type' ? providerType : effectiveType);
    }
  }
  return out;
}

function isProviderSensitiveField(providerType: string | undefined, key: string): boolean {
  if (!providerType) return false;
  const fields = getSensitiveFields(providerType);
  return fields?.has(key) ?? false;
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
