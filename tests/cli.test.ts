import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import type { QuorumConfig } from '../src/config/schema.ts';
import type { Pipeline } from '../src/core/pipeline.ts';
import type { Provider } from '../src/core/provider.ts';
import type { ReviewResult } from '../src/core/task.ts';
import { overlapV1 } from '../src/consensus/overlap-v1.ts';
import { ConsensusRegistry } from '../src/consensus/registry.ts';
import { ProviderRegistry } from '../src/providers/registry.ts';
import type { BoundReviewer } from '../src/reviewers/reviewer.ts';
import { main, type CliDeps, type CliIo } from '../src/cli/index.ts';
import { loadConfigFromPath } from '../src/config/loader.ts';
import { createInitConfig } from '../src/config/init.ts';
import { InMemoryEventBus } from '../src/runtime/bus.ts';
import type { Runtime } from '../src/runtime/runtime.ts';

interface FakeRuntime extends Runtime {
  disposed: boolean;
  lastPipelineId: string | undefined;
  lastReviewerIds: string[] | undefined;
}

describe('cli', () => {
  test('config prints redacted configuration', async () => {
    const io = captureIo();

    const code = await main(
      ['config', '--config', '/repo/quorum.yaml'],
      deps({
        loadConfigFromPath: async (path) => {
          expect(path).toBe('/repo/quorum.yaml');
          return config();
        },
      }),
      io,
    );

    expect(code).toBe(0);
    const printed = JSON.parse(io.stdoutText()) as QuorumConfig;
    expect(printed.providers['fake-provider']?.api_key).toBe('***redacted***');
    expect(io.stderrText()).toBe('');
  });

  test('review runs configured pipeline through an injected runtime and writes report', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-test-'));
    const reportPath = join(tmp, 'review.md');
    const runtime = fakeRuntime();

    const code = await main(
      ['review', '--config', '/repo/quorum.yaml', '--report', reportPath, '--no-color'],
      deps({
        loadConfigFromPath: async () => config(),
        inferRepoRoot: async () => '/repo',
        probeWorkspace: async () => ({
          root: '/repo',
          baseRef: 'main',
          diff: 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+change',
          files: ['src/app.ts'],
        }),
        createRuntime: async () => runtime,
        now: () => 123,
      }),
      io,
    );

    expect(code).toBe(0);
    expect(runtime.disposed).toBe(true);
    expect(runtime.lastPipelineId).toBe('default');
    expect(runtime.lastReviewerIds).toEqual(['fake-reviewer']);
    expect(io.stdoutText()).toContain('pipeline default');
    expect(io.stdoutText()).toContain('[fake-reviewer] {"findings"');
    expect(io.stdoutText()).toContain(`report: ${reportPath}`);

    const report = await Bun.file(reportPath).text();
    expect(report).toContain('# Quorum review — default');
    expect(report).toContain('Fake finding');
  });

  test('review prints machine-readable JSON without terminal progress output', async () => {
    const io = captureIo();
    const runtime = fakeRuntime();

    const code = await main(
      ['review', '--config', '/repo/quorum.yaml', '--json'],
      deps({
        loadConfigFromPath: async () => config(),
        inferRepoRoot: async () => '/repo',
        probeWorkspace: async () => ({
          root: '/repo',
          baseRef: 'main',
          diff: 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+change',
          files: ['src/app.ts'],
        }),
        createRuntime: async () => runtime,
        now: () => 123,
      }),
      io,
    );

    expect(code).toBe(0);
    const printed = JSON.parse(io.stdoutText());
    expect(printed.schemaVersion).toBe(1);
    expect(printed.pipeline).toEqual({
      id: 'default',
      durationMs: expect.any(Number),
      reviewCount: 1,
      errorCount: 0,
    });
    expect(printed.reviews[0].reviewerId).toBe('fake-reviewer');
    expect(printed.reviews[0].findings[0].title).toBe('Fake finding');
    expect(printed.consensus.unique[0].file).toBe('src/app.ts');
    expect(printed.errors).toEqual([]);
    expect(io.stdoutText()).not.toContain('pipeline default');
    expect(io.stdoutText()).not.toContain('report:');
    expect(io.stderrText()).toBe('');
  });

  test('review writes JSON to report path when JSON output is selected', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-json-test-'));
    const reportPath = join(tmp, 'review.json');

    const code = await main(
      ['review', '--config', '/repo/quorum.yaml', '--json', '--report', reportPath],
      deps({
        loadConfigFromPath: async () => config(),
        inferRepoRoot: async () => '/repo',
        probeWorkspace: async () => ({
          root: '/repo',
          baseRef: 'main',
          diff: 'diff --git a/src/app.ts b/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n+change',
          files: ['src/app.ts'],
        }),
        createRuntime: async () => fakeRuntime(),
        now: () => 123,
      }),
      io,
    );

    expect(code).toBe(0);
    const stdoutJson = JSON.parse(io.stdoutText());
    const reportJson = JSON.parse(await Bun.file(reportPath).text());
    expect(reportJson).toEqual(stdoutJson);
    expect(reportJson.schemaVersion).toBe(1);
    expect(reportJson.reviews[0].findings[0].title).toBe('Fake finding');
  });

  test('init writes a default claude-code config', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-init-test-'));
    const configPath = join(tmp, 'quorum.yaml');

    const code = await main(
      ['init', '--config', configPath],
      deps({ inferRepoRoot: async () => tmp }),
      io,
    );

    expect(code).toBe(0);
    expect(io.stdoutText()).toContain(`Created ${configPath}`);
    const cfg = await loadConfigFromPath(configPath);
    expect(cfg.providers['claude-code-local']).toEqual({
      type: 'claude-code',
      model: 'claude-opus-4-7',
    });
    expect(Object.keys(cfg.personas)).toEqual([
      'security',
      'backend-senior',
      'architecture',
      'performance',
    ]);
    expect(cfg.pipelines.default?.reviewers).toEqual([
      'sec-reviewer',
      'backend-reviewer',
      'arch-reviewer',
      'perf-reviewer',
    ]);
    expect(cfg.personas.security?.system.trim()).toBe('Template security prompt.');
  });

  test('init supports provider, model, and persona selection', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-init-test-'));
    const configPath = join(tmp, 'nested', 'quorum.yaml');

    const code = await main(
      [
        'init',
        '--config',
        configPath,
        '--provider',
        'opencode-go',
        '--model',
        'anthropic/claude-sonnet-4',
        '--personas',
        'security,performance',
      ],
      deps({ inferRepoRoot: async () => tmp }),
      io,
    );

    expect(code).toBe(0);
    const cfg = await loadConfigFromPath(configPath);
    expect(cfg.providers['opencode-local']).toEqual({
      type: 'opencode-go',
      model: 'anthropic/claude-sonnet-4',
      command_style: 'prompt',
    });
    expect(Object.keys(cfg.personas)).toEqual(['security', 'performance']);
    expect(Object.keys(cfg.reviewers)).toEqual(['sec-reviewer', 'perf-reviewer']);
    expect(cfg.pipelines.default?.reviewers).toEqual(['sec-reviewer', 'perf-reviewer']);
  });

  test('init refuses to overwrite an existing config without force', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-init-test-'));
    const configPath = join(tmp, 'quorum.yaml');
    await mkdir(tmp, { recursive: true });
    await Bun.write(configPath, 'existing');

    const code = await main(
      ['init', '--config', configPath],
      deps({ inferRepoRoot: async () => tmp }),
      io,
    );

    expect(code).toBe(1);
    expect(await Bun.file(configPath).text()).toBe('existing');
    expect(io.stderrText()).toContain('Config file already exists');
  });

  test('init rejects config paths outside the repository', async () => {
    const io = captureIo();
    const root = await mkdtemp(join(tmpdir(), 'quorum-cli-init-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'quorum-cli-init-outside-'));
    const configPath = join(outside, 'quorum.yaml');

    const code = await main(
      ['init', '--config', configPath],
      deps({ inferRepoRoot: async () => root }),
      io,
    );

    expect(code).toBe(1);
    expect(io.stderrText()).toContain('Refusing to write config outside repository');
    expect(await Bun.file(configPath).exists()).toBe(false);
  });

  test('init safely serializes model values as YAML data', async () => {
    const io = captureIo();
    const tmp = await mkdtemp(join(tmpdir(), 'quorum-cli-init-test-'));
    const configPath = join(tmp, 'quorum.yaml');

    const code = await main(
      [
        'init',
        '--config',
        configPath,
        '--provider',
        'opencode-go',
        '--model',
        'safe-model\nreviewers:\n  injected: { persona: security, provider: opencode-local }',
        '--personas',
        'security',
      ],
      deps({ inferRepoRoot: async () => tmp }),
      io,
    );

    expect(code).toBe(0);
    const cfg = await loadConfigFromPath(configPath);
    expect(Object.keys(cfg.reviewers)).toEqual(['sec-reviewer']);
    expect(cfg.providers['opencode-local']?.model).toBe(
      'safe-model\nreviewers:\n  injected: { persona: security, provider: opencode-local }',
    );
  });
});

