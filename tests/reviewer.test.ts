import { describe, expect, test } from 'bun:test';
import type { EventBus } from '../src/core/events.ts';
import type { ExecCtx, Provider, ProviderCapabilities } from '../src/core/provider.ts';
import type { ReviewTask, ReviewResult } from '../src/core/task.ts';
import { bindReviewer } from '../src/reviewers/reviewer.ts';
import { ReviewerOutputError, ProviderRuntimeError } from '../src/core/errors.ts';
import { RETRY_REMINDER } from '../src/reviewers/output.ts';

const bus: EventBus = {
  emit() {},
  on() {
    return () => {};
  },
  onAny() {
    return () => {};
  },
};

function reviewOnlyCapabilities(): ProviderCapabilities {
  return {
    review: true,
    streaming: false,
    tools: false,
    mcp: false,
    localExecution: false,
    backgroundJobs: false,
    costReporting: false,
  };
}

describe('bindReviewer', () => {
  test('does not override provider model with an empty string when only sampling options are set', async () => {
    let capturedCtx: ExecCtx | undefined;

    const provider: Provider = {
      id: 'provider-a',
      kind: 'http',
      capabilities: reviewOnlyCapabilities,
      async review(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult> {
        capturedCtx = ctx;
        return {
          taskId: task.id,
          reviewerId: task.reviewerId,
          findings: [],
          rawOutput: '{"findings":[]}',
          durationMs: 1,
        };
      },
    };

    const reviewer = bindReviewer(
      {
        id: 'security-openrouter',
        personaId: 'security',
        providerId: 'provider-a',
        overrides: { temperature: 0.1 },
      },
      {
        id: 'security',
        description: 'Security review',
        system: 'Review security issues.',
      },
      provider,
    );

    await reviewer.run(
      { id: 'task-1', instruction: 'review this diff', workspace: { root: '/repo' } },
      { bus, signal: new AbortController().signal, workspace: { root: '/repo' } },
    );

    expect(capturedCtx?.modelOverride).toEqual({ temperature: 0.1 });
  });

  function makeReviewer(review: (task: ReviewTask, ctx: ExecCtx) => Promise<ReviewResult>) {
    const provider: Provider = {
      id: 'provider-a',
      kind: 'subprocess',
      capabilities: reviewOnlyCapabilities,
      review,
    };
    return bindReviewer(
      { id: 'arch-reviewer', personaId: 'architecture', providerId: 'provider-a' },
      { id: 'architecture', description: 'Architecture review', system: 'Review architecture.' },
      provider,
    );
  }

  const runArgs = () =>
    [
      { id: 'task-1', instruction: 'review this diff', workspace: { root: '/repo' } },
      { bus, signal: new AbortController().signal, workspace: { root: '/repo' } },
    ] as const;

  test('retries once with the reminder when the first reply is not parseable JSON', async () => {
    const instructions: string[] = [];
    const reviewer = makeReviewer(async (task) => {
      instructions.push(task.instruction);
      if (instructions.length === 1) {
        throw new ReviewerOutputError('arch-reviewer', 'Reviewer output did not contain JSON');
      }
      return {
        taskId: task.id,
        reviewerId: task.reviewerId,
        findings: [],
        rawOutput: '{"findings":[]}',
        durationMs: 1,
      };
    });

    const result = await reviewer.run(...runArgs());

    expect(instructions).toHaveLength(2);
    expect(instructions[0]).toBe('review this diff');
    expect(instructions[1]).toContain('review this diff');
    expect(instructions[1]).toContain(RETRY_REMINDER);
    expect(result.findings).toEqual([]);
  });

  test('does not retry on a non-output error (e.g. process/timeout failure)', async () => {
    let calls = 0;
    const reviewer = makeReviewer(async () => {
      calls++;
      throw new ProviderRuntimeError('provider-a', 'timed out');
    });

    await expect(reviewer.run(...runArgs())).rejects.toThrow('timed out');
    expect(calls).toBe(1);
  });

  test('surfaces the error without retrying when the run was aborted', async () => {
    const controller = new AbortController();
    let calls = 0;
    const reviewer = makeReviewer(async () => {
      calls++;
      controller.abort();
      throw new ReviewerOutputError('arch-reviewer', 'Reviewer output did not contain JSON');
    });

    await expect(
      reviewer.run(
        { id: 'task-1', instruction: 'review this diff', workspace: { root: '/repo' } },
        { bus, signal: controller.signal, workspace: { root: '/repo' } },
      ),
    ).rejects.toThrow('did not contain JSON');
    expect(calls).toBe(1);
  });
});
