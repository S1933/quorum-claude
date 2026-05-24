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
