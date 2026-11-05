import type { Actor } from "../../domain/shared/actor";
import { err, ok, type DomainError, type Result } from "../../domain/shared/result";
import type { AuthPort } from "../../ports/auth";

export interface ResolveActorInput {
  headers: Headers;
  auth: AuthPort;
}

const UNAUTHENTICATED = { kind: "unauthenticated" } as const;

/**
 * Resolves who is calling: the session cookie is the only credential.
 *
 * Fail closed: any `Authorization` header is rejected outright and the session is not consulted,
 * so a header is never rescued by a cookie.
 */
export async function resolveActor(i: ResolveActorInput): Promise<Result<Actor, DomainError>> {
  if (i.headers.has("authorization")) return err(UNAUTHENTICATED);
  const actor = await i.auth.getSessionActor(i.headers);
  return actor ? ok(actor) : err(UNAUTHENTICATED);
}
