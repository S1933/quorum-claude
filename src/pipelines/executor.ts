import type { ReviewResult, WorkspaceInfo } from '../core/task.ts';
import type { Pipeline, PipelineResult, ReviewerError, ConsensusResult } from '../core/pipeline.ts';
import type { EventBus } from '../core/events.ts';
import type { BoundReviewer } from '../reviewers/reviewer.ts';
import type { ConsensusRegistry } from '../consensus/registry.ts';
import { ReviewerExecError } from '../core/errors.ts';

export interface PipelineRunInput {
  pipeline: Pipeline;
  reviewers: BoundReviewer[];
  workspace: WorkspaceInfo;
  instruction: string;
  taskId: string;
  bus: EventBus;
  consensus: ConsensusRegistry;
  signal?: AbortSignal;
}

export class PipelineExecutor {
  async run(input: PipelineRunInput): Promise<PipelineResult> {
    const { pipeline, reviewers, bus, signal, workspace, instruction, taskId, consensus } = input;
    const started = Date.now();

    bus.emit({
      type: 'pipeline.started',
      pipelineId: pipeline.id,
      reviewers: reviewers.map((r) => r.id),
    });

    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    if (pipeline.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        bus.emit({ type: 'pipeline.timeout' });
        controller.abort();
      }, pipeline.timeoutMs);
    }

    const reviews: ReviewResult[] = [];
    const errors: ReviewerError[] = [];

    try {
      const runOne = async (rev: BoundReviewer, index: number): Promise<void> => {
        bus.emit({ type: 'reviewer.started', reviewerId: rev.id });
        try {
          const result = await rev.run(
            { id: `${taskId}:${rev.id}`, instruction, workspace },
            { bus, signal: controller.signal, workspace },
          );
          reviews[index] = result;
          bus.emit({ type: 'reviewer.finished', reviewerId: rev.id, result });
        } catch (err) {
          const message =
            err instanceof Error ? err.message : `Unknown reviewer failure: ${String(err)}`;
          const wrapped =
            err instanceof ReviewerExecError
              ? err
              : new ReviewerExecError(rev.id, message, err);
          const reviewerError: ReviewerError = { reviewerId: rev.id, message: wrapped.message, cause: err };
          errors[index] = reviewerError;
          bus.emit({ type: 'reviewer.failed', reviewerId: rev.id, error: reviewerError });
        }
      };

      if (pipeline.parallel) {
        const limit = pipeline.maxConcurrency;
        if (limit && limit < reviewers.length) {
          await runWithConcurrencyLimit(reviewers, limit, runOne);
        } else {
          await Promise.all(reviewers.map((r, i) => runOne(r, i)));
        }
      } else {
        for (let i = 0; i < reviewers.length; i++) {
          if (controller.signal.aborted) break;
          await runOne(reviewers[i]!, i);
        }
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }

    const consensusResult = computeConsensus(reviews.filter(Boolean), pipeline, consensus);

    const result: PipelineResult = {
      pipelineId: pipeline.id,
      reviews: reviews.filter(Boolean),
      consensus: consensusResult,
      durationMs: Date.now() - started,
      errors: errors.filter(Boolean),
    };
    bus.emit({ type: 'pipeline.finished', result });
    if (timedOut) {
      // already emitted pipeline.timeout above
    }
    return result;
  }
}

async function runWithConcurrencyLimit(
  reviewers: BoundReviewer[],
  limit: number,
  runOne: (rev: BoundReviewer, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < reviewers.length) {
      const idx = next++;
      await runOne(reviewers[idx]!, idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, reviewers.length) }, () => worker()));
}

function computeConsensus(
  reviews: ReviewResult[],
  pipeline: Pipeline,
  registry: ConsensusRegistry,
): ConsensusResult {
  if (!pipeline.consensus) {
    return {
      groups: [],
      agreement: {},
      unique: reviews.flatMap((r) => r.findings),
      contradictions: [],
      strategyId: 'none',
    };
  }
  const strategy = registry.resolve(pipeline.consensus.strategy);
  return strategy.aggregate(reviews, pipeline.consensus);
}
