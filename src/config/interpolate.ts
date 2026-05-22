import { ConfigError } from '../core/errors.ts';

const ENV_PREFIX = /^env:(.+)$/;
const TEMPLATE = /\$\{([A-Z0-9_]+)\}/g;

export interface InterpolateOptions {
  env?: Record<string, string | undefined>;
  lazy?: boolean;
}

export interface LazyEnvRef {
  __lazyEnv: true;
  varName: string;
  resolve(): string;
}

export function isLazyEnvRef(v: unknown): v is LazyEnvRef {
  return typeof v === 'object' && v !== null && (v as LazyEnvRef).__lazyEnv === true;
}

export function interpolateString(input: string, opts: InterpolateOptions = {}): string | LazyEnvRef {
  const env = opts.env ?? (typeof process !== 'undefined' ? process.env : {});

  const envMatch = ENV_PREFIX.exec(input);
  if (envMatch) {
    const varName = envMatch[1]!;
    if (opts.lazy) {
      return {
        __lazyEnv: true,
        varName,
        resolve() {
          const v = env[varName];
          if (v === undefined || v === '') {
            throw new ConfigError(`Required environment variable ${varName} is not set`);
          }
          return v;
        },
      };
    }
    const v = env[varName];
    if (v === undefined || v === '') {
      throw new ConfigError(`Required environment variable ${varName} is not set`);
    }
    return v;
  }

  return input.replace(TEMPLATE, (_, name: string) => {
    const v = env[name];
    if (v === undefined) {
      throw new ConfigError(`Required environment variable ${name} is not set`);
    }
    return v;
  });
}

export function interpolateDeep(value: unknown, opts: InterpolateOptions = {}): unknown {
  if (typeof value === 'string') {
    return interpolateString(value, opts);
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolateDeep(v, opts));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolateDeep(v, opts);
    }
    return out;
  }
  return value;
}

export function resolveLazy(value: unknown): unknown {
  if (isLazyEnvRef(value)) return value.resolve();
  if (Array.isArray(value)) return value.map(resolveLazy);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveLazy(v);
    }
    return out;
  }
  return value;
}
