import type { Actor } from "../domain/shared/actor";
import type { Result } from "../domain/shared/result";

export interface AuthPort {
  /** Resolves the signed-in user from the session cookie in `headers`, or null. */
  getSessionActor(headers: Headers): Promise<Actor | null>;
  /** The better-auth HTTP handler, mounted by the catch-all `/api/auth/*` route. */
  handler(request: Request): Promise<Response>;
  /**
   * Signs the owner in after the login token was checked: makes sure the single internal owner
   * user exists, creates a session and sets its cookie on the current response.
   */
  signInOwner(headers: Headers): Promise<void>;
  /** Expires the session cookie on the current response. */
  clearSessionCookie(headers: Headers): Promise<void>;
  /**
   * In ONE transaction: replaces the login token hash (stamping `rotated_at`) and deletes every
   * session, so both commit or neither does. `not_found login_token` before initialization.
   */
  rotateLoginToken(hash: string): Promise<Result<void>>;
}
