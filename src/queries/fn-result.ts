import type { FnResult } from "../functions/fn-result";
import type { HttpErrorBody } from "../server/errors";

/** A failed server function call, as seen by queries and mutations. */
export class FnRequestError extends Error {
  readonly kind: HttpErrorBody["kind"];
  readonly requestId: string;

  constructor(body: HttpErrorBody) {
    super(body.message);
    this.name = "FnRequestError";
    this.kind = body.kind;
    this.requestId = body.requestId;
  }
}

/** Turns an error-as-data result into a value or a thrown `FnRequestError` for TanStack Query. */
export function unwrapFnResult<T>(result: FnResult<T>): T {
  if (result.ok) return result.value;
  throw new FnRequestError(result.error);
}
