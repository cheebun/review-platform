import { createServerFn } from "@tanstack/react-start";
import { authed } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  loadSettings,
  parseRepoBody,
  parseTokenBody,
  runAddRepo,
  runRemoveGithubToken,
  runRemoveRepo,
  runSaveGithubToken,
} from "./settings.logic";

/** The settings page model. Never includes the token. */
export const fetchSettings = createServerFn({ method: "GET" })
  .middleware([authed])
  .handler(async ({ context }) => loadSettings((await getContainer()).ports, context.actor));

/** Verifies the token with GitHub, then stores it encrypted (rate limited per user). */
export const saveGithubTokenFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseTokenBody)
  .handler(async ({ data, context }) =>
    runSaveGithubToken((await getContainer()).ports, context.actor, data),
  );

export const removeGithubTokenFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .handler(async ({ context }) =>
    runRemoveGithubToken((await getContainer()).ports, context.actor),
  );

/** Checks access with the stored token, then adds the repo. */
export const addRepoFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseRepoBody)
  .handler(async ({ data, context }) =>
    runAddRepo((await getContainer()).ports, context.actor, data),
  );

export const removeRepoFn = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(parseRepoBody)
  .handler(async ({ data, context }) =>
    runRemoveRepo((await getContainer()).ports, context.actor, data),
  );
