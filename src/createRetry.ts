/**
 * @file createRetry.ts
 * @description createRetry(defaultOptions) -> retryFn(task, perCallOptions?)
 */

import type { RetryContext, RetryOptions } from './types';
import { retry } from './retry';

export type RetryFn = <T>(
  task: (ctx: RetryContext) => T | Promise<T>,
  options?: RetryOptions
) => Promise<T>;

/**
 * Create a retry function with default options.
 *
 * Per-call options shallowly override the default options.
 */
export function createRetry(defaultOptions: RetryOptions = {}): RetryFn {
  return async function retryFn<T>(
    task: (ctx: RetryContext) => T | Promise<T>,
    options: RetryOptions = {}
  ): Promise<T> {
    return retry(task, { ...defaultOptions, ...options });
  };
}
