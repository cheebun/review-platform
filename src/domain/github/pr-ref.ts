import { err, ok, type DomainError, type Result } from "../shared/result";

export type PrRef = {
  owner: string;
  repo: string;
  number: number;
  /** Canonical `https://github.com/{owner}/{repo}/pull/{number}`. */
  url: string;
};

/**
 * Same shape as the legacy parser (src/lib/parse-pr-url.ts): http(s), exact host `github.com`,
 * optional trailing `/`, `/files` | `/commits` | `/checks`, then `?query` or `#fragment`.
 * Unlike the legacy regex, `/pull/12files` is NOT accepted (the suffix needs its own `/`).
 */
const PR_URL_RE =
  /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks)?)?(?:[#?].*)?$/i;

/** GitHub login rules: 1-39 alphanumerics or single hyphens, not starting or ending with a hyphen. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** Repository names: 1-100 of [A-Za-z0-9._-], and never `.` or `..`. */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

const invalid = (message: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", field: "url", message });

/** Non-throwing PR URL parser. Never echoes the input in the error message. */
export function parsePrUrl(input: unknown): Result<PrRef, DomainError> {
  if (typeof input !== "string") return invalid("PR URL must be a string.");
  const match = input.trim().match(PR_URL_RE);
  if (!match) {
    return invalid("Invalid PR URL. Expected https://github.com/{owner}/{repo}/pull/{number}");
  }
  const [, owner, repo, digits] = match;
  if (!OWNER_RE.test(owner)) return invalid("Invalid GitHub owner name.");
  if (!REPO_RE.test(repo) || repo === "." || repo === "..") {
    return invalid("Invalid GitHub repository name.");
  }
  // Leading zeros are rejected so the canonical URL and the number never disagree.
  if (digits.length > 1 && digits.startsWith("0")) return invalid("Invalid PR number.");
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number < 1) return invalid("Invalid PR number.");
  return ok({ owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` });
}
