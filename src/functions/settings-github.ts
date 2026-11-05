import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import { runListGithubAccessibleRepos } from "./settings-github.logic";

/** The repos the stored GitHub token can access, for the repo picker. Read-only, rate limited. */
export const fetchGithubAccessibleRepos = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) =>
    runListGithubAccessibleRepos((await getContainer()).ports, context.actor),
  );
