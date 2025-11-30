/**
 * @file retry.test.ts
 * @description Public behavior tests for @selentia/async-retry.
 *
 * Notes
 * - These tests use Vitest fake timers to deterministically control time-based behavior.
 * - Always attach rejection handlers (e.g., `expect(p).rejects...`) before advancing timers.
 *   This avoids unhandled-rejection warnings during test execution.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  retry,
  createRetry,
  AbortError,
  RetryTimeoutError,
  RetryExhaustedError,
  type RetryEvent,
} from '../src';

afterEach(() => {
  vi.useRealTimers();
});

function makeHttpError(status: number, headers?: Record<string, string>) {
  const err: any = new Error(`HTTP ${status}`);
  err.response = { status, headers: headers ?? {} };
  return err;
}

describe('retry (core)', () => {
  it('resolves immediately when task succeeds (no retries)', async () => {
    vi.useFakeTimers();

    const onRetry = vi.fn();

    const p = retry(async () => 'ok', { onRetry });

    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe('ok');
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries with backoff + full jitter until success (deterministic rng)', async () => {
    vi.useFakeTimers();

    const events: RetryEvent[] = [];
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('fail');
        return 'ok';
      },
      {
        maxAttempts: 5,
        baseMs: 1000,
        capMs: 1500,
        factor: 2,
        rng: () => 0.5,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(10_000);
    await asrt;

    expect(calls).toBe(3);
    expect(events).toHaveLength(2);

    // attempt=1 failed -> backoff=1000 -> full jitter with 0.5 => 500
    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(500);
    expect(events[0].nextAttempt).toBe(2);

    // attempt=2 failed -> raw=2000 -> cap=1500 -> jitter 0.5 => 750
    expect(events[1].reason).toBe('backoff');
    expect(events[1].delayMs).toBe(750);
    expect(events[1].nextAttempt).toBe(3);
  });

  it('honors Retry-After header (seconds) for 429, without jitter', async () => {
    vi.useFakeTimers();

    const events: RetryEvent[] = [];
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw makeHttpError(429, { 'Retry-After': '2' });
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 1,
        rng: () => 0.1,
        onRetry: (e) => events.push(e),
      }
    );

    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe('ok');

    expect(calls).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('honors Retry-After header (HTTP-date) for 429, without jitter', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    const events: RetryEvent[] = [];
    let calls = 0;

    const date = new Date(Date.now() + 2000).toUTCString();

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw makeHttpError(429, { 'retry-after': date });
        return 'ok';
      },
      { maxAttempts: 2, onRetry: (e) => events.push(e) }
    );

    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toBe('ok');

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('aborts during sleep and rejects with AbortError (attach rejection first)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 5,
        baseMs: 1000,
        rng: () => 0.5, // delay 500
        signal: ac.signal,
      }
    );

    const asrt = expect(p).rejects.toBeInstanceOf(AbortError);

    // Abort while waiting
    ac.abort();
    await asrt;

    expect(calls).toBe(1);
  });

  it('enforces maxElapsedMs budget before sleeping (throws RetryTimeoutError)', async () => {
    vi.useFakeTimers();

    const onRetry = vi.fn();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 5,
        baseMs: 200,
        capMs: 200,
        rng: () => 0.75, // delay floor(0.75*200)=150
        maxElapsedMs: 100, // cannot afford sleeping 150ms
        onRetry,
      }
    );

    const asrt = expect(p).rejects.toBeInstanceOf(RetryTimeoutError);
    await vi.advanceTimersByTimeAsync(0);
    await asrt;
    expect(onRetry).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it('wrapError=true wraps exhausted failures into RetryExhaustedError', async () => {
    vi.useFakeTimers();

    const original = new Error('boom');
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw original;
      },
      {
        maxAttempts: 2,
        baseMs: 0,
        capMs: 0,
        rng: () => 0,
        wrapError: true,
      }
    );

    const asrt = expect(p).rejects.toBeInstanceOf(RetryExhaustedError);
    await vi.advanceTimersByTimeAsync(0);
    await asrt;

    expect(calls).toBe(2);
  });

  it('wrapError=true wraps non-retriable failures into RetryExhaustedError', async () => {
    vi.useFakeTimers();

    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw makeHttpError(400);
      },
      {
        maxAttempts: 5,
        wrapError: true,
      }
    );

    await expect(p).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(1);
  });
});

describe('createRetry', () => {
  it('applies default options and allows per-call overrides (shallow merge)', async () => {
    vi.useFakeTimers();

    const r = createRetry({ maxAttempts: 3, baseMs: 1000, rng: () => 0.5 });

    let calls = 0;
    const p = r(async () => {
      calls++;
      throw new Error('fail');
    }, { maxAttempts: 1, wrapError: true });

    await expect(p).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(1);
  });
});
