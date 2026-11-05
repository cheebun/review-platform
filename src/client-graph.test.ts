/**
 * Guard: the browser module graph must not import Node built-ins.
 *
 * Vite replaces a Node built-in in client code with `__vite-browser-external`, whose property
 * access throws at module evaluation. One such import anywhere in the graph (for example a
 * server-only adapter kept alive by a top-level export of a middleware module that the Start
 * compiler cannot strip) stops the client entry, so the app never hydrates and every form falls
 * back to a native GET submit.
 *
 * Walks the client environment's transformed modules from the router (Start's compiler applied,
 * route chunks included) and fails on any Node built-in import.
 */
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";

const IMPORT_RE =
  /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
const NODE_BUILTIN = /__vite-browser-external|^node:|^\/@id\/node:/;

/** Drops Vite's cache-busting params, keeps the router's split queries. */
function normalise(spec: string): string {
  const [path, query] = spec.split("?");
  if (!query) return path!;
  const kept = new URLSearchParams(query);
  kept.delete("v");
  kept.delete("t");
  const rest = kept.toString();
  return rest ? `${path}?${rest}` : path!;
}

async function nodeImportsInClientGraph(entries: string[]): Promise<string[]> {
  const server = await createServer({
    configFile: false,
    logLevel: "error",
    root: process.cwd(),
    resolve: { tsconfigPaths: true },
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    plugins: [
      Icons({ compiler: "jsx", jsx: "react" }),
      tanstackStart({ srcDirectory: "src" }),
      viteReact(),
    ],
  });
  const offending: string[] = [];
  try {
    const env = server.environments.client;
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      const result = await env.transformRequest(url);
      if (!result) continue;
      for (const match of result.code.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? match[3]!;
        if (NODE_BUILTIN.test(spec)) offending.push(`${url} -> ${spec}`);
        else if (spec.startsWith("/src/")) queue.push(normalise(spec));
      }
    }
  } finally {
    await server.close();
  }
  return offending;
}

describe("client module graph", () => {
  it("imports no Node built-ins", { timeout: 120_000 }, async () => {
    expect(await nodeImportsInClientGraph(["/src/router.tsx", "/src/start.ts"])).toEqual([]);
  });
});
