/**
 * Nitro runtime plugin: builds the shared container before the server accepts any request.
 *
 * Architecture principle 5 (fail closed): invalid config or an unreachable database / Redis must
 * stop the process at boot, not on the first request. Nitro holds requests until async plugins
 * settle, so a failure here exits non-zero instead of serving 500s. `getContainer()` already
 * logs a redacted, message-only error; no value or stack is printed here.
 *
 * Dev exception (see `bootFailureAction`): exiting would make Nitro restart the worker in a loop,
 * so the dev server stays up and answers every request with a 503 page listing the key names.
 */
import type { NitroApp } from "nitro/types";
import { bootFailureAction, renderBootFailurePage, serveBootFailure } from "./boot-failure";
import { getContainer } from "./runtime";

export default async function bootPlugin(nitroApp: NitroApp): Promise<void> {
  try {
    await getContainer();
  } catch (error) {
    // Vite replaces `import.meta.env.DEV` statically: false in `vite build`, true under `vite dev`.
    const action = bootFailureAction({ isDev: import.meta.env.DEV === true, error });
    if (action === "exit" || !serveBootFailure(nitroApp, renderBootFailurePage(action.serve503))) {
      process.exit(1);
    }
  }
}
