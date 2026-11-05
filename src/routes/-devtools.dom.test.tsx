import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { loadDevtoolsPlugins } from "./-devtools";

describe("dev-only TanStack Devtools panels", () => {
  it("has the Query, Router and Form panels", async () => {
    const build = await loadDevtoolsPlugins();
    const names = build(new QueryClient()).map((p) => p.name);
    expect(names).toEqual(["TanStack Query", "TanStack Router", expect.stringMatching(/form/i)]);
  });
});
