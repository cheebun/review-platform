/**
 * What the boot plugin does when the container cannot be built.
 *
 * Production fails closed: exit non-zero (architecture principle 5). In dev the Nitro runner
 * restarts an exiting worker immediately, which turns a missing `.env.local` into a crash loop
 * and a "socket hang up" in the browser. So dev keeps the worker alive and answers every request
 * with a 503 page that names the offending keys. Only key names are ever shown, never values.
 */
import type { NitroApp } from "nitro/types";
import { ConfigError } from "./config";

export type BootFailureAction = "exit" | { serve503: string[] };

export function bootFailureAction(input: { isDev: boolean; error: unknown }): BootFailureAction {
  if (!input.isDev) return "exit";
  const keys =
    input.error instanceof ConfigError ? [...new Set(input.error.issues.map((i) => i.key))] : [];
  return { serve503: keys };
}

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Static HTML for the dev 503 page. Takes key names only, so no value can reach it. */
export function renderBootFailurePage(keys: readonly string[]): string {
  const list =
    keys.length > 0
      ? `<p>These settings are missing or invalid:</p><ul>${keys
          .map((k) => `<li><code>${escapeHtml(k)}</code></li>`)
          .join("")}</ul>`
      : "<p>The server could not start (for example the database or Redis is unreachable). The terminal running <code>pnpm dev</code> has the redacted error.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Server not configured</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222;background:#fff}
@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}}
code{font-family:ui-monospace,monospace}
</style>
</head>
<body>
<h1>503: server not configured</h1>
${list}
<p>Fix the environment (see <code>docs/development.md</code>), then restart <code>pnpm dev</code>.</p>
</body>
</html>
`;
}

/**
 * Replaces the root handler of Nitro's h3 app so every request gets the 503 page. In Nitro 3 the
 * plugin's `nitroApp.h3` is an `H3Core`, which has no `use()`; `fetch()` always ends in
 * `this.handler(event)`, so overriding it covers every route, after Nitro's own onRequest hooks.
 * Returns false when there is no h3 app to override.
 */
export function serveBootFailure(nitroApp: Pick<NitroApp, "h3">, html: string): boolean {
  const h3 = nitroApp.h3;
  if (!h3) return false;
  h3.handler = () =>
    new Response(html, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  return true;
}
