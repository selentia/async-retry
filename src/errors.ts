/**
 * @file errors.ts
 * @description async-retry errors (exported)
 */

export type AsyncRetryErrorCode =
  | 'ERR_ASYNC_RETRY_ABORTED'
  | 'ERR_ASYNC_RETRY_TIMEOUT'
  | 'ERR_ASYNC_RETRY_EXHAUSTED';

export class AsyncRetryError extends Error {
  public readonly code: AsyncRetryErrorCode;

  constructor(message: string, code: AsyncRetryErrorCode, cause?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = this.constructor.name;
    this.code = code;

    if (cause !== undefined) {
      // ES2022 `Error.cause` is supported in Node>=18, but the property is also assigned defensively.
      (this as any).cause = cause;
    }
  }
}

/**
 * A lightweight AbortError compatible with typical "AbortError" checks.
 * Note: DOMException('AbortError') is not consistently available across runtimes,
 * so a custom implementation is provided here.
 */
export class AbortError extends AsyncRetryError {
  constructor(message = 'Aborted') {
    super(message, 'ERR_ASYNC_RETRY_ABORTED');
    this.name = 'AbortError';
  }
}

export class RetryTimeoutError extends AsyncRetryError {
  public readonly attempts: number;
  public readonly elapsedMs: number;
  public readonly maxElapsedMs: number;

  constructor(args: { attempts: number; elapsedMs: number; maxElapsedMs: number }, cause?: unknown) {
    super(
      `Retry timeout: elapsed=${args.elapsedMs}ms exceeded budget=${args.maxElapsedMs}ms`,
      'ERR_ASYNC_RETRY_TIMEOUT',
      cause
    );
    this.attempts = args.attempts;
    this.elapsedMs = args.elapsedMs;
    this.maxElapsedMs = args.maxElapsedMs;
  }
}

export class RetryExhaustedError extends AsyncRetryError {
  public readonly attempts: number;
  public readonly elapsedMs: number;
  public readonly maxAttempts: number;
  public readonly startedAt: number;

  constructor(args: { attempts: number; elapsedMs: number; maxAttempts: number; startedAt: number }, cause?: unknown) {
    super(
      `Retry exhausted: attempts=${args.attempts}/${args.maxAttempts}, elapsed=${args.elapsedMs}ms`,
      'ERR_ASYNC_RETRY_EXHAUSTED',
      cause
    );
    this.attempts = args.attempts;
    this.elapsedMs = args.elapsedMs;
    this.maxAttempts = args.maxAttempts;
    this.startedAt = args.startedAt;
  }
}
