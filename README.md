# @selentia/async-retry

<p align="center">
  <img src="https://img.shields.io/badge/coverage-100%25%20stmts%20%7C%2096.6%25%20branches-brightgreen" />
  <img src="https://img.shields.io/badge/dependencies-0-lightgrey" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" />
</p>

A zero-dependency retry policy library for Node.js and browsers.  
It supports **exponential backoff**, **Retry-After** handling, **AbortSignal** integration, full jitter,  
and an overall max elapsed time limit via **maxElapsedMs**. Runs on Node.js ≥18 and modern browsers.

> Used in production by [Pastellink](https://pastellink.duna.me), a Discord bot trusted by 2,500+ servers.

📄 **Other languages**:
- [🇰🇷 한국어 문서](./README.KO.md)

---

## Table of Contents
- [Install](#install)
- [Quick Start](#quick-start)
  - [`retry`](#retry)
  - [`createRetry`](#createretry)
- [API](#api)
  - [`retry(task, options?) → Promise<T>`](#retrytask-options--promiset)
  - [`createRetry(defaultOptions) → (task, overrides?) => Promise<T>`](#createretrydefaultoptions--task-overrides--promiset)
  - [Options](#options)
  - [Retry-After semantics](#retry-after-semantics)
  - [Abort & Timeout semantics](#abort--timeout-semantics)
  - [Errors](#errors)
  - [Guarantees](#guarantees)
- [License](#license)

---

## Install

```bash
npm i @selentia/async-retry
```

---

## Quick Start

### `retry`

```ts
import { retry } from '@selentia/async-retry';

const data = await retry(async ({ attempt }) => {
  const res = await fetch('/api/data');
  if (!res.ok) throw new Error(`HTTP ${res.status} (attempt=${attempt})`);
  return res.json();
});
```

### `createRetry`

`createRetry()` applies **default options** and supports per-call **overrides**.

```ts
import { createRetry } from '@selentia/async-retry';

const retryFetch = createRetry({
  maxAttempts: 5,
  baseMs: 200,
  capMs: 4000,
  jitter: 'full',
});

const json = await retryFetch(
  async () => {
    const r = await fetch('/api/data');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  },
  {
    // per-call overrides (shallow merge)
    maxElapsedMs: 10_000,
  },
);
```

---

## API

### `retry(task, options?) → Promise<T>`

`task` receives a `RetryContext`:

```ts
await retry(async (ctx) => {
  ctx.attempt;      // 1..maxAttempts
  ctx.maxAttempts;  // max attempts
  ctx.startedAt;    // epoch ms when retry() started
  ctx.elapsedMs;    // elapsed ms since startedAt (int)
  ctx.signal;       // AbortSignal (if provided)
  return 'ok';
});
```

---

### `createRetry(defaultOptions) → (task, overrides?) => Promise<T>`

Returns a `retry`-compatible function that applies `defaultOptions` first.
Overrides are merged shallowly (`{ ...defaultOptions, ...overrides }`), so nested objects are not deep-merged.

---

## Options

The following defaults are applied:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | Total attempts including the first call. Must be an integer ≥ 1. |
| `baseMs` | `number` | `200` | Base backoff (ms). Must be finite ≥ 0. |
| `capMs` | `number` | `2000` | Backoff cap (ms). Must be finite ≥ 0. |
| `factor` | `number` | `2` | Exponential factor. Must be finite > 0. |
| `jitter` | `'full' \| 'none'` | `'full'` | Full jitter randomizes delay in `[0, backoff)`. |
| `rng` | `() => number` | `Math.random` | Random source for jitter. Non-finite results are treated as `0`. |
| `signal` | `AbortSignal` | `undefined` | Aborts the entire retry loop (including sleep). |
| `maxElapsedMs` | `number` | `undefined` | Overall time budget (ms), checked before each attempt and before sleeping. |
| `shouldRetry` | `(err, ctx) => boolean \| Promise<boolean>` | `defaultShouldRetry` | Determines whether the error is retriable. |
| `onRetry` | `(event) => void` | `undefined` | Hook called immediately before sleeping. |
| `wrapError` | `boolean` | `false` | If true, wraps exhausted/non-retriable failures into `RetryExhaustedError`. |
| `respectRetryAfter` | `boolean` | `true` | If true, respects `Retry-After` for `429`. |
| `retryAfterHeaderName` | `string` | `'retry-after'` | Header name (case-insensitive). Whitespace is trimmed; empty falls back to default. |
| `retryAfterBodyUnit` | `false \| 'seconds' \| 'milliseconds'` | `false` | If enabled, reads `retry_after` from the response body when the header is missing. |

---

## Retry-After semantics

When `status === 429` and `respectRetryAfter === true`:

1) The **Retry-After header** is checked first (case-insensitive key match).
- Numeric values are treated as **seconds**.
- HTTP-date values are parsed and converted to `max(0, date - now)` in ms.

2) If there is no usable header and `retryAfterBodyUnit !== false`, a body value is used:
- Reads `retry_after` in the following order: `err.response.data.retry_after`, `err.rawError.retry_after`, `err.data.retry_after`
- String/number values are parsed; the unit is controlled by `retryAfterBodyUnit`.

If neither yields a usable delay, it falls back to regular exponential backoff.

Within `onRetry(event)`, `event.reason` will be:
- `'retry-after'` when Retry-After is used
- `'backoff'` when exponential backoff is used

---

## Abort & Timeout semantics

- If `signal` is already aborted **before an attempt**, `retry()` throws `AbortError` and **does not call the task**.
- If aborted **during sleep**, sleep is interrupted and `AbortError` is thrown.
- If the task throws an “abort-like” error (`name === 'AbortError'` or `code === 'ABORT_ERR'` / `code === 'ERR_CANCELED'`), it is **propagated immediately** (no retries).
- `maxElapsedMs` is enforced:
  - before each attempt
  - and before sleeping (so a long delay cannot exceed the budget)

---

## Errors

These errors can be handled via `instanceof`.

| Error | When it occurs |
|------|----------------|
| `AbortError` | The retry loop is aborted (before an attempt or during sleep). |
| `RetryTimeoutError` | The `maxElapsedMs` budget is exceeded (before an attempt or before sleeping). |
| `RetryExhaustedError` | `wrapError=true` and the loop ends due to exhaustion or a non-retriable decision (the original error is available as `cause`). |

Example:

```ts
import { retry } from '@selentia/async-retry';
import { AbortError, RetryTimeoutError, RetryExhaustedError } from '@selentia/async-retry/errors';

try {
  await retry(async () => {
    // ...
  }, { maxElapsedMs: 2000, wrapError: true });
} catch (err) {
  if (err instanceof AbortError) {
    // aborted by signal
  } else if (err instanceof RetryTimeoutError) {
    // budget exceeded
  } else if (err instanceof RetryExhaustedError) {
    // exhausted or non-retriable (the original error is available as `err.cause`)
  }
}
```

---

## Guarantees

- Attempts are **1-indexed**: the first call is `attempt = 1`.
- `maxAttempts` is never exceeded.
- `onRetry()` is called **only** when a retry will actually happen, and it is called **before** sleeping.
- When `Retry-After` is used, jitter is **not** applied; the delay is taken as-is (normalized to a non-negative integer ms).
- All delays are normalized to integer milliseconds (`>= 0`).

---

## License

MIT
