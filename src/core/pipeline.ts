import type { ReviewResult } from './task.ts';
import type { Finding, FindingGroup, Contradiction } from './finding.ts';

export interface ReviewerOverrides {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  model?: string;
}

export interface ReviewerRef {
  id: string;
  personaId: string;
  providerId: string;
  overrides?: ReviewerOverrides;
}

export interface ConsensusConfig {
  strategy: string;
  requireAgreement?: number;
  [key: string]: unknown;
}

export interface Pipeline {
  id: string;
  parallel: boolean;
  reviewers: string[];
  consensus?: ConsensusConfig;
  timeoutMs?: number;
}

export interface ReviewerError {
  reviewerId: string;
  message: string;
  cause?: unknown;
}

export interface ConsensusResult {
  groups: FindingGroup[];
  agreement: Record<string, number>;
  unique: Finding[];
  contradictions: Contradiction[];
  strategyId: string;
}

export interface PipelineResult {
  pipelineId: string;
  reviews: ReviewResult[];
  consensus: ConsensusResult;
  durationMs: number;
  errors: ReviewerError[];
}
