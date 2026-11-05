import { describe, expect, it } from "vitest";
import config from "../../../vitest.config";
import { MIN_POOL, PG_CONNECTION_BUDGET, freeConnectionSlots } from "./pg-budget";

describe("freeConnectionSlots", () => {
  it("subtracts reserved slots and every client backend already connected", () => {
    // The remote test PG: max_connections 20, 3 superuser-reserved, 1 provider backend + global setup.
    expect(
      freeConnectionSlots({
        maxConnections: 20,
        superuserReserved: 3,
        reserved: 0,
        clientBackends: 2,
      }),
    ).toBe(15);
  });

  it("never goes negative", () => {
    expect(
      freeConnectionSlots({
        maxConnections: 5,
        superuserReserved: 3,
        reserved: 2,
        clientBackends: 4,
      }),
    ).toBe(0);
  });
});

describe("integration connection budget", () => {
  it("covers one file with a full MIN_POOL pool plus its helper pools", () => {
    expect(PG_CONNECTION_BUDGET).toBeGreaterThanOrEqual(MIN_POOL + 2);
  });

  it("runs integration files one at a time, so pools never compete for the budget", () => {
    const projects = (config as { test?: { projects?: unknown[] } }).test?.projects ?? [];
    const integration = projects.find(
      (p) => (p as { test?: { name?: string } }).test?.name === "integration",
    ) as { test: { fileParallelism?: boolean } } | undefined;
    expect(integration?.test.fileParallelism).toBe(false);
  });
});
