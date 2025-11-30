/**
 * @file types.ts
 * @description async-retry public types
 */

export type Jitter = 'full' | 'none';

export type RetryContext = {
  /**
   * Current attempt number (1..maxAttempts)
   */
  attempt: number;

  /**
   * Total allowed attempts (including the first attempt)
   */
  maxAttempts: number;

  /**
   * Start time (epoch ms)
   */
  startedAt: number;

  /**
   * Elapsed time since startedAt (ms)
   */
  elapsedMs: number;

  /**
   * Abort signal (applies to sleep/wait operations and prevents starting the next attempt)
   */
  signal?: AbortSignal;
};

export type RetryEvent = {
  error: unknown;
  reason: 'retry-after' | 'backoff';
  delayMs: number;
  nextAttempt: number;
  ctx: RetryContext;
};

export type ShouldRetry = (error: unknown, ctx: RetryContext) => boolean | Promise<boolean>;

export type RetryOptions = {
  /**
   * Total attempts (including initial attempt).
   * Default: 3
   */
  maxAttempts?: number;

  /**
   * Base backoff delay (ms).
   * Default: 200
   */
  baseMs?: number;

  /**
   * Maximum backoff delay (ms).
   * Default: 2000
   */
  capMs?: number;

  /**
   * Backoff multiplier.
   * Default: 2
   */
  factor?: number;

  /**
   * Jitter strategy.
   * Default: 'full'
   */
  jitter?: Jitter;

  /**
   * Random generator for jitter (0 <= x < 1).
   * Default: Math.random
   */
  rng?: () => number;

  /**
   * Abort signal: stops waiting/sleep and prevents starting the next attempt.
   */
  signal?: AbortSignal;

  /**
   * Total time budget (ms).
   * Default: undefined (no budget)
   */
  maxElapsedMs?: number;

  /**
   * Determines whether an error is retriable.
   * Default: built-in defaultShouldRetry
   */
  shouldRetry?: ShouldRetry;

  /**
   * Observability hook: called right before sleeping for the next attempt.
   */
  onRetry?: (e: RetryEvent) => void;

  /**
   * Respect standard Retry-After header (seconds or HTTP-date).
   * Default: true
   */
  respectRetryAfter?: boolean;

  /**
   * Header name to read Retry-After from (case-insensitive).
   * Default: 'retry-after'
   */
  retryAfterHeaderName?: string;

  /**
   * If enabled, allows reading non-standard `retry_after` fields from the response body.
   * Default: false (body inspection disabled)
   */
  retryAfterBodyUnit?: 'seconds' | 'milliseconds' | false;

  /**
   * If true, wraps give-up errors into RetryExhaustedError.
   * Default: false
   */
  wrapError?: boolean;
};
