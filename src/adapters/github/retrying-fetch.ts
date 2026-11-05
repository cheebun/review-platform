export type RetryOptions = {
  /** Extra attempts after the first. Default 2. */
  maxRetries?: number;
  /** Backoff for 5xx and network errors: baseDelayMs * 2^attempt. Default 500 ms. */
  baseDelayMs?: number;
  /** Longest secondary-rate-limit wait honoured in-process; longer waits are returned. Default 10 s. */
  maxWaitMs?: number;
};

export type RetryingFetchOptions = {
  timeoutMs: number;
  retry?: RetryOptions;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULTS = { maxRetries: 2, baseDelayMs: 500, maxWaitMs: 10_000 } as const;

const methodOf = (input: string | URL | Request, init?: RequestInit) =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

const urlOf = (input: string | URL | Request) =>
  input instanceof Request ? input.url : String(input);

/**
 * A request may be repeated after a 5xx or a dropped connection only when repeating it cannot
 * change anything: reads, and GraphQL POSTs (this adapter sends queries only). Writes such as a
 * merge or a review may already have taken effect when the response is lost.
 */
function isIdempotent(input: string | URL | Request, init?: RequestInit): boolean {
  const method = methodOf(input, init);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  if (method !== "POST") return false;
  try {
    return new URL(urlOf(input)).pathname.endsWith("/graphql");
  } catch {
    return false;
  }
}

/**
 * Secondary rate limits carry `retry-after` and are rejected before GitHub does any work, so any
 * method may be retried. A primary limit (`x-ratelimit-remaining: 0`) is never waited out here.
 */
function secondaryWaitMs(response: Response): number | null {
  if (response.status !== 403 && response.status !== 429) return null;
  if (response.headers.get("x-ratelimit-remaining") === "0") return null;
  const raw = response.headers.get("retry-after");
  if (raw == null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : null;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is being thrown away; a failure to cancel it changes nothing.
  }
}

/** fetch with a per-attempt timeout and bounded, method-aware retries. */
export function retryingFetch(options: RetryingFetchOptions) {
  const maxRetries = Math.max(0, Math.trunc(options.retry?.maxRetries ?? DEFAULTS.maxRetries));
  const baseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? DEFAULTS.baseDelayMs);
  const maxWaitMs = Math.max(0, options.retry?.maxWaitMs ?? DEFAULTS.maxWaitMs);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const idempotent = isIdempotent(input, init);
    for (let attempt = 0; ; attempt++) {
      const canRetry = attempt < maxRetries;
      // Resolve global fetch at call time (msw patches it) and bound every attempt.
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await globalThis.fetch(input, { ...init, signal });
      } catch (error) {
        if (init?.signal?.aborted || !idempotent || !canRetry) throw error;
        await options.sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      if (!canRetry) return response;
      const wait = secondaryWaitMs(response);
      if (wait != null) {
        if (wait > maxWaitMs) return response;
        await discard(response);
        await options.sleep(wait);
        continue;
      }
      if (idempotent && (response.status >= 500 || response.status === 408)) {
        await discard(response);
        await options.sleep(baseDelayMs * 2 ** attempt);
        continue;
      }
      return response;
    }
  };
}
