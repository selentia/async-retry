/**
 * @file retry.coverage.test.ts
 * @description Branch/edge coverage tests for the retry policy engine.
 *
 * These tests are separated from public-behavior tests to:
 * - Ensure internal guard branches and parsing fallbacks remain stable
 * - Explicitly exercise branch coverage for V8

 *
 * Notes
 *  - Fake timers are used for deterministic retry delays.
 *  - When using fake timers, the assertion promise is usually created first,
 *    then timers are advanced, to avoid unhandled rejections.
 *  - `vi.restoreAllMocks()` is called after each test to avoid cross-test leakage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultShouldRetry, retry } from '../src/retry';
import { AbortError, RetryTimeoutError } from '../src/errors';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------------------------------
 *  INPUT VALIDATION / OPTION NORMALIZATION
 * ---------------------------------------------------------------------------------------------- */
describe('retry (coverage)', () => {
  it('throws RangeError for invalid maxAttempts', async () => {
    await expect(retry(async () => 'ok', { maxAttempts: 0 as any })).rejects.toBeInstanceOf(RangeError);
    await expect(retry(async () => 'ok', { maxAttempts: 1.2 as any })).rejects.toBeInstanceOf(RangeError);
    await expect(retry(async () => 'ok', { maxAttempts: Number.NaN as any })).rejects.toBeInstanceOf(RangeError);
  });

  it('throws RangeError for invalid baseMs/capMs/factor/maxElapsedMs', async () => {
    await expect(retry(async () => 'ok', { baseMs: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(retry(async () => 'ok', { capMs: -1 })).rejects.toBeInstanceOf(RangeError);
    await expect(retry(async () => 'ok', { factor: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(retry(async () => 'ok', { maxElapsedMs: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  /* ------------------------------------------------------------------------------------------------
   *  CLOCK EDGE CASES
   * -------------------------------------------------------------------------------------------- */
  it('handles non-finite clock readings (toIntMs non-finite path)', async () => {
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(Number.NaN as any)
      .mockImplementation(() => realNow());

    await expect(retry(() => 'ok')).resolves.toBe('ok');
  });

  /* ------------------------------------------------------------------------------------------------
   *  ABORT / CANCELLATION BEHAVIOR
   * -------------------------------------------------------------------------------------------- */
  it('propagates abort-like error thrown by task without retrying', async () => {
    let calls = 0;
    const abrt = { code: 'ABORT_ERR' };

    const p = retry(
      async () => {
        calls++;
        throw abrt;
      },
      { maxAttempts: 3 }
    );

    await expect(p).rejects.toBe(abrt);
    expect(calls).toBe(1);
  });

  it('when maxAttempts is reached and wrapError is false, throws original error', async () => {
    const err = new Error('fail');
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw err;
      },
      { maxAttempts: 1 }
    );

    await expect(p).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it('when shouldRetry returns false and wrapError is false, throws original error immediately', async () => {
    const err = new Error('fail');
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw err;
      },
      {
        maxAttempts: 3,
        shouldRetry: async () => false,
      }
    );

    await expect(p).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  /* ------------------------------------------------------------------------------------------------
   *  STATUS / CODE PARSING (defaultShouldRetry + getStatus/getCode paths)
   * -------------------------------------------------------------------------------------------- */
  it('retries on status provided as string (getStatus string path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: '503' } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 10,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(10);
    await asrt;

    expect(calls).toBe(2);
    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(10);
  });

  it('retries on retriable error code (getCode + DEFAULT_RETRIABLE_CODES path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw { code: 'ECONNRESET' };
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 5,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(5);
    await asrt;

    expect(calls).toBe(2);
    expect(events[0].reason).toBe('backoff');
  });

  /* ------------------------------------------------------------------------------------------------
   *  sleep() SAFETY (abort handlers / finish() paths)
   * -------------------------------------------------------------------------------------------- */
  it('abort during sleep uses AbortError (addAbortHandler path)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 3,
        baseMs: 100,
        jitter: 'none' as any,
        signal: ac.signal,
      }
    );

    const asrt = expect(p).rejects.toBeInstanceOf(AbortError);
    await vi.advanceTimersByTimeAsync(50);
    ac.abort();
    await vi.advanceTimersByTimeAsync(1000);
    await asrt;

    expect(calls).toBe(1);
  });

  it('sleep resolves with signal when not aborted (finish resolve path)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('fail');
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 25,
        jitter: 'none' as any,
        signal: ac.signal,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(25);
    await asrt;

    expect(calls).toBe(2);
    expect(events[0].delayMs).toBe(25);
  });

  /* ------------------------------------------------------------------------------------------------
   *  defaultShouldRetry INTERNAL GUARDS
   * -------------------------------------------------------------------------------------------- */
  it('defaultShouldRetry returns false when ctx.signal is already aborted', () => {
    const ac = new AbortController();
    ac.abort();
    expect(defaultShouldRetry(new Error('x'), { signal: ac.signal } as any)).toBe(false);
  });

  it('defaultShouldRetry returns false for abort-like error', () => {
    expect(defaultShouldRetry({ name: 'AbortError' }, {} as any)).toBe(false);
    expect(defaultShouldRetry({ code: 'ERR_CANCELED' }, {} as any)).toBe(false);
  });

  it('defaultShouldRetry tolerates non-string message (getMessage non-string path)', () => {
    expect(defaultShouldRetry({ message: 123 }, {} as any)).toBe(true);
  });

  it('defaultShouldRetry retries TypeError with network-ish message', () => {
    expect(defaultShouldRetry(new TypeError('NetworkError when attempting to fetch resource'), {} as any)).toBe(true);
  });

  /* ------------------------------------------------------------------------------------------------
   *  Retry-After HEADER PARSING (header variants + HTTP-date)
   * -------------------------------------------------------------------------------------------- */
  it('Retry-After header supports array value (getHeader array path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { 'Retry-After': ['2'] } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 123,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('Retry-After header supports HTTP-date (parseRetryAfterHeaderMs date path)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));

    let calls = 0;
    const events: any[] = [];
    const retryAfter = new Date(Date.now() + 1000).toUTCString();

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { 'retry-after': retryAfter } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 10,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(1500);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(1000);
  });

  it('Retry-After header with non-string value is ignored (getHeader return undefined path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { 'retry-after': 2 } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 70,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(70);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(70);
  });

  it('invalid Retry-After header falls back to backoff (parseRetryAfterHeaderMs undefined path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { 'retry-after': 'nonsense' } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 100,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(100);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(100);
  });

    it('Retry-After header supports fetch Headers-like object (get() string path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const fetchHeadersLike = {
      get: (key: string) => (key.toLowerCase() === 'retry-after' ? '2' : null),
    };

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: fetchHeadersLike } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 999,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('Headers-like get() non-string is ignored and falls back to backoff (get() non-string path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const fetchHeadersLike = {
      get: (_: string) => 123 as any, // non-string => ignored
    };

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: fetchHeadersLike } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 70,
        jitter: 'none' as any,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(70);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(70);
  });


  /* ------------------------------------------------------------------------------------------------
   *  Retry-After BODY PARSING (response.data / rawError / top-level data)
   * -------------------------------------------------------------------------------------------- */
  it('Retry-After body is used when enabled and header is missing (readRetryAfterBody/parseRetryAfterBodyMs path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: { retry_after: '2' } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 100,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'seconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('Retry-After body supports numeric value (parseRetryAfterBodyMs number path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: { retry_after: 1500 } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 40,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'milliseconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(1500);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(1500);
  });

  it('Retry-After body non-primitive falls back to backoff (parseRetryAfterBodyMs NaN path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: { retry_after: {} } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 55,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'milliseconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(55);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(55);
  });

  it('Retry-After body parse failure falls back to backoff', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: { retry_after: 'nope' } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 80,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'seconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(80);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(80);
  });

  it('whitespace retryAfterHeaderName falls back to default (normalizeOptions trim fallback)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, headers: { 'retry-after': '1' } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 999,
        jitter: 'none' as any,
        retryAfterHeaderName: '   ',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(1000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(1000);
  });

  /* ------------------------------------------------------------------------------------------------
   *  BACKOFF / JITTER EDGE CASES
   * -------------------------------------------------------------------------------------------- */
  it('rng returning non-finite results in 0 jitter delay (applyFullJitter non-finite rng path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw new Error('fail');
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 100,
        capMs: 100,
        jitter: 'full',
        rng: () => Number.NaN,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.runAllTimersAsync();
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(0);
  });

  it('respectRetryAfter=false ignores Retry-After header and uses backoff', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) throw { response: { status: 429, headers: { 'retry-after': '2' } } };
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 40,
        jitter: 'none' as any,
        respectRetryAfter: false,
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(40);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(40);
  });

  /* ------------------------------------------------------------------------------------------------
   *  maxElapsedMs BUDGET GUARDS
   * -------------------------------------------------------------------------------------------- */
  it('maxElapsedMs can timeout before the first attempt (pre-attempt budget path)', async () => {
    const realNow = Date.now.bind(Date);
    let calls = 0;

    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(0 as any)
      .mockReturnValueOnce(10 as any)
      .mockImplementation(() => realNow());

    await expect(
      retry(async () => {
        calls++;
        return 'ok';
      }, { maxElapsedMs: 5 })
    ).rejects.toBeInstanceOf(RetryTimeoutError);

    expect(calls).toBe(0);
  });

  /* ------------------------------------------------------------------------------------------------
   *  ADDITIONAL COVERAGE-ONLY CASES (rare branches, practical in production)
   * -------------------------------------------------------------------------------------------- */
  it('accepts undefined maxElapsedMs (assertFiniteNonNegative n==null path)', async () => {
    await expect(retry(async () => 'ok', { maxAttempts: 1 })).resolves.toBe('ok');
  });

  it('abort before zero-delay sleep throws AbortError (sleep waitMs===0 pre-check path)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 3,
        baseMs: 0,
        jitter: 'none' as any,
        signal: ac.signal,
        onRetry: () => ac.abort(),
      }
    );

    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
  });

  it('abort during zero-delay sleep throws AbortError (sleep waitMs===0 post-yield path)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 3,
        baseMs: 0,
        jitter: 'none' as any,
        signal: ac.signal,
        onRetry: () => {
          setTimeout(() => ac.abort(), 0);
        },
      }
    );

    const asrt = expect(p).rejects.toBeInstanceOf(AbortError);
    await vi.runAllTimersAsync();
    await asrt;

    expect(calls).toBe(1);
  });

  it('abort before positive-delay sleep throws AbortError (sleep signal.aborted path)', async () => {
    vi.useFakeTimers();

    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        throw new Error('fail');
      },
      {
        maxAttempts: 3,
        baseMs: 10,
        jitter: 'none' as any,
        signal: ac.signal,
        onRetry: () => ac.abort(),
      }
    );

    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
  });

  it('aborted inside task throws AbortError via catch abort gate (opts.signal aborted path)', async () => {
    const ac = new AbortController();
    let calls = 0;

    const p = retry(
      async () => {
        calls++;
        ac.abort();
        throw new Error('fail');
      },
      {
        maxAttempts: 3,
        baseMs: 10,
        jitter: 'none' as any,
        signal: ac.signal,
      }
    );

    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
  });

  it('Retry-After body uses rawError.retry_after when response.data is missing it (readRetryAfterBody rawError path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: {} }, rawError: { retry_after: '2' } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 999,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'seconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('Retry-After body uses top-level data.retry_after (readRetryAfterBody data path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429 }, data: { retry_after: '2' } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 777,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'seconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(2000);
    await asrt;

    expect(events[0].reason).toBe('retry-after');
    expect(events[0].delayMs).toBe(2000);
  });

  it('Retry-After body null is ignored and falls back to backoff (parseRetryAfterBodyMs value==null path)', async () => {
    vi.useFakeTimers();

    let calls = 0;
    const events: any[] = [];

    const p = retry(
      async () => {
        calls++;
        if (calls === 1) {
          throw { response: { status: 429, data: { retry_after: null } } };
        }
        return 'ok';
      },
      {
        maxAttempts: 2,
        baseMs: 33,
        jitter: 'none' as any,
        retryAfterBodyUnit: 'seconds',
        onRetry: (e) => events.push(e),
      }
    );

    const asrt = expect(p).resolves.toBe('ok');
    await vi.advanceTimersByTimeAsync(33);
    await asrt;

    expect(events[0].reason).toBe('backoff');
    expect(events[0].delayMs).toBe(33);
  });
});
