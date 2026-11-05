import { queryOptions } from "@tanstack/react-query";
import { fetchGithubAccessibleRepos } from "../../../functions/settings-github";
import { callSettingsFn } from "./token-section";

export const githubRepoKeys = {
  accessible: () => ["settings", "github", "accessible-repos"] as const,
};

/**
 * The repos the stored token can access, for the repo picker. Never fetched on page load: the
 * picker enables it only through its refresh button, which always refetches. Each fetch reads
 * up to 10 GitHub pages and counts against a per-user rate limit, so a result stays fresh 5 min.
 */
export const accessibleReposQueryOptions = () =>
  queryOptions({
    queryKey: githubRepoKeys.accessible(),
    queryFn: ({ signal }) => callSettingsFn(fetchGithubAccessibleRepos({ signal })),
    staleTime: 5 * 60_000,
    enabled: false,
  });
