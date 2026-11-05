/** Timeouts and bounded retries around external calls. Never throws for a slow or failing call. */
import { err, type DomainError, type Result } from "../../domain/shared/result";
import type { Timers } from "./ports";

type Service = "github" | "slack" | "llm";

/**
 * Races `call` against a deadline; a timeout or a throw becomes a retryable `upstream` error. The
 * timer is always released. `call` gets an `AbortSignal` that is aborted when the deadline
 * passes, so a port that takes one (the LLM ports) cancels the in-flight request instead of
 * leaving it running; a port that ignores it is abandoned, as before.
 */
export async function withDeadline<T>(
  timers: Timers,
  ms: number,
  service: Service,
  call: (signal: AbortSignal) => Promise<Result<T>>,
): Promise<Result<T>> {
  const controller = new AbortController();
  const deadline = timers.deadline(ms);
  const timeout = deadline.done.then((): Result<T> => {
    controller.abort(new DeadlineExceeded(service, ms));
    return err({ kind: "upstream", service, retryable: true });
  });
  try {
    return await Promise.race([
      call(controller.signal).catch((): Result<T> =>
        err({ kind: "upstream", service, retryable: true }),
      ),
      timeout,
    ]);
  } finally {
    deadline.cancel();
  }
}

/** The abort reason of a `withDeadline` signal. Carries no request data. */
export class DeadlineExceeded extends Error {
  constructor(
    readonly service: Service,
    readonly ms: number,
  ) {
    super(`${service} call exceeded its ${ms} ms deadline`);
    this.name = "DeadlineExceeded";
  }
}

export const isTransient = (e: DomainError): boolean =>
  e.kind === "rate_limited" || (e.kind === "upstream" && e.retryable);

export type RetryPolicy = { attempts: number; baseMs: number; maxMs: number; timeoutMs: number };

/** Up to `attempts` tries of a transient failure, exponential backoff, `Retry-After` honoured. */
export async function withRetry<T>(
  timers: Timers,
  policy: RetryPolicy,
  service: Service,
  call: () => Promise<Result<T>>,
): Promise<Result<T>> {
  let last: Result<T> = err({ kind: "upstream", service, retryable: true });
  for (let attempt = 1; attempt <= Math.max(1, policy.attempts); attempt++) {
    last = await withDeadline(timers, policy.timeoutMs, service, call);
    if (last.ok || !isTransient(last.error) || attempt >= policy.attempts) return last;
    const backoff = Math.min(policy.maxMs, policy.baseMs * 2 ** (attempt - 1));
    const retryAfter = last.error.kind === "rate_limited" ? last.error.retryAfterMs : 0;
    await timers.sleep(Math.min(policy.maxMs, Math.max(backoff, retryAfter)));
  }
  return last;
}
