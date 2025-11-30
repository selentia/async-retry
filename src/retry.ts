/**
 * @file retry.ts
 * @description Core retry implementation (policy engine)
 */

import type { RetryContext, RetryEvent, RetryOptions, ShouldRetry } from './types';
import { AbortError, RetryExhaustedError, RetryTimeoutError } from './errors';

function now() {
  return Date.now();
}

function assertFiniteNonNegative(name: string, n: number | undefined) {
  if (n == null) return;
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`${name} must be a finite number >= 0 (or undefined). Received: ${n}`);
  }
}

function assertFinitePositive(name: string, n: number | undefined) {
  if (n == null) return;
  if (!Number.isFinite(n) || n <= 0) {
    throw new RangeError(`${name} must be a finite number > 0 (or undefined). Received: ${n}`);
  }
}

function assertValidMaxAttempts(maxAttempts: number) {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1 || Math.floor(maxAttempts) !== maxAttempts) {
    throw new RangeError(`maxAttempts must be an integer >= 1. Received: ${maxAttempts}`);
  }
}

function toIntMs(ms: number) {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.trunc(ms));
}

function isAbortLikeError(err: unknown): boolean {
  const e = err as any;
  return (
    e?.name === 'AbortError' ||
    e?.code === 'ABORT_ERR' ||
    e?.code === 'ERR_CANCELED' // e.g. axios cancel
  );
}

function getStatus(err: unknown): number | undefined {
  const e = err as any;
  const s = e?.response?.status ?? e?.status ?? e?.statusCode;
  const n = typeof s === 'string' ? Number(s) : s;
  return Number.isFinite(n) ? (n as number) : undefined;
}

function getCode(err: unknown): string | undefined {
  const e = err as any;
  const c = e?.code;
  return typeof c === 'string' ? c : undefined;
}

function getMessage(err: unknown): string | undefined {
  const e = err as any;
  const m = e?.message;
  return typeof m === 'string' ? m : undefined;
}

const DEFAULT_RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_RETRIABLE_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
]);

export const defaultShouldRetry: ShouldRetry = (err, ctx) => {
  if (ctx.signal?.aborted) return false;
  if (isAbortLikeError(err)) return false;

  const status = getStatus(err);
  if (status != null) return DEFAULT_RETRIABLE_STATUS.has(status);

  const code = getCode(err);
  if (code != null && DEFAULT_RETRIABLE_CODES.has(code)) return true;

  const msg = getMessage(err);
  if (err instanceof TypeError && msg && /network|fetch|timeout/i.test(msg)) return true;

  return true;
};

function addAbortHandler(signal: AbortSignal | undefined, onAbort: () => void): (() => void) | null {
  if (!signal) return null;
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const waitMs = toIntMs(ms);

  if (waitMs === 0) {
    if (signal?.aborted) throw new AbortError('Retry aborted');
    await new Promise<void>((r) => setTimeout(r, 0));
    if (signal?.aborted) throw new AbortError('Retry aborted');
    return;
  }

  if (!signal) {
    await new Promise<void>((r) => setTimeout(r, waitMs));
    return;
  }

  if (signal.aborted) throw new AbortError('Retry aborted');

  await new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanups: Array<() => void> = [];

    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      for (const fn of cleanups.splice(0)) fn();
      if (err) reject(err);
      else resolve();
    };

    const t = setTimeout(() => finish(), waitMs);
    cleanups.push(() => clearTimeout(t));

    const rmAbort = addAbortHandler(signal, () => finish(new AbortError('Retry aborted')));
    if (rmAbort) cleanups.push(rmAbort);
  });
}

function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;

  // fetch Headers
  const anyHeaders = headers as any;
  if (typeof anyHeaders.get === 'function') {
    const v = anyHeaders.get(name);
    return typeof v === 'string' ? v : undefined;
  }

  if (typeof headers !== 'object') return undefined;
  const target = name.toLowerCase();

  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== target) continue;
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  }
  return undefined;
}

function parseRetryAfterHeaderMs(value: string): number | undefined {
  const trimmed = value.trim();

  const n = Number(trimmed);
  if (Number.isFinite(n)) return toIntMs(n * 1000);

  const t = Date.parse(trimmed);
  if (Number.isFinite(t)) return toIntMs(t - now());

  return undefined;
}

function readRetryAfterBody(err: unknown): unknown {
  const e = err as any;
  return e?.response?.data?.retry_after ?? e?.rawError?.retry_after ?? e?.data?.retry_after;
}

function parseRetryAfterBodyMs(value: unknown, unit: 'seconds' | 'milliseconds'): number | undefined {
  if (value == null) return undefined;

  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.trim())
        : Number.NaN;

  if (!Number.isFinite(n)) return undefined;
  return unit === 'seconds' ? toIntMs(n * 1000) : toIntMs(n);
}

function computeBackoffMs(
  attempt: number,
  args: { baseMs: number; capMs: number; factor: number }
): number {
  const raw = args.baseMs * args.factor ** (attempt - 1);
  const capped = Math.min(args.capMs, raw);
  return toIntMs(capped);
}

