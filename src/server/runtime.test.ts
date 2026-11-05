import { describe, expect, it, vi } from "vitest";
import { createTestContainer } from "../testing/container";
import { MemoryLogger } from "../testing/fakes/memory-logger";
import type { Config } from "./config";
import type { Container } from "./container";
import { createRuntime, type RuntimeDeps } from "./runtime";

const CONFIG = { databaseUrl: "postgres://u:hunter2@db.example.com/x" } as Config;

function setup(over: Partial<RuntimeDeps> = {}) {
  const calls: string[] = [];
  const handlers = new Map<string, () => void>();
  const exit = vi.fn<(code: number) => void>();
  const logger = new MemoryLogger();
  const container = createTestContainer();
  const close = vi.fn(async () => {});
  container.close = close;
  const createContainer = vi.fn(async (_c: Config): Promise<Container> => {
    calls.push("createContainer");
    return container;
  });
  const deps: RuntimeDeps = {
    env: { PORT: "1" },
    loadConfig: () => {
      calls.push("loadConfig");
      return CONFIG;
    },
    warnDeprecatedKeys: () => {
      calls.push("warnDeprecatedKeys");
    },
    createContainer,
    logger,
    process: { once: (sig, fn) => void handlers.set(sig, fn), exit },
    closeTimeoutMs: 200,
    ...over,
  };
  return { deps, calls, handlers, exit, logger, container, close, createContainer };
}

describe("getContainer", () => {
  it("loads config, warns about deprecated keys, then creates the container, in that order", async () => {
    const s = setup();
    const rt = createRuntime(s.deps);
    expect(await rt.getContainer()).toBe(s.container);
    expect(s.calls).toEqual(["loadConfig", "warnDeprecatedKeys", "createContainer"]);
  });

  it("concurrent first calls create exactly ONE container", async () => {
    const s = setup();
    const rt = createRuntime(s.deps);
    const all = await Promise.all(Array.from({ length: 20 }, () => rt.getContainer()));
    expect(s.createContainer).toHaveBeenCalledTimes(1);
    expect(new Set(all).size).toBe(1);
    await rt.getContainer();
    expect(s.createContainer).toHaveBeenCalledTimes(1);
  });

  it("getConfig returns the config the container was built from, without a second load", async () => {
    const s = setup();
    const load = vi.spyOn(s.deps, "loadConfig");
    const rt = createRuntime(s.deps);
    const [config] = await Promise.all([rt.getConfig(), rt.getContainer()]);
    expect(config).toBe(CONFIG);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failure: the next call retries, and the failure is logged redacted", async () => {
    let n = 0;
    const s = setup();
    s.createContainer.mockImplementation(async () => {
      if (n++ === 0) throw new Error("connect to postgres://u:hunter2@db.example.com/x failed");
      return s.container;
    });
    const rt = createRuntime(s.deps);
    await expect(rt.getContainer()).rejects.toThrow();
    await expect(rt.getContainer()).resolves.toBe(s.container);
    expect(s.createContainer).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify(s.logger.entries);
    expect(logged).toContain("container startup failed");
    expect(logged).not.toContain("hunter2");
    expect(s.logger.entries[0]?.level).toBe("error");
  });

  it("a config error is also retried (not cached) and logged", async () => {
    let n = 0;
    const s = setup({
      loadConfig: () => {
        if (n++ === 0) throw new Error("Invalid configuration: DATABASE_URL: is required");
        return CONFIG;
      },
    });
    const rt = createRuntime(s.deps);
    await expect(rt.getContainer()).rejects.toThrow("Invalid configuration");
    await expect(rt.getContainer()).resolves.toBe(s.container);
    expect(JSON.stringify(s.logger.entries)).toContain("DATABASE_URL");
  });

  it("concurrent callers during a failing creation all reject, and one later call retries once", async () => {
    const s = setup();
    s.createContainer.mockRejectedValueOnce(new Error("boom"));
    const rt = createRuntime(s.deps);
    const results = await Promise.allSettled([rt.getContainer(), rt.getContainer()]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(s.createContainer).toHaveBeenCalledTimes(1);
    await rt.getContainer();
    expect(s.createContainer).toHaveBeenCalledTimes(2);
  });
});

describe("shutdown", () => {
  it("registers SIGTERM and SIGINT exactly once, however many calls", async () => {
    const s = setup();
    const once = vi.spyOn(s.deps.process, "once");
    const rt = createRuntime(s.deps);
    await Promise.all([rt.getContainer(), rt.getContainer()]);
    await rt.getContainer();
    expect(once.mock.calls.map((c) => c[0]).toSorted()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("SIGTERM closes the container once and exits 0", async () => {
    const s = setup();
    const rt = createRuntime(s.deps);
    await rt.getContainer();
    s.handlers.get("SIGTERM")!();
    s.handlers.get("SIGINT")!();
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalled());
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledTimes(1);
    expect(s.exit).toHaveBeenCalledWith(0);
  });

  it("SIGTERM with no container yet (or a failed one) just exits 0", async () => {
    const s = setup();
    s.createContainer.mockRejectedValueOnce(new Error("x"));
    const rt = createRuntime(s.deps);
    await rt.getContainer().catch(() => {});
    s.handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(0));
    expect(s.close).not.toHaveBeenCalled();
  });

  it("a close() that hangs does not block exit forever: exits non-zero after the timeout", async () => {
    const s = setup();
    s.close.mockImplementation(() => new Promise<void>(() => {}));
    const rt = createRuntime(s.deps);
    await rt.getContainer();
    s.handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(1), { timeout: 2000 });
  });

  it("a close() that throws exits 1", async () => {
    const s = setup();
    s.close.mockRejectedValue(new Error("close failed"));
    const rt = createRuntime(s.deps);
    await rt.getContainer();
    s.handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(s.exit).toHaveBeenCalledWith(1));
  });
});
