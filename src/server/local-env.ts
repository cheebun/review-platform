/**
 * Loads the same dotenv files as `vite dev` / Nitro (`.env`, `.env.local`, `.env.<mode>`,
 * `.env.<mode>.local`, later files win), so CLI scripts such as `pnpm db:migrate` see the same
 * configuration as the dev server. Real environment variables
 * always win over file values. Returns the names of the files that were loaded (never values).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type LocalEnvTarget = Record<string, string | undefined>;

export function loadLocalEnv(opts: {
  cwd: string;
  mode?: string;
  /** Defaults to `process.env`. */
  target?: LocalEnvTarget;
}): string[] {
  // oxlint-disable-next-line no-restricted-properties
  const target = opts.target ?? process.env;
  const mode = opts.mode ?? "development";
  const names = [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
  const loaded: string[] = [];
  const merged: Record<string, string> = {};
  for (const name of names) {
    const path = join(opts.cwd, name);
    if (!existsSync(path)) continue;
    Object.assign(merged, parseEnv(readFileSync(path, "utf8")));
    loaded.push(name);
  }
  for (const [key, value] of Object.entries(merged)) {
    if (target[key] === undefined) target[key] = value;
  }
  return loaded;
}
