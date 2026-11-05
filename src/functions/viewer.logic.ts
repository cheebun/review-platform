import type { AuthPort } from "../ports/auth";

export interface Viewer {
  email: string;
}

/**
 * The signed-in user for page guards, or null. Reads the session cookie only: a Bearer header
 * is ignored and a machine actor is never a viewer. Exposes the email and nothing else.
 */
export async function loadViewer(headers: Headers, auth: AuthPort): Promise<Viewer | null> {
  const actor = await auth.getSessionActor(headers);
  return actor?.kind === "user" ? { email: actor.email } : null;
}
