/**
 * Path policy for API and server-function requests. Page routes are guarded by the `_authed`
 * layout, not here.
 *
 * Fail closed: the answer is `true` (authentication required) for everything that is not on the
 * short public list below, including paths this function does not know about.
 *
 * Public:
 * - `/api/auth/<something>`: better-auth. It authenticates itself.
 * - `POST /api/slack/events`: verified by Slack's HMAC signature (P3).
 *
 * Server functions are never public by path; see `isPublicServerFn`.
 *
 * Strictness, so that normalisation can never widen what is public:
 * - Percent-encoding is decoded exactly once. `%2e%2e` is therefore a `..` segment, and `%252e`
 *   stays the literal text `%2e`.
 * - A path with `.` or `..` segments, a backslash, a control character, bad encoding, or no
 *   leading `/` is rejected, which means "requires auth".
 * - Matching is case-sensitive: `/API/auth/x` is not public.
 * - A public route matches only when its path is already canonical: `/api//slack/events` (doubled
 *   slash) and `/api/slack/events/` (trailing slash) are NOT public. Slack posts to the exact URL.
 * - The method must be exactly `POST` for the Slack route.
 */
export function requiresAuth(pathname: string, method: string): boolean {
  const decoded = decodeOnce(pathname);
  if (decoded === null) return true;
  const normalized = normalizePath(pathname);
  // Public only when decoding left nothing to collapse: no `//`.
  if (normalized === null || normalized !== decoded) return true;

  if (normalized.startsWith(AUTH_PREFIX) && normalized.length > AUTH_PREFIX.length) return false;
  if (normalized === SLACK_EVENTS && method === "POST") return false;
  return true;
}

const AUTH_PREFIX = "/api/auth/";
const SLACK_EVENTS = "/api/slack/events";

/**
 * The server functions callable without a session: setup status, login, and first-run setup
 * with its checks (FR-AUTH-01, -02). Keyed by the source file (relative to the project root) and the exported
 * variable name, both compiled into the server bundle by Start, never taken from the request.
 */
const PUBLIC_SERVER_FNS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["src/functions/login-token.ts", new Set(["getSetupStatus", "loginWithToken"])],
  [
    "src/functions/setup.ts",
    new Set([
      "finishSetup",
      "getSetupSections",
      "testSetupAnthropic",
      "listSetupGithubRepos",
      "testSetupSlack",
    ]),
  ],
]);

/** Fail closed: exact file and name only; anything unknown or missing is not public. */
export function isPublicServerFn(meta: { filename: string; name: string } | undefined): boolean {
  if (!meta) return false;
  return PUBLIC_SERVER_FNS.get(meta.filename)?.has(meta.name) ?? false;
}

function decodeOnce(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Decodes once, then collapses repeated slashes. Returns null when the path is not a plain
 * absolute path: relative, dot segments, backslash, control characters or malformed encoding.
 */
export function normalizePath(pathname: string): string | null {
  const decoded = decodeOnce(pathname);
  if (decoded === null || !decoded.startsWith("/")) return null;
  if (decoded.includes("\\") || hasControlChar(decoded)) return null;
  const collapsed = decoded.replace(/\/{2,}/g, "/");
  if (collapsed.split("/").some((s) => s === ".." || s === ".")) return null;
  return collapsed;
}

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}
