import { describe, expect, test } from 'bun:test';
import { ConfigError } from '../src/core/errors.ts';
import { loadConfigFromString } from '../src/config/loader.ts';
import { interpolateString, interpolateDeep, resolveLazy, isLazyEnvRef } from '../src/config/interpolate.ts';

const MINIMAL_YAML = `
version: 1
providers:
  openrouter-claude:
    type: openrouter
    api_key: test-key
    model: test-model
personas:
  security:
    description: Security review
    system: Review security issues.
reviewers:
  sec:
    persona: security
    provider: openrouter-claude
pipelines:
  default:
    reviewers: [sec]
`;

function withDefaults(extra: string): string {
  return MINIMAL_YAML.replace('version: 1', `version: 1\ndefaults:\n${extra}`);
}

describe('loadConfigFromString', () => {
  test('rejects defaults.provider because review-only config selects pipelines', async () => {
    const source = `
version: 1
defaults:
  provider: openrouter-claude
  pipeline: default
providers:
  openrouter-claude:
    type: openrouter
    api_key: test-key
    model: test-model
personas:
  security:
    description: Security review
    system: Review security issues.
reviewers:
  sec:
    persona: security
    provider: openrouter-claude
pipelines:
  default:
    reviewers: [sec]
`;

    await expect(loadConfigFromString(source)).rejects.toThrow(ConfigError);
  });

  test('parses a minimal valid config', async () => {
    const cfg = await loadConfigFromString(MINIMAL_YAML);
    expect(cfg.version).toBe(1);
    expect(Object.keys(cfg.providers)).toEqual(['openrouter-claude']);
    expect(Object.keys(cfg.personas)).toEqual(['security']);
    expect(Object.keys(cfg.reviewers)).toEqual(['sec']);
    expect(Object.keys(cfg.pipelines)).toEqual(['default']);
  });

  test('accepts reviewer file extension filters', async () => {
    const cfg = await loadConfigFromString(MINIMAL_YAML.replace(
      '    provider: openrouter-claude',
      '    provider: openrouter-claude\n    fileExtensions: [go, ts, .tsx]',
    ));
    expect(cfg.reviewers.sec?.fileExtensions).toEqual(['go', 'ts', '.tsx']);
  });

  test('accepts defaults.pipeline referencing existing pipeline', async () => {
    const cfg = await loadConfigFromString(withDefaults('  pipeline: default'));
    expect(cfg.defaults?.pipeline).toBe('default');
  });

  test('rejects defaults.pipeline referencing nonexistent pipeline', async () => {
    await expect(loadConfigFromString(withDefaults('  pipeline: nonexistent'))).rejects.toThrow(ConfigError);
  });

  test('accepts defaults with maxDiffBytes and file filters', async () => {
    const cfg = await loadConfigFromString(withDefaults(`  pipeline: default
  maxDiffBytes: 50000
  includeFiles: ["src/**/*.ts"]
  excludeFiles: ["*.test.ts"]`));
    expect(cfg.defaults?.maxDiffBytes).toBe(50000);
    expect(cfg.defaults?.includeFiles).toEqual(['src/**/*.ts']);
    expect(cfg.defaults?.excludeFiles).toEqual(['*.test.ts']);
  });

  test('rejects negative maxDiffBytes', async () => {
    await expect(loadConfigFromString(withDefaults('  pipeline: default\n  maxDiffBytes: -1'))).rejects.toThrow(ConfigError);
  });

  test('rejects fractional maxDiffBytes', async () => {
    await expect(loadConfigFromString(withDefaults('  pipeline: default\n  maxDiffBytes: 3.14'))).rejects.toThrow(ConfigError);
  });

  test('rejects reviewer referencing unknown persona', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: nonexistent, provider: p }
pipelines:
  default: { reviewers: [r] }
`;
    await expect(loadConfigFromString(source)).rejects.toThrow(/unknown persona/);
  });

  test('rejects reviewer referencing unknown provider', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: nonexistent }
pipelines:
  default: { reviewers: [r] }
`;
    await expect(loadConfigFromString(source)).rejects.toThrow(/unknown provider/);
  });

  test('rejects pipeline referencing unknown reviewer', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: p }
pipelines:
  default: { reviewers: [ghost] }
`;
    await expect(loadConfigFromString(source)).rejects.toThrow(/unknown reviewer/);
  });

  test('rejects consensus.requireAgreement exceeding reviewer count', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: p }
pipelines:
  default:
    reviewers: [r]
    consensus:
      strategy: overlap-v1
      requireAgreement: 5
`;
    await expect(loadConfigFromString(source)).rejects.toThrow(/requireAgreement.*exceeds/);
  });

  test('rejects invalid YAML', async () => {
    await expect(loadConfigFromString('{ invalid: yaml: :')).rejects.toThrow(ConfigError);
  });

  test('rejects missing version field', async () => {
    const source = `
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: p }
pipelines:
  default: { reviewers: [r] }
`;
    await expect(loadConfigFromString(source)).rejects.toThrow(ConfigError);
  });

  test('accepts empty reviewers array in pipeline', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: p }