function config(): QuorumConfig {
  return {
    version: 1,
    defaults: { pipeline: 'default' },
    providers: {
      'fake-provider': {
        type: 'fake',
        api_key: 'secret-key',
      },
    },
    personas: {
      fake: {
        description: 'Fake persona',
        system: 'Review.',
      },
    },
    reviewers: {
      'fake-reviewer': {
        persona: 'fake',
        provider: 'fake-provider',
      },
    },
    pipelines: {
      default: {
        parallel: true,
        reviewers: ['fake-reviewer'],
      },
    },
  };
}

function deps(overrides: Partial<CliDeps>): CliDeps {
  return {
    loadConfigFromPath: async () => config(),
    findConfigPath: () => '/repo/quorum.yaml',
    createInitConfig: (opts) => createInitConfig({ ...opts, personaTemplates: personaTemplates() }),
    inferRepoRoot: async () => '/repo',
    probeWorkspace: async () => ({ root: '/repo' }),
    createRuntime: async () => fakeRuntime(),
    now: () => 1,
    ...overrides,
  };
}

function personaTemplates(): Record<string, { description: string; system: string }> {
  return {
    security: {
      description: 'Adversarial security review',
      system: 'Template security prompt.',
    },
    'backend-senior': {
      description: 'Senior backend engineering review',
      system: 'Template backend prompt.',
    },
    architecture: {
      description: 'Architecture and maintainability review',
      system: 'Template architecture prompt.',
    },
    performance: {
      description: 'Performance and scalability review',
      system: 'Template performance prompt.',
    },
  };
}

