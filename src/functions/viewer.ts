import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { getContainer } from "../server/runtime";
import { loadViewer } from "./viewer.logic";

/**
 * The signed-in user (email only) or null, for the `_authed` guard.
 *
 * Deliberately NOT `authed` and without any policy exception: it reads the session cookie
 * itself. During SSR it runs in-process. From the browser the RPC passes the global access
 * middleware, so an anonymous call gets 401 and the guard treats that as "no viewer".
 */
export const getViewer = createServerFn({ method: "GET" }).handler(async () => {
  const container = await getContainer();
  return loadViewer(getRequestHeaders(), container.ports.auth);
});
