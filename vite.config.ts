import { cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, runnerImport, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

const root = dirname(fileURLToPath(import.meta.url));
// Nitro's node-server entry; not in the package's exports, so resolved from its package.json.
const nitroNodeServer = join(
  dirname(fileURLToPath(import.meta.resolve("nitro/package.json"))),
  "dist/presets/node/runtime/node-server.mjs",
);

/**
 * `pnpm dev`: migrate before anything else starts (see `migrateForDev` in
 * src/server/migrate-on-boot.ts). A `pre` `config` hook, because Vite awaits `config` hooks one by
 * one before Nitro's own `config` hook sets up the dev worker, whose boot plugin builds the container.
 * Loaded through Vite's module runner so this config keeps importing only packages.
 */
const migrateOnDevStart: Plugin = {
  name: "agent-ops:migrate-on-dev-start",
  enforce: "pre",
  apply: (_config, env) => env.command === "serve" && !env.isPreview,
  config: {
    order: "pre",
    async handler() {
      const { module } = await runnerImport<typeof import("./src/server/migrate-on-boot")>(
        resolve(root, "src/server/migrate-on-boot.ts"),
      );
      await module.migrateForDev();
    },
  },
};

export default defineConfig(({ command }) => ({
  server: { host: "127.0.0.1", port: 5555 },
  resolve: { tsconfigPaths: true },
  plugins: [
    migrateOnDevStart,
    tailwindcss(),
    Icons({ compiler: "jsx", jsx: "react" }),
    tanstackStart({ srcDirectory: "src" }),
    viteReact(),
    nitro({
      plugins: ["./src/server/boot-plugin.ts"],
      // `vite build`: migrate, then listen (see src/server/node-entry.ts). Dev keeps Nitro's dev entry.
      ...(command === "build"
        ? {
            preset: "node-server",
            entry: resolve(root, "src/server/node-entry.ts"),
            alias: { "#agent-ops/nitro-node-server": nitroNodeServer },
            hooks: {
              compiled: (n) => {
                cpSync(resolve(root, "drizzle"), join(n.options.output.serverDir, "drizzle"), {
                  recursive: true,
                });
              },
            },
          }
        : {}),
    }),
  ],
}));
