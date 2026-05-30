import { isLazyEnvRef } from './interpolate.ts';
import { getSensitiveFields } from './sensitive-fields.ts';

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