function fakeRuntime(): FakeRuntime {
  const consensus = new ConsensusRegistry();
  consensus.register(overlapV1);
  const runtime: FakeRuntime = {
    bus: new InMemoryEventBus(),
    providers: new ProviderRegistry(),
    consensus,
    config: config(),
    pluginCtx: { workspaceRoot: '/repo', env: {} },
    disposed: false,
    lastPipelineId: undefined,
    lastReviewerIds: undefined,
    async resolveProvider() {
      throw new Error('not used');
    },
    async resolveReviewer() {
      throw new Error('not used');
    },
    async resolveReviewers(ids: string[]) {
      runtime.lastReviewerIds = ids;
      return [reviewer('fake-reviewer')];
    },
    resolvePipeline(id: string): Pipeline {
      runtime.lastPipelineId = id;
      return { id, parallel: true, reviewers: ['fake-reviewer'] };
    },
    async dispose() {
      runtime.disposed = true;
    },
  };
  return runtime;
}

function reviewer(id: string): BoundReviewer {
  return {
    id,
    persona: { id: 'fake', description: 'Fake persona', system: 'Review.' },
    provider: fakeProvider(),
    async run(task, ctx): Promise<ReviewResult> {
      ctx.bus.emit({
        type: 'reviewer.event',
        reviewerId: id,
        event: { type: 'token', text: '{"findings":[{"title":"Fake finding"}]}' },
      });
      return {
        taskId: task.id,
        reviewerId: id,
        findings: [
          {
            file: 'src/app.ts',
            lineRange: { start: 1, end: 1 },
            severity: 'medium',
            category: 'correctness',
            title: 'Fake finding',
            body: 'Fake body',
            reviewer: id,
          },
        ],
        rawOutput: '{"findings":[]}',
        durationMs: 1,
      };
    },
  };
}

function fakeProvider(): Provider {
  return {
    id: 'fake-provider',
    kind: 'http',
    capabilities() {
      return {
        review: true,
        streaming: false,
        tools: false,
        mcp: false,
        localExecution: false,
        backgroundJobs: false,
        costReporting: false,
      };
    },
  };
}

function captureIo(): CliIo & {
  stdoutText(): string;
  stderrText(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += String(chunk);
      },
    },
    stderr: {
      write(chunk) {
        stderr += String(chunk);
      },
    },
    stdoutText() {
      return stdout;
    },
    stderrText() {
      return stderr;
    },
  };
}
