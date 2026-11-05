import type { HttpErrorBody } from "../server/errors";

/**
 * What a server function returns. Errors are data, not throws, so the client always gets the
 * kind and request id; the message is the fixed public text (S4).
 */
export type FnResult<T> = { ok: true; value: T } | { ok: false; error: HttpErrorBody };
