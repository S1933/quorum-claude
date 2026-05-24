import { describe, expect, test } from 'bun:test';
import type { QuorumEvent } from '../src/core/events.ts';
import type { Finding } from '../src/core/finding.ts';
import type { Pipeline } from '../src/core/pipeline.ts';
import type { Provider } from '../src/core/provider.ts';
import type { ReviewResult, ReviewTask } from '../src/core/task.ts';
import { overlapV1 } from '../src/consensus/overlap-v1.ts';
import { ConsensusRegistry } from '../src/consensus/registry.ts';
import { PipelineExecutor } from '../src/pipelines/executor.ts';
import type { BoundReviewer } from '../src/reviewers/reviewer.ts';
import { InMemoryEventBus } from '../src/runtime/bus.ts';

describe('PipelineExecutor', () => {
  test('keeps partial results when one reviewer fails', async () => {
    const result = await runPipeline({
      parallel: true,
      reviewers: ['ok', 'fail'],
      boundReviewers: [
        reviewer('ok', async () => reviewResult('ok')),
        reviewer('fail', async () => {
          throw new Error('provider exploded');
        }),
      ],
    });

    expect(result.reviews.map((r) => r.reviewerId)).toEqual(['ok']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reviewerId).toBe('fail');
    expect(result.errors[0]?.message).toContain('[fail] provider exploded');
  });

  test('starts parallel reviewers before either finishes', async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runPipeline({
      parallel: true,
      reviewers: ['a', 'b'],
      boundReviewers: [
        reviewer('a', async () => {
          started.push('a');
          await gate;
          return reviewResult('a');
        }),
        reviewer('b', async () => {
          started.push('b');
          await gate;
          return reviewResult('b');
        }),
      ],
    });

    await waitFor(() => started.length === 2);
    expect(started).toEqual(['a', 'b']);
    release();
    const result = await run;
    expect(result.reviews).toHaveLength(2);
  });

  test('runs sequential reviewers in order', async () => {
    const order: string[] = [];

    await runPipeline({
      parallel: false,
      reviewers: ['a', 'b'],
      boundReviewers: [
        reviewer('a', async () => {
          order.push('a:start');
          order.push('a:end');
          return reviewResult('a');
        }),
        reviewer('b', async () => {
          order.push('b:start');
          order.push('b:end');
          return reviewResult('b');
        }),
      ],
    });

    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  test('aborts in-flight reviewers on timeout and emits timeout event', async () => {
    const events: QuorumEvent[] = [];
    const bus = new InMemoryEventBus();
    bus.onAny((e) => events.push(e));

    const result = await runPipeline({
      parallel: true,
      timeoutMs: 5,
      reviewers: ['slow'],
      boundReviewers: [
        reviewer('slow', async (_task, ctx) => {
          await waitFor(() => ctx.signal.aborted);
          throw new Error('aborted');
        }),
      ],
      bus,
    });

    expect(events.some((e) => e.type === 'pipeline.timeout')).toBe(true);
    expect(result.reviews).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reviewerId).toBe('slow');
  });
});

async function runPipeline(opts: {
  parallel: boolean;
  reviewers: string[];
  boundReviewers: BoundReviewer[];
  timeoutMs?: number;
  bus?: InMemoryEventBus;
}) {
  const pipeline: Pipeline = {
    id: 'test',
    parallel: opts.parallel,
    reviewers: opts.reviewers,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const consensus = new ConsensusRegistry();
  consensus.register(overlapV1);
  const executor = new PipelineExecutor();
  return executor.run({
    pipeline,
    reviewers: opts.boundReviewers,
    workspace: { root: '/repo' },
    instruction: 'review this',
    taskId: 'task',
    bus: opts.bus ?? new InMemoryEventBus(),
    consensus,
  });
}

function reviewer(
  id: string,
  run: BoundReviewer['run'],
): BoundReviewer {
  return {
    id,
    persona: { id: 'persona', description: 'Persona', system: 'Review.' },
    provider: fakeProvider(id),
    run,
  };
}

function fakeProvider(id: string): Provider {
  return {
    id,
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

function reviewResult(reviewerId: string, findings: Finding[] = []): ReviewResult {
  return {
    taskId: `task:${reviewerId}`,
    reviewerId,
    findings,
    rawOutput: '{"findings":[]}',
    durationMs: 1,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1_000) throw new Error('Timed out waiting for condition');
    await Bun.sleep(1);
  }
}
