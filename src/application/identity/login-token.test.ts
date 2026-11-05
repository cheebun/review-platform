import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../../domain/shared/actor";
import { FakeAuth } from "../../testing/fakes/fake-auth";
import { FakeClock } from "../../testing/fakes/fake-clock";
import { FakeLoginTokenHasher } from "../../testing/fakes/fake-login-token-hasher";
import { InMemoryAttemptLimiter } from "../../testing/fakes/in-memory-attempt-limiter";
import { InMemoryLoginTokenStore } from "../../testing/fakes/in-memory-login-token-store";
import { MemoryLogger } from "../../testing/fakes/memory-logger";
import {
  getSetupStatus,
  LOGIN_ATTEMPT_POLICY,
  loginAttemptKey,
  loginWithToken,
  rotateLoginToken,
  type LoginTokenDeps,
} from "./login-token";

const TOKEN = "correct horse battery";
const NEW_TOKEN = "new token 123";
const IP = "203.0.113.7";
const USER: Actor = { kind: "user", userId: "owner", email: "owner@agent-ops.invalid" };

let clock: FakeClock;
let auth: FakeAuth;
let loginTokens: InMemoryLoginTokenStore;
let attempts: InMemoryAttemptLimiter;
let hasher: FakeLoginTokenHasher;
let logger: MemoryLogger;
let deps: LoginTokenDeps;
const headers = new Headers();

beforeEach(() => {
  clock = new FakeClock();
  loginTokens = new InMemoryLoginTokenStore(clock);
  auth = new FakeAuth({ loginTokens });
  attempts = new InMemoryAttemptLimiter(clock);
  hasher = new FakeLoginTokenHasher();
  logger = new MemoryLogger();
  deps = { auth, loginTokens, attemptLimiter: attempts, loginTokenHasher: hasher, logger };
});

async function initialized(token = TOKEN) {
  await loginTokens.initialize(await hasher.hash(token));
}

/** No log entry may carry the token or the new token, in any field. */
function expectTokensNotLogged() {
  const dump = JSON.stringify(logger.entries);
  expect(dump).not.toContain(TOKEN);
  expect(dump).not.toContain(NEW_TOKEN);
}

describe("getSetupStatus", () => {
  it("reports whether the login token is initialized", async () => {
    expect(await getSetupStatus(deps)).toEqual({ initialized: false });
    await initialized();
    expect(await getSetupStatus(deps)).toEqual({ initialized: true });
  });
});

