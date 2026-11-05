import { describe, expect, it } from "vitest";
import { err, ok, type Result } from "../domain/shared/result";
import { tokenScoped } from "./token-scoped";

interface Echo {
  whoami(): Promise<Result<string>>;
  add(a: number, b: number): Promise<Result<string>>;
}

class TokenEcho implements Echo {
  constructor(readonly token: string) {}
  async whoami() {
    return ok(this.token);
  }
  async add(a: number, b: number) {
    return ok(`${this.token}:${a + b}`);
  }
}

const METHODS = { whoami: true, add: true } as const;

function setup(initial: Result<string> | Error) {
  let current = initial;
  let reads = 0;
  const built: string[] = [];
  const port = tokenScoped<Echo>({
    service: "github",
    token: async () => {
      reads += 1;
      if (current instanceof Error) throw current;
      return current;
    },
    build: (token) => {
      built.push(token);
      return new TokenEcho(token);
    },
    methods: METHODS,
  });
  return {
    port,
    set: (next: Result<string> | Error) => void (current = next),
    reads: () => reads,
    built,
  };
}

describe("tokenScoped", () => {
  it("reads the stored token on every call and passes the arguments through", async () => {
    const s = setup(ok("t1"));
    expect(await s.port.whoami()).toEqual(ok("t1"));
    expect(await s.port.add(2, 3)).toEqual(ok("t1:5"));
    expect(s.reads()).toBe(2);
  });

  it("reuses the client while the token is unchanged and rebuilds it after a change", async () => {
    const s = setup(ok("t1"));
    await s.port.whoami();
    await s.port.whoami();
    s.set(ok("t2"));
    expect(await s.port.whoami()).toEqual(ok("t2"));
    expect(s.built).toEqual(["t1", "t2"]);
  });

  it("returns the store's not_configured error without building a client", async () => {
    const s = setup(err({ kind: "not_configured", feature: "github", reason: "needs_reset" }));
    expect(await s.port.whoami()).toEqual(
      err({ kind: "not_configured", feature: "github", reason: "needs_reset" }),
    );
    expect(s.built).toEqual([]);
  });

  it("a throwing store read is a retryable upstream error, never a throw", async () => {
    const s = setup(new Error("connection refused postgres://secret"));
    expect(await s.port.add(1, 1)).toEqual(
      err({ kind: "upstream", service: "github", retryable: true }),
    );
  });

  it("exposes exactly the listed methods", () => {
    const s = setup(ok("t1"));
    expect(Object.keys(s.port).toSorted()).toEqual(["add", "whoami"]);
  });
});
