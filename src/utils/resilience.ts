import { logger } from './logger.js';

/**
 * Race a promise against a timeout. Rejects with a descriptive error if ms elapses first.
 * Clears the internal timer regardless of which side wins, preventing Node from staying alive.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'Operation'): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer!)),
    timeout,
  ]);
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelay?: number;
  maxDelay?: number;
  label?: string;
  /** Called before each retry with (attemptNumber, totalAttempts, error, delayMs) */
  onRetry?: (attempt: number, total: number, error: Error, delayMs: number) => void;
}

const RETRIABLE = /timeout|timed out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network|50[234]|429/i;

/**
 * Retry fn with exponential backoff + jitter on transient errors.
 * Non-retriable errors (4xx except 429, logic errors) are re-thrown immediately.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, initialDelay = 1_000, maxDelay = 15_000, label = 'Operation', onRetry } = options;
  let lastError!: Error;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      const isRetriable = RETRIABLE.test(lastError.message);
      if (!isRetriable || attempt === maxAttempts - 1) throw lastError;
      const jitter = Math.random() * 500;
      const delay = Math.min(initialDelay * Math.pow(2, attempt) + jitter, maxDelay);
      onRetry?.(attempt + 1, maxAttempts, lastError, Math.round(delay));
      logger.debug(`${label}: attempt ${attempt + 1} failed ("${lastError.message}"), retrying in ${Math.round(delay)}ms…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw lastError;
}
