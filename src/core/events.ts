import type { ProviderEvent } from './provider.ts';
import type { ReviewResult } from './task.ts';
import type { PipelineResult, ReviewerError } from './pipeline.ts';

export type QuorumEvent =
  | { type: 'pipeline.started'; pipelineId: string; reviewers: string[] }
  | { type: 'reviewer.started'; reviewerId: string }
  | { type: 'reviewer.event'; reviewerId: string; event: ProviderEvent }
  | { type: 'reviewer.finished'; reviewerId: string; result: ReviewResult }
  | { type: 'reviewer.failed'; reviewerId: string; error: ReviewerError }
  | { type: 'pipeline.finished'; result: PipelineResult }
  | { type: 'pipeline.timeout' };

export type QuorumEventType = QuorumEvent['type'];

export type EventHandler<K extends QuorumEventType> = (
  e: Extract<QuorumEvent, { type: K }>,
) => void;

export interface EventBus {
  emit(e: QuorumEvent): void;
  on<K extends QuorumEventType>(type: K, fn: EventHandler<K>): () => void;
  onAny(fn: (e: QuorumEvent) => void): () => void;
}