pipelines:
  default: { reviewers: [] }
`;
    const cfg = await loadConfigFromString(source);
    expect(cfg.pipelines.default!.reviewers).toEqual([]);
  });

  test('accepts pipeline with maxConcurrency', async () => {
    const source = `
version: 1
providers:
  p: { type: openrouter, api_key: k, model: m }
personas:
  sec: { description: d, system: s }
reviewers:
  r: { persona: sec, provider: p }
pipelines:
  default:
    reviewers: [r]
    maxConcurrency: 3
`;
    const cfg = await loadConfigFromString(source);
    expect(cfg.pipelines.default!.maxConcurrency).toBe(3);
  });

  test('resolves env:VAR lazily during config parse', async () => {
    const source = MINIMAL_YAML.replace('api_key: test-key', 'api_key: env:MY_API_KEY');
    const cfg = await loadConfigFromString(source, { env: { MY_API_KEY: 'secret-123' } });
    const provider = cfg.providers['openrouter-claude'] as Record<string, unknown>;
    expect(isLazyEnvRef(provider.api_key)).toBe(true);
  });

  test('resolves ${VAR} template during config parse', async () => {
    const source = MINIMAL_YAML.replace('api_key: test-key', 'api_key: prefix-${MY_KEY}-suffix');
    const cfg = await loadConfigFromString(source, { env: { MY_KEY: 'abc' } });
    const provider = cfg.providers['openrouter-claude'] as Record<string, unknown>;
    expect(provider.api_key).toBe('prefix-abc-suffix');
  });
});

describe('interpolateString', () => {
  test('returns plain string unchanged', () => {
    expect(interpolateString('hello')).toBe('hello');
  });

  test('replaces env:VAR with environment value', () => {
    expect(interpolateString('env:TEST_VAR', { env: { TEST_VAR: 'val' } })).toBe('val');
  });

  test('throws on missing env:VAR', () => {
    expect(() => interpolateString('env:MISSING', { env: {} })).toThrow(ConfigError);
  });

  test('throws on empty env:VAR', () => {
    expect(() => interpolateString('env:EMPTY', { env: { EMPTY: '' } })).toThrow(ConfigError);
  });

  test('returns lazy ref in lazy mode', () => {
    const result = interpolateString('env:MY_KEY', { env: { MY_KEY: 'secret' }, lazy: true });
    expect(isLazyEnvRef(result)).toBe(true);
    expect((result as { resolve(): string }).resolve()).toBe('secret');
  });

  test('lazy ref throws when env var is missing at resolve time', () => {
    const result = interpolateString('env:MISSING', { env: {}, lazy: true });
    expect(isLazyEnvRef(result)).toBe(true);
    expect(() => (result as { resolve(): string }).resolve()).toThrow(ConfigError);
  });

  test('replaces ${VAR} template', () => {
    expect(interpolateString('${FOO}-bar', { env: { FOO: 'hello' } })).toBe('hello-bar');
  });

  test('replaces multiple ${VAR} templates', () => {
    expect(interpolateString('${A}_${B}', { env: { A: 'x', B: 'y' } })).toBe('x_y');
  });

  test('throws on missing ${VAR}', () => {
    expect(() => interpolateString('${NOPE}', { env: {} })).toThrow(ConfigError);
  });
});

describe('interpolateDeep', () => {
  test('recursively interpolates strings in objects', () => {
    const result = interpolateDeep(
      { a: 'env:K1', b: { c: '${K2}' } },
      { env: { K1: 'v1', K2: 'v2' } },
    );
    expect(result).toEqual({ a: 'v1', b: { c: 'v2' } });
  });

  test('recursively interpolates strings in arrays', () => {
    const result = interpolateDeep(['env:K1', 'plain'], { env: { K1: 'v1' } });
    expect(result).toEqual(['v1', 'plain']);
  });

  test('passes through non-string primitives', () => {
    expect(interpolateDeep(42)).toBe(42);
    expect(interpolateDeep(true)).toBe(true);
    expect(interpolateDeep(null)).toBe(null);
  });
});

describe('resolveLazy', () => {
  test('resolves lazy refs recursively', () => {
    const lazy = interpolateDeep(
      { key: 'env:SECRET', nested: { key2: 'env:TOKEN' } },
      { env: { SECRET: 's', TOKEN: 't' }, lazy: true },
    ) as Record<string, unknown>;

    const resolved = resolveLazy(lazy) as Record<string, unknown>;
    expect(resolved).toEqual({ key: 's', nested: { key2: 't' } });
  });

  test('passes through non-lazy values', () => {
    expect(resolveLazy('plain')).toBe('plain');
    expect(resolveLazy(42)).toBe(42);
    expect(resolveLazy([1, 'a'])).toEqual([1, 'a']);
  });
});
