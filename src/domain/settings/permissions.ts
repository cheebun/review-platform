/**
 * Per-repo permission results (FR-GITHUB-07). Each cell is what a read-only probe could prove:
 * `unverified` means no read-only call can tell, and it is never reported as granted.
 */
export type PermissionStatus = "granted" | "missing" | "unverified";

export type RepoPermissions = {
  pullRequests: { read: PermissionStatus; write: PermissionStatus };
  contents: { read: PermissionStatus; write: PermissionStatus };
  checks: { read: PermissionStatus };
  statuses: { read: PermissionStatus };
};

/** `unknown`: the check could not run (GitHub unreachable, rate limited, no token). */
export type RepoAccess = "ok" | "no_access" | "unknown";

/** ✓ ok, ✓ partial (some cells unverified), ⚠ warning, ✗ error, ? unknown. */
export type RepoHealth = "ok" | "partial" | "warning" | "error" | "unknown";

export const ALL_UNVERIFIED: RepoPermissions = {
  pullRequests: { read: "unverified", write: "unverified" },
  contents: { read: "unverified", write: "unverified" },
  checks: { read: "unverified" },
  statuses: { read: "unverified" },
};

/** Each permission cell with its GitHub-style name, in table order (for the /settings list). */
export function permissionCells(p: RepoPermissions): [string, PermissionStatus][] {
  return cells(p);
}

/** Table order of the four rows, as shown on /settings. */
function cells(p: RepoPermissions): [string, PermissionStatus][] {
  return [
    ["pull_requests:read", p.pullRequests.read],
    ["pull_requests:write", p.pullRequests.write],
    ["contents:read", p.contents.read],
    ["contents:write", p.contents.write],
    ["checks:read", p.checks.read],
    ["statuses:read", p.statuses.read],
  ];
}

/** Names of the permissions proven missing, e.g. `contents:write`. */
export function missingPermissions(p: RepoPermissions): string[] {
  return cells(p)
    .filter(([, status]) => status === "missing")
    .map(([name]) => name);
}

export function repoHealth(r: {
  access: RepoAccess;
  permissions: RepoPermissions | null;
}): RepoHealth {
  if (r.access === "no_access") return "error";
  if (r.access === "unknown" || !r.permissions) return "unknown";
  const statuses = cells(r.permissions).map(([, s]) => s);
  if (statuses.includes("missing")) return "warning";
  if (statuses.includes("unverified")) return "partial";
  return "ok";
}
