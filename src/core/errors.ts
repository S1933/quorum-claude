export class QuorumError extends Error {
  override readonly name: string = 'QuorumError';
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
  }
}

export class ConfigError extends QuorumError {
  override readonly name = 'ConfigError';
}

export class ProviderInitError extends QuorumError {
  override readonly name = 'ProviderInitError';
  constructor(readonly providerId: string, message: string, cause?: unknown) {
    super(`[${providerId}] ${message}`, cause);
  }
}

export class ProviderRuntimeError extends QuorumError {
  override readonly name = 'ProviderRuntimeError';
  constructor(readonly providerId: string, message: string, cause?: unknown) {
    super(`[${providerId}] ${message}`, cause);
  }
}

export class ReviewerExecError extends QuorumError {
  override readonly name = 'ReviewerExecError';
  constructor(readonly reviewerId: string, message: string, cause?: unknown) {
    super(`[${reviewerId}] ${message}`, cause);
  }
}

export class ReviewerOutputError extends QuorumError {
  override readonly name = 'ReviewerOutputError';
  constructor(readonly reviewerId: string, message: string, cause?: unknown) {
    super(`[${reviewerId}] ${message}`, cause);
  }
}

export class CapabilityError extends QuorumError {
  override readonly name = 'CapabilityError';
}

export class DiffBudgetError extends QuorumError {
  override readonly name = 'DiffBudgetError';
  constructor(
    readonly actualBytes: number,
    readonly maxBytes: number,
    readonly fileCount: number,
  ) {
    super(
      `Diff is ${formatBytes(actualBytes)} (${fileCount} files), exceeding the ${formatBytes(maxBytes)} budget. ` +
        'Use defaults.includeFiles / defaults.excludeFiles to narrow scope, or increase defaults.maxDiffBytes.',
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
