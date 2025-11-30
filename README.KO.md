# @selentia/async-retry

<p align="center">
  <img src="https://img.shields.io/badge/coverage-100%25%20stmts%20%7C%2096.6%25%20branches-brightgreen" />
  <img src="https://img.shields.io/badge/dependencies-0-lightgrey" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" />
</p>

런타임 의존성이 없는 재시도 정책 라이브러리입니다.  
**지수 백오프**, **Retry-After** 처리, **AbortSignal** 연동, full jitter,  
그리고 전체 재시도 경과 시간 제한(**maxElapsedMs**)을 지원합니다.  
Node.js 18 이상 및 최신 브라우저에서 동작합니다.

> 본 라이브러리는 2,500개 이상의 서버에서 운영되는 Discord 봇 [Pastellink](https://pastellink.duna.me)에서 실제로 사용되고 있습니다.

📄 **다른 언어**:
- [🇺🇸 English](./README.md)

---

## 목차
- [설치](#설치)
- [빠른 시작](#빠른-시작)
  - [`retry`](#retry)
  - [`createRetry`](#createretry)
- [API](#api)
  - [`retry(task, options?) → Promise<T>`](#retrytask-options--promiset)
  - [`createRetry(defaultOptions) → (task, overrides?) => Promise<T>`](#createretrydefaultoptions--task-overrides--promiset)
  - [옵션](#옵션)
  - [Retry-After 동작 원리](#retry-after-동작-원리)
  - [Abort / Timeout 동작 원리](#abort--timeout-동작-원리)
  - [오류](#오류)
  - [보장 사항](#보장-사항)
- [라이선스](#라이선스)

---

## 설치

```bash
npm i @selentia/async-retry
```

---

## 빠른 시작

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

`createRetry()`는 기본 **옵션을 미리 적용**해 두고, 호출 시점에 **필요한 옵션만 덮어쓸 수 있게** 해줍니다.

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
    // 호출별 덮어쓰기(얕은 병합)
    maxElapsedMs: 10_000,
  },
);
```

---

## API

### `retry(task, options?) → Promise<T>`

`task`는 `RetryContext`를 인자로 받습니다:

```ts
await retry(async (ctx) => {
  ctx.attempt;      // 1..maxAttempts
  ctx.maxAttempts;  // 최대 시도 횟수
  ctx.startedAt;    // retry() 시작 시각(epoch ms)
  ctx.elapsedMs;    // startedAt 이후 경과 시간(ms, 정수)
  ctx.signal;       // AbortSignal (지정한 경우)
  return 'ok';
});
```

---

### `createRetry(defaultOptions) → (task, overrides?) => Promise<T>`

`retry`와 동일한 시그니처의 함수를 반환하며, 호출 시 `defaultOptions`를 먼저 적용합니다.
`overrides`는 `{ ...defaultOptions, ...overrides }` 형태로 **얕게 병합**되므로, 중첩 객체는 deep-merge되지 않습니다.

---

## 옵션

아래 기본값이 내부적으로 적용됩니다:

| 옵션 | 타입 | 기본값 | 설명 |
|--------|------|---------|-------------|
| `maxAttempts` | `number` | `3` | 첫 호출을 포함한 전체 시도 횟수입니다. 1 이상의 정수여야 합니다. |
| `baseMs` | `number` | `200` | 기본 backoff(ms)입니다. 0 이상 유한값이어야 합니다. |
| `capMs` | `number` | `2000` | backoff 상한(ms)입니다. 0 이상 유한값이어야 합니다. |
| `factor` | `number` | `2` | 지수 증가 계수입니다. 0보다 큰 유한값이어야 합니다. |
| `jitter` | `'full' \| 'none'` | `'full'` | full jitter는 `[0, backoff)` 범위에서 지연 시간을 무작위로 선택합니다. |
| `rng` | `() => number` | `Math.random` | jitter에 사용할 난수 함수입니다. 유한하지 않은 값은 `0`으로 처리됩니다. |
| `signal` | `AbortSignal` | `undefined` | 재시도 전체 루프(대기 포함)를 중단합니다. |
| `maxElapsedMs` | `number` | `undefined` | 전체 시간 예산(ms)입니다. 각 시도 시작 전과 대기 직전에 검사됩니다. |
| `shouldRetry` | `(err, ctx) => boolean \| Promise<boolean>` | `defaultShouldRetry` | 오류가 재시도 대상인지 판단합니다. |
| `onRetry` | `(event) => void` | `undefined` | 대기 직전에 호출되는 훅입니다. |
| `wrapError` | `boolean` | `false` | true면 소진/비재시도 종료를 `RetryExhaustedError`로 감싸서 던집니다. |
| `respectRetryAfter` | `boolean` | `true` | true면 `429`에서 `Retry-After`를 존중합니다. |
| `retryAfterHeaderName` | `string` | `'retry-after'` | 헤더 이름(대소문자 구분 없음)입니다. 공백은 제거되며, 비어 있으면 기본값으로 되돌아갑니다. |
| `retryAfterBodyUnit` | `false \| 'seconds' \| 'milliseconds'` | `false` | 헤더가 없을 때 응답 본문의 `retry_after`를 읽을지, 읽는다면 단위를 무엇으로 볼지 지정합니다. |

---

## Retry-After 동작 원리

`status === 429`이고 `respectRetryAfter === true`인 경우:

1) 먼저 **Retry-After 헤더**를 확인합니다(키 매칭은 대소문자 구분 없음).
- 숫자 값은 **seconds**로 간주합니다.
- HTTP-date는 파싱한 뒤 `max(0, date - now)`를 계산하여 ms로 변환합니다.

2) 유효한 헤더가 없고 `retryAfterBodyUnit !== false`인 경우, 응답 본문 값을 사용합니다.
- `retry_after`는 다음 순서로 확인합니다: `err.response.data.retry_after`, `err.rawError.retry_after`, `err.data.retry_after`
- 문자열/숫자는 파싱되며, 단위는 `retryAfterBodyUnit`으로 결정됩니다.

헤더/본문 모두에서 유효한 지연 시간을 얻지 못하면 일반 지수 백오프로 폴백합니다.

`onRetry(event)`에서 `event.reason` 값은 다음과 같습니다:
- Retry-After를 사용한 경우: `'retry-after'`
- 지수 백오프를 사용한 경우: `'backoff'`

---

## Abort / Timeout 동작 원리

- `signal`이 시도 시작 전에 이미 중단된 상태라면, `retry()`는 `AbortError`를 던지고 `task`를 호출하지 않습니다.
- 대기 중 중단되면 대기가 즉시 끊기며 `AbortError`가 발생합니다.
- `task`가 “abort 계열 오류”(`name === 'AbortError'` 또는 `code === 'ABORT_ERR'` / `code === 'ERR_CANCELED'`)를 던지면, 즉시 전파되며 재시도하지 않습니다.
- `maxElapsedMs`는 다음 시점에 강제됩니다:
  - 각 시도 시작 전
  - 대기 직전(긴 대기 때문에 예산이 초과되지 않도록)

---

### 오류

다음 오류들은 `instanceof`로 구분해 처리할 수 있습니다.

| 오류 | 발생 조건 |
|------|----------------|
| `AbortError` | 재시도 루프가 중단된 경우(시도 시작 전 또는 대기 중). |
| `RetryTimeoutError` | `maxElapsedMs` 예산을 초과한 경우(시도 시작 전 또는 대기 직전). |
| `RetryExhaustedError` | `wrapError=true`이며, 최대 횟수 소진 또는 비재시도 판단으로 루프가 종료된 경우(원본 오류는 `cause`). |

예시:

```ts
import { retry } from '@selentia/async-retry';
import { AbortError, RetryTimeoutError, RetryExhaustedError } from '@selentia/async-retry/errors';

try {
  await retry(async () => {
    // ...
  }, { maxElapsedMs: 2000, wrapError: true });
} catch (err) {
  if (err instanceof AbortError) {
    // signal에 의해 중단됨
  } else if (err instanceof RetryTimeoutError) {
    // 예산 초과
  } else if (err instanceof RetryExhaustedError) {
    // 소진 또는 비재시도 (원본 오류는 `err.cause`로 확인)
  }
}
```

---

## 보장 사항

- 시도 횟수는 1부터 시작합니다(첫 호출은 `attempt = 1`).
- `maxAttempts`는 절대 초과되지 않습니다.
- `onRetry()`는 **실제로 재시도가 예정된 경우에만** 호출되며, 호출 시점은 **대기 직전**입니다.
- `Retry-After`를 사용하는 경우 jitter는 적용되지 않으며, 지연 시간은 받은 값을 그대로 사용합니다(0 이상의 정수 ms로 보정).
- 모든 지연 시간은 0 이상의 정수 밀리초(ms)로 보정됩니다.

---

## 라이선스

MIT
