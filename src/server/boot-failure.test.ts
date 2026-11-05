import { describe, expect, it } from "vitest";
import { H3Core } from "nitro/h3";
import { bootFailureAction, renderBootFailurePage, serveBootFailure } from "./boot-failure";
import { ConfigError, loadConfig } from "./config";

const configError = new ConfigError([
  { key: "DATABASE_URL", reason: "is required" },
  { key: "BETTER_AUTH_SECRET", reason: "must be at least 32 characters" },
]);

describe("bootFailureAction", () => {
  it("exits in production for a config error", () => {
    expect(bootFailureAction({ isDev: false, error: configError })).toBe("exit");
  });

  it("exits in production for any other error", () => {
    expect(bootFailureAction({ isDev: false, error: new Error("connect ECONNREFUSED") })).toBe(
      "exit",
    );
  });

  it("serves 503 with the problem key names in dev", () => {
    expect(bootFailureAction({ isDev: true, error: configError })).toEqual({
      serve503: ["DATABASE_URL", "BETTER_AUTH_SECRET"],
    });
  });

  it("serves 503 with no key names in dev for a non-config error", () => {
    expect(bootFailureAction({ isDev: true, error: new Error("db down") })).toEqual({
      serve503: [],
    });
  });

  it("reads the keys of a real loadConfig failure", () => {
    let error: unknown;
    try {
      loadConfig({});
    } catch (e) {
      error = e;
    }
    expect(bootFailureAction({ isDev: true, error })).toEqual({
      serve503: ["DATABASE_URL", "REDIS_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"],
    });
  });
});

describe("renderBootFailurePage", () => {
  it("names every key and no value from a fake env", () => {
    const env = {
      DATABASE_URL: "postgres://user:hunter2@db.example.com/app",
      BETTER_AUTH_SECRET: "s3cr3t-value-that-is-definitely-longer-than-32-chars",
      REDIS_URL: "rediss://:pw-12345@cache.example.com:6380",
    };
    let error: unknown;
    try {
      loadConfig({ ...env, BETTER_AUTH_SECRET: "short" });
    } catch (e) {
      error = e;
    }
    const action = bootFailureAction({ isDev: true, error });
    expect(action).not.toBe("exit");
    const html = renderBootFailurePage((action as { serve503: string[] }).serve503);
    expect(html).toContain("BETTER_AUTH_SECRET");
    expect(html).toContain("BETTER_AUTH_URL");
    for (const value of Object.values(env)) expect(html).not.toContain(value);
    expect(html).not.toContain("short");
    expect(html).not.toContain("hunter2");
  });

  it("escapes key names", () => {
    expect(renderBootFailurePage(["<script>x</script>"])).not.toContain("<script>x");
  });

  it("is a complete HTML document that points at the terminal and the docs", () => {
    const html = renderBootFailurePage([]);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("docs/development.md");
  });
});

describe("serveBootFailure (against the real Nitro 3 / h3 app class)", () => {
  it("makes every route answer 503 with the page, on a real H3Core", async () => {
    const h3 = new H3Core();
    expect(serveBootFailure({ h3 }, "<p>PAGE</p>")).toBe(true);
    for (const path of ["/", "/login", "/api/auth/ok", "/_serverFn/x"]) {
      const res = await h3.fetch(new Request(`http://127.0.0.1:5555${path}`));
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toBe("<p>PAGE</p>");
    }
  });

  it("returns false when the app has no h3 instance", () => {
    expect(serveBootFailure({}, "x")).toBe(false);
  });
});
