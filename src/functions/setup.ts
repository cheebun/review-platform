import { createServerFn } from "@tanstack/react-start";
import {
  getRequest,
  getRequestIP,
  setResponseHeader,
  setResponseStatus,
} from "@tanstack/react-start/server";
import { publicFn } from "../server/middleware/auth-middleware";
import { getContainer } from "../server/runtime";
import {
  parseFinishSetupBody,
  parseGithubTokenBody,
  parseSetupAnthropicBody,
  parseSlackTokenBody,
  runFinishSetup,
  runGetSetupSections,
  runListSetupGithubRepos,
  runTestSetupAnthropic,
  runTestSetupSlack,
  type SetupFnPorts,
  type SetupFnResult,
  type SetupReply,
} from "./setup.logic";

/*
 * First-run setup server functions (FR-AUTH-01). All of them are callable without a session:
 * they are on `isPublicServerFn`'s list (access-policy.ts), keyed by this file's path and these
 * names. Each one is `conflict` (409) once the login token exists. Renaming or moving them closes
 * them, never opens others.
 */

const setupPorts = async (): Promise<SetupFnPorts> => (await getContainer()).ports;

/** The client IP for the per-IP limit. X-Forwarded-For is not trusted. */
const clientIp = () => getRequestIP();

/** Applies the reply's status and headers to the response and returns the result as data. */
function send<T>(reply: SetupReply<T>): SetupFnResult<T> {
  if (reply.status !== 200) setResponseStatus(reply.status);
  for (const [name, value] of Object.entries(reply.headers ?? {})) setResponseHeader(name, value);
  return reply.result;
}

/**
 * The wizard's only write: validates everything, then stores the login token, the owner user and
 * the provided sections in one transaction and signs the owner in. 400 names the field.
 */
export const finishSetup = createServerFn({ method: "POST" })
  .middleware([publicFn])
  .validator(parseFinishSetupBody)
  .handler(async ({ data }) =>
    send(await runFinishSetup(await setupPorts(), data, clientIp(), getRequest().headers)),
  );

/** Which sections already have stored values (booleans only), for the wizard's 已配置. */
export const getSetupSections = createServerFn({ method: "GET" })
  .middleware([publicFn])
  .handler(async () => send(await runGetSetupSections(await setupPorts(), clientIp())));

/** Tests Anthropic values with the probe model. Stores nothing. */
export const testSetupAnthropic = createServerFn({ method: "POST" })
  .middleware([publicFn])
  .validator(parseSetupAnthropicBody)
  .handler(async ({ data }) =>
    send(await runTestSetupAnthropic(await setupPorts(), data, clientIp())),
  );

/** Verifies a GitHub token and lists the repos it can access. Stores nothing. */
export const listSetupGithubRepos = createServerFn({ method: "POST" })
  .middleware([publicFn])
  .validator(parseGithubTokenBody)
  .handler(async ({ data }) =>
    send(await runListSetupGithubRepos(await setupPorts(), data, clientIp())),
  );

/** Checks a Slack user token (auth.test). Stores nothing. */
export const testSetupSlack = createServerFn({ method: "POST" })
  .middleware([publicFn])
  .validator(parseSlackTokenBody)
  .handler(async ({ data }) => send(await runTestSetupSlack(await setupPorts(), data, clientIp())));