function applyFullJitter(backoffMs: number, rng: () => number): number {
  const r = rng();
  const x = Number.isFinite(r) ? r : 0;
  const clamped = Math.max(0, Math.min(0.999999999, x));
  return toIntMs(Math.floor(clamped * backoffMs));
}

function normalizeOptions(options: RetryOptions) {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseMs = options.baseMs ?? 200;
  const capMs = options.capMs ?? 2000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? 'full';
  const rng = options.rng ?? Math.random;

  assertValidMaxAttempts(maxAttempts);
  assertFiniteNonNegative('baseMs', baseMs);
  assertFiniteNonNegative('capMs', capMs);
  assertFinitePositive('factor', factor);
  assertFiniteNonNegative('maxElapsedMs', options.maxElapsedMs);

  const respectRetryAfter = options.respectRetryAfter ?? true;
  const retryAfterHeaderName = (options.retryAfterHeaderName ?? 'retry-after').trim() || 'retry-after';
  const retryAfterBodyUnit = options.retryAfterBodyUnit ?? false;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  return {
    ...options,
    maxAttempts,
    baseMs,
    capMs,
    factor,
    jitter,
    rng,
    respectRetryAfter,
    retryAfterHeaderName,
    retryAfterBodyUnit,
    shouldRetry,
  } as Required<
    Pick<
      RetryOptions,
      | 'maxAttempts'
      | 'baseMs'
      | 'capMs'
      | 'factor'
      | 'jitter'
      | 'rng'
      | 'respectRetryAfter'
      | 'retryAfterHeaderName'
      | 'retryAfterBodyUnit'
      | 'shouldRetry'
    >
  > &
    RetryOptions;
}

export async function retry<T>(
  task: (ctx: RetryContext) => T | Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = normalizeOptions(options);

  const startedAt = now();
  const maxAttempts = opts.maxAttempts;
  let attempt = 0;

  for (;;) {
    if (opts.signal?.aborted) throw new AbortError('Retry aborted');

    const elapsedMs0 = toIntMs(now() - startedAt);
    if (opts.maxElapsedMs != null && elapsedMs0 > opts.maxElapsedMs) {
      throw new RetryTimeoutError({ attempts: attempt, elapsedMs: elapsedMs0, maxElapsedMs: opts.maxElapsedMs });
    }

    attempt++;

    const ctx: RetryContext = {
      attempt,
      maxAttempts,
      startedAt,
      elapsedMs: toIntMs(now() - startedAt),
      signal: opts.signal,
    };

    try {
      return await task(ctx);
    } catch (err) {
      if (isAbortLikeError(err)) throw err;

      const elapsedMs = toIntMs(now() - startedAt);

      if (attempt >= maxAttempts) {
        if (opts.wrapError) {
          throw new RetryExhaustedError({ attempts: attempt, elapsedMs, maxAttempts, startedAt }, err);
        }
        throw err;
      }

      if (opts.signal?.aborted) throw new AbortError('Retry aborted');

      const updatedCtx: RetryContext = { ...ctx, elapsedMs };

      const retriable = await opts.shouldRetry(err, updatedCtx);
      if (!retriable) {
        if (opts.wrapError) {
          throw new RetryExhaustedError({ attempts: attempt, elapsedMs, maxAttempts, startedAt }, err);
        }
        throw err;
      }

      let reason: RetryEvent['reason'] = 'backoff';
      let delayMs: number | undefined;

      const status = getStatus(err);

      if (opts.respectRetryAfter && status === 429) {
        const headers = (err as any)?.response?.headers;
        const h = getHeader(headers, opts.retryAfterHeaderName);
        if (typeof h === 'string') {
          const parsed = parseRetryAfterHeaderMs(h);
          if (parsed != null) {
            reason = 'retry-after';
            delayMs = parsed;
          }
        }

        if (delayMs == null && opts.retryAfterBodyUnit !== false) {
          const bodyVal = readRetryAfterBody(err);
          const parsedBody = parseRetryAfterBodyMs(bodyVal, opts.retryAfterBodyUnit);
          if (parsedBody != null) {
            reason = 'retry-after';
            delayMs = parsedBody;
          }
        }
      }

      if (delayMs == null) {
        const backoff = computeBackoffMs(attempt, { baseMs: opts.baseMs, capMs: opts.capMs, factor: opts.factor });
        delayMs = opts.jitter === 'full' ? applyFullJitter(backoff, opts.rng) : backoff;
      }

      delayMs = toIntMs(delayMs);

      if (opts.maxElapsedMs != null && elapsedMs + delayMs > opts.maxElapsedMs) {
        throw new RetryTimeoutError({ attempts: attempt, elapsedMs, maxElapsedMs: opts.maxElapsedMs }, err);
      }

      const event: RetryEvent = {
        error: err,
        reason,
        delayMs,
        nextAttempt: attempt + 1,
        ctx: updatedCtx,
      };

      opts.onRetry?.(event);

      await sleep(delayMs, opts.signal);
    }
  }
}
