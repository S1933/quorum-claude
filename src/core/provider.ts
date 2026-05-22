import type { AgentTask, AgentResult, ReviewTask, ReviewResult, ModelConfig, WorkspaceInfo } from './task.ts';
import type { Finding } from './finding.ts';
import type { EventBus } from './events.ts';

export type ProviderKind = 'http' | 'subprocess' | 'sdk';

export interface ProviderCapabilities {
  agent: boolean;
  review: boolean;
  streaming: boolean;
  tools: boolean;
  mcp: boolean;
  localExecution: boolean;
  backgroundJobs: boolean;
  costReporting: boolean;
}

export type ProviderEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'finding'; finding: Finding }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number };

export interface ExecCtx {
  bus: EventBus;
  signal: AbortSignal;
  workspace: WorkspaceInfo;
  modelOverride?: ModelConfig;
  reviewerId?: string;
}

export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;

  capabilities(): ProviderCapabilities;

  execute?(task: AgentTask, ctx: ExecCtx): Promise<AgentResult>;
  review?(task: ReviewTask, ctx: ExecCtx): Promise<ReviewResult>;
  stream?(task: AgentTask | ReviewTask, ctx: ExecCtx): AsyncIterable<ProviderEvent>;
  dispose?(): Promise<void>;
}