describe("loginWithToken", () => {
  it("is not_found login_token before setup, without counting an attempt", async () => {
    const result = await loginWithToken(deps, { token: TOKEN, ip: IP }, headers);
    expect(result).toEqual({ ok: false, error: { kind: "not_found", entity: "login_token" } });
    await initialized();
    for (let i = 0; i < LOGIN_ATTEMPT_POLICY.limit; i++) {
      expect((await loginWithToken(deps, { token: "wrong-token", ip: IP }, headers)).ok).toBe(
        false,
      );
    }
    // Five wrong tokens are allowed: the earlier not_found call used none of them.
    expect(await loginWithToken(deps, { token: TOKEN, ip: IP }, headers)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
  });

  it("signs the owner in with the right token", async () => {
    await initialized();
    expect(await loginWithToken(deps, { token: TOKEN, ip: IP }, headers)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(auth.signIns).toEqual([headers]);
    expectTokensNotLogged();
  });

  it("answers a wrong token with a generic unauthenticated error and no session", async () => {
    await initialized();
    const result = await loginWithToken(deps, { token: "wrong-token", ip: IP }, headers);
    expect(result).toEqual({ ok: false, error: { kind: "unauthenticated" } });
    expect(auth.signIns).toEqual([]);
  });

  it("treats a malformed token as a wrong token, without hinting at the rules", async () => {
    await initialized();
    for (const token of ["", " ", "abc", ` ${TOKEN}`]) {
      expect(await loginWithToken(deps, { token, ip: IP }, headers)).toEqual({
        ok: false,
        error: { kind: "unauthenticated" },
      });
    }
  });

  it("locks the IP out after 5 failures for 15 minutes, even for the right token", async () => {
    await initialized();
    for (let i = 0; i < 5; i++) {
      expect(await loginWithToken(deps, { token: "wrong-token", ip: IP }, headers)).toEqual({
        ok: false,
        error: { kind: "unauthenticated" },
      });
    }
    const locked = await loginWithToken(deps, { token: TOKEN, ip: IP }, headers);
    expect(locked).toEqual({
      ok: false,
      error: { kind: "rate_limited", retryAfterMs: 15 * 60_000 },
    });
    expect(auth.signIns).toEqual([]);

    // Another IP is unaffected.
    expect((await loginWithToken(deps, { token: TOKEN, ip: "198.51.100.1" }, headers)).ok).toBe(
      true,
    );

    clock.advance(15 * 60_000);
    expect((await loginWithToken(deps, { token: TOKEN, ip: IP }, headers)).ok).toBe(true);
  });

  it("resets the IP's failure count after a successful login", async () => {
    await initialized();
    for (let i = 0; i < 4; i++)
      await loginWithToken(deps, { token: "wrong-token", ip: IP }, headers);
    expect((await loginWithToken(deps, { token: TOKEN, ip: IP }, headers)).ok).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(await loginWithToken(deps, { token: "wrong-token", ip: IP }, headers)).toEqual({
        ok: false,
        error: { kind: "unauthenticated" },
      });
    }
  });

  it("buckets callers without a known IP together", async () => {
    expect(loginAttemptKey(undefined)).toBe(loginAttemptKey(""));
    expect(loginAttemptKey(IP)).not.toBe(loginAttemptKey(undefined));
  });

  it("logs failures and lockouts without the token", async () => {
    await initialized();
    for (let i = 0; i < 6; i++) await loginWithToken(deps, { token: TOKEN + "x", ip: IP }, headers);
    expect(logger.entries.map((e) => e.msg)).toContain("login token rejected");
    expect(logger.entries.map((e) => e.msg)).toContain("login rate limited");
    expect(JSON.stringify(logger.entries)).not.toContain(TOKEN);
  });
});

describe("rotateLoginToken", () => {
  const input = { current: TOKEN, token: NEW_TOKEN, confirm: NEW_TOKEN, ip: IP };

  beforeEach(async () => {
    await initialized();
    auth.addSession("s1", USER);
    auth.addSession("s2", USER);
  });

  it("replaces the hash, revokes every session and clears the cookie", async () => {
    expect(await rotateLoginToken(deps, USER, input, headers)).toEqual({
      ok: true,
      value: undefined,
    });
    const hash = (await loginTokens.getHash())!;
    expect(await hasher.verify(NEW_TOKEN, hash)).toBe(true);
    expect(await hasher.verify(TOKEN, hash)).toBe(false);
    expect(auth.sessionCount).toBe(0);
    expect(auth.cookieClears).toBe(1);
    expectTokensNotLogged();
  });

  it("refuses a machine actor", async () => {
    const result = await rotateLoginToken(
      deps,
      { kind: "machine", name: "machine" },
      input,
      headers,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(auth.sessionCount).toBe(2);
  });

  it("rejects a wrong current token on the current field and changes nothing", async () => {
    const result = await rotateLoginToken(
      deps,
      USER,
      { ...input, current: "wrong-token" },
      headers,
    );
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", field: "current" } });
    expect(await hasher.verify(TOKEN, (await loginTokens.getHash())!)).toBe(true);
    expect(auth.sessionCount).toBe(2);
    expect(auth.cookieClears).toBe(0);
  });

  it("validates the new token and its confirmation", async () => {
    expect(
      await rotateLoginToken(deps, USER, { ...input, token: "abc", confirm: "abc" }, headers),
    ).toMatchObject({ ok: false, error: { kind: "validation", field: "token" } });
    expect(
      await rotateLoginToken(deps, USER, { ...input, confirm: `${NEW_TOKEN}!` }, headers),
    ).toMatchObject({ ok: false, error: { kind: "validation", field: "confirm" } });
    expect(auth.sessionCount).toBe(2);
  });

  it("rate-limits wrong current tokens with the login counter", async () => {
    for (let i = 0; i < 5; i++) {
      await rotateLoginToken(deps, USER, { ...input, current: "wrong-token" }, headers);
    }
    expect(await rotateLoginToken(deps, USER, input, headers)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
    // Same bucket as login.
    expect(await loginWithToken(deps, { token: TOKEN, ip: IP }, headers)).toMatchObject({
      ok: false,
      error: { kind: "rate_limited" },
    });
    expect(auth.sessionCount).toBe(2);
  });

  it("leaves sessions and the cookie alone when the transaction fails", async () => {
    auth.rotateLoginToken = async () => ({
      ok: false,
      error: { kind: "not_found", entity: "login_token" },
    });
    expect(await rotateLoginToken(deps, USER, input, headers)).toMatchObject({ ok: false });
    expect(auth.sessionCount).toBe(2);
    expect(auth.cookieClears).toBe(0);
  });
});
