import { mkdtemp } from 'node:fs/promises';
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
    expect(io.stdoutText()).toContain(`report: ${reportPath}`);

    const report = await Bun.file(reportPath).text();
    expect(report).toContain('# Quorum review — default');
    expect(report).toContain('Fake finding');
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
    inferRepoRoot: async () => '/repo',
    probeWorkspace: async () => ({ root: '/repo' }),
    createRuntime: async () => fakeRuntime(),
    now: () => 1,
    ...overrides,
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
    async run(task): Promise<ReviewResult> {
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
