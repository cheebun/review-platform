import {
  listAccessibleGithubRepos,
  type AccessibleRepoOptions,
  type GithubRepoListDeps,
} from "../application/settings/github-repos";
import type { Actor } from "../domain/shared/actor";
import type { IdGenerator, Logger } from "../ports/system";
import { errorLogFields, toHttp, unexpectedToHttp } from "../server/errors";
import type { SettingsErrorBody, SettingsFnResult } from "./settings.logic";

/*
 * Server-only logic behind src/functions/settings-github.ts (the repo picker on /settings).
 */

/** What this function reads. Field names match the container's `Ports`. */
export type GithubReposFnPorts = GithubRepoListDeps & { ids: IdGenerator; logger: Logger };

/**
 * The repos the stored token can access: names, flags and `truncated`, never the token. Errors
 * are the fixed public bodies of `SettingsErrorBody`; `not_configured` keeps `needs_reset`.
 */
export async function runListGithubAccessibleRepos(
  ports: GithubReposFnPorts,
  actor: Actor,
): Promise<SettingsFnResult<AccessibleRepoOptions>> {
  try {
    const result = await listAccessibleGithubRepos(ports, actor);
    if (result.ok) return result;
    const body: SettingsErrorBody = toHttp(result.error, ports.ids.uuid()).body;
    if (result.error.kind === "not_configured" && result.error.reason) {
      body.reason = result.error.reason;
    }
    return { ok: false, error: body };
  } catch (error) {
    const requestId = ports.ids.uuid();
    // Name plus the coded cause; never the message, which may carry a URL or a credential.
    ports.logger.error("settings server function failed", {
      fn: "listGithubAccessibleRepos",
      requestId,
      ...errorLogFields(error),
    });
    return { ok: false, error: unexpectedToHttp(error, requestId).body };
  }
}
