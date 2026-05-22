import type { z } from 'zod';
import type { Provider } from '../core/provider.ts';
import type { PluginCtx } from '../runtime/plugin.ts';
import { ConfigError } from '../core/errors.ts';
import { resolveLazy } from '../config/interpolate.ts';

export interface ProviderFactory {
  type: string;
  schema: z.ZodTypeAny;
  create(instanceId: string, config: unknown, ctx: PluginCtx): Promise<Provider>;
}

export class ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();

  register(factory: ProviderFactory): void {
    if (this.factories.has(factory.type)) {
      throw new ConfigError(`Provider type "${factory.type}" already registered`);
    }
    this.factories.set(factory.type, factory);
  }

  resolve(type: string): ProviderFactory | undefined {
    return this.factories.get(type);
  }

  async instantiate(
    id: string,
    rawConfig: unknown,
    ctx: PluginCtx,
  ): Promise<Provider> {
    if (typeof rawConfig !== 'object' || rawConfig === null) {
      throw new ConfigError(`Provider "${id}" config must be an object`);
    }
    const { type } = rawConfig as { type?: string };
    if (typeof type !== 'string') {
      throw new ConfigError(`Provider "${id}" is missing required "type" field`);
    }
    const factory = this.resolve(type);
    if (!factory) {
      throw new ConfigError(
        `Provider "${id}" uses unknown type "${type}". Available: ${[...this.factories.keys()].join(', ') || '(none)'}`,
      );
    }

    const resolved = resolveLazy(rawConfig);
    const parsed = factory.schema.safeParse(resolved);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
      throw new ConfigError(`Provider "${id}" (type ${type}) config invalid:\n${issues}`);
    }
    return factory.create(id, parsed.data, ctx);
  }

  list(): string[] {
    return [...this.factories.keys()];
  }
}
