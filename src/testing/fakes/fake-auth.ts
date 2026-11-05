import type { Actor } from "../../domain/shared/actor";
import { err, type Result } from "../../domain/shared/result";
import type { AuthPort } from "../../ports/auth";
import { LOGIN_TOKEN_NOT_FOUND, type LoginTokenStore } from "../../ports/login-token-store";

/** Session cookie name the fake understands: `fake-session=<token>`. */
export const FAKE_SESSION_COOKIE = "fake-session";

/** The actor of every session `signInOwner` issues. */
export const FAKE_OWNER: Actor = {
  kind: "user",
  userId: "owner",
  email: "owner@agent-ops.invalid",
};

export class FakeAuth implements AuthPort {
  private readonly sessions = new Map<string, Actor>();
  readonly requests: Request[] = [];
  /** Owner sign-ins, in order: the headers each one was issued for. */
  readonly signIns: Headers[] = [];
  /** How many times the session cookie was expired. */
  cookieClears = 0;

  /** `loginTokens`: the store `rotateLoginToken` writes to, as the real port does in its transaction. */
  constructor(private readonly opts: { loginTokens?: LoginTokenStore } = {}) {}

  /** Registers a session and returns the headers a browser would send. */
  addSession(token: string, actor: Actor): Headers {
    this.sessions.set(token, actor);
    return new Headers({ cookie: `${FAKE_SESSION_COOKIE}=${token}` });
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  async getSessionActor(headers: Headers): Promise<Actor | null> {
    const cookie = headers.get("cookie") ?? "";
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === FAKE_SESSION_COOKIE) return this.sessions.get(rest.join("=")) ?? null;
    }
    return null;
  }

  async handler(request: Request): Promise<Response> {
    this.requests.push(request);
    return new Response(null, { status: 204 });
  }

  async signInOwner(headers: Headers): Promise<void> {
    this.signIns.push(headers);
    this.sessions.set(`owner-${this.signIns.length}`, FAKE_OWNER);
  }

  async clearSessionCookie(): Promise<void> {
    this.cookieClears += 1;
  }

  async rotateLoginToken(hash: string): Promise<Result<void>> {
    if (!this.opts.loginTokens) return err(LOGIN_TOKEN_NOT_FOUND);
    const rotated = await this.opts.loginTokens.rotate(hash);
    if (rotated.ok) this.sessions.clear();
    return rotated;
  }
}
