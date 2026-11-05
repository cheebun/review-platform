import { defineConfig } from "vitest/config";
import Icons from "unplugin-icons/vite";
import viteReact from "@vitejs/plugin-react";

// Projects inherit these plugins (Vitest 5 default). The app's vite.config.ts also loads tanstackStart and nitro. Those are build-time only
// and are deliberately NOT loaded here.
const shared = {
  resolve: { tsconfigPaths: true },
  plugins: [Icons({ compiler: "jsx", jsx: "react" }), viteReact()],
};

const globs = (suffix: string) => [`src/**/*.${suffix}`, `tests/**/*.${suffix}`];
const msw = "src/testing/setup/msw.ts";
// Every project: Jira and LLM credentials are injected through the settings-store fake, never env.
const scrub = "src/testing/setup/scrub-credential-env.ts";

export default defineConfig({
  ...shared,
  test: {
    coverage: { provider: "v8", include: ["src/**"], exclude: ["src/testing/**"] },
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: globs("test.{ts,tsx}"),
          exclude: [
            ...globs("db.test.ts"),
            ...globs("int.test.ts"),
            ...globs("dom.test.tsx"),
            "**/node_modules/**",
          ],
          setupFiles: [scrub, msw],
        },
      },
      {
        test: {
          name: "db-fast",
          environment: "node",
          include: globs("db.test.ts"),
          setupFiles: [scrub],
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
      {
        test: {
          name: "integration",
          environment: "node",
          include: globs("int.test.ts"),
          globalSetup: ["src/testing/integration/global-setup.ts"],
          setupFiles: [scrub, msw],
          // One file at a time: the remote PostgreSQL has ~16 usable connections and a single file
          // may need PG_CONNECTION_BUDGET of them (see src/testing/integration/pg-budget.ts).
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "component",
          environment: "jsdom",
          include: globs("dom.test.tsx"),
          setupFiles: [scrub, msw, "src/testing/setup/dom.ts"],
        },
      },
    ],
  },
});
