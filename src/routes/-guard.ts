import { notFound, redirect } from "@tanstack/react-router";
import { getSetupStatus } from "../functions/login-token";
import { getViewer } from "../functions/viewer";

/** The first-run wizard (FR-AUTH-01). Until it has run, every page goes here. */
export const SETUP_HREF = "/setup";

/** The login page, coming back to `href` after sign-in. */
export const loginHref = (href: string) => `/login?redirect=${encodeURIComponent(href)}`;

/** Any failure of the viewer lookup (401 from the RPC, network) means "no viewer". */
const lookupViewer = () => getViewer().catch(() => null);

/**
 * Page guard shared by the `_authed` layout and the catch-all. Before initialization every page
 * goes to /setup; after it, no viewer fails closed to the login page. The status and the viewer
 * are looked up in parallel. A failed status lookup propagates: it is not a "no" for either.
 */
export async function requireViewer(location: { href: string }) {
  const [{ initialized }, viewer] = await Promise.all([getSetupStatus(), lookupViewer()]);
  if (!initialized) throw redirect({ href: SETUP_HREF });
  if (!viewer) throw redirect({ href: loginHref(location.href) });
  return viewer;
}

/** Guard for /login: before initialization it goes to /setup. */
export async function requireInitialized() {
  const { initialized } = await getSetupStatus();
  if (!initialized) throw redirect({ href: SETUP_HREF });
}

/**
 * Where /setup sends the caller, or null to show the wizard (FR-AUTH-01). Once initialized every
 * /setup URL is gone: signed in to `/`, otherwise to `/login`.
 */
export function setupRedirectHref(state: {
  initialized: boolean;
  signedIn: boolean;
}): string | null {
  if (!state.initialized) return null;
  return state.signedIn ? "/" : "/login";
}

/**
 * Guard for /setup. Before initialization a /setup URL with a query becomes plain /setup: the
 * wizard keeps nothing in the URL.
 */
export async function guardSetup(location: { href: string }) {
  const { initialized } = await getSetupStatus();
  const signedIn = initialized && (await lookupViewer()) !== null;
  const href = setupRedirectHref({ initialized, signedIn });
  if (href !== null) throw redirect({ href });
  if (location.href !== SETUP_HREF) throw redirect({ href: SETUP_HREF });
}

/** Paths owned by API handlers: an unmatched one is a plain 404, never a login redirect. */
export const isApiPath = (pathname: string) => pathname === "/api" || pathname.startsWith("/api/");

export { notFound };
