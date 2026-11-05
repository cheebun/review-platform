import { err, ok, type DomainError, type Result } from "../shared/result";
import { aiReviewSchema } from "./schema";
import type {
  AiReviewResult,
  Finding,
  GithubReviewEvent,
  ReviewDiffFile,
  ReviewVerdict,
  Severity,
} from "./types";

export type {
  AiReviewResult,
  ApproveCheckpoint,
  ApproveOutcome,
  Finding,
  GithubReviewEvent,
  ReviewDiffFile,
  ReviewFailureCategory,
  ReviewRecord,
  ReviewRequester,
  ReviewVerdict,
  Severity,
} from "./types";

const SEVERITY_ORDER: readonly Severity[] = ["P0", "P1", "P2", "Nit"];

const DEFAULT_VERIFICATION = [
  "Verify the changed critical user paths still work as expected.",
  "Confirm TypeScript / lint / relevant checks pass.",
];
const DEFAULT_VERIFICATION_ZH = [
  "验证改动涉及的关键用户路径仍可正常使用。",
  "确认 TypeScript / lint / 相关检查通过。",
];

// ---------------------------------------------------------------------------
// Parsing AI output (fail closed)
// ---------------------------------------------------------------------------

const validation = (message: string, field?: string): { ok: false; error: DomainError } =>
  err({ kind: "validation", ...(field ? { field } : {}), message });

const trimmedOrUndefined = (value: string | null | undefined): string | undefined => {
  const t = value?.trim();
  return t ? t : undefined;
};

const cleanList = (items: string[] | null | undefined): string[] =>
  (items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);

/**
 * Turns untrusted model output into an `AiReviewResult`.
 *
 * Fail closed: anything malformed or partial becomes a `validation` error. There is no path that
 * produces an "empty, therefore approvable" review from bad input. Only a well-formed response
 * with a real `findings` array (possibly empty) succeeds. Never throws and never echoes the
 * input in the error message.
 *
 * Intentional differences from the legacy `toAiReviewResult` (src/lib/review-ai.ts):
 * returns a Result; optional fields with the wrong type are rejected instead of coerced with
 * `String()` or silently dropped.
 */
export function toAiReviewResult(parsed: unknown): Result<AiReviewResult, DomainError> {
  try {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return validation("AI output is not an object.");
    }
    let candidate = parsed as Record<string, unknown>;
    // Some gateways serialise the nested array as JSON inside the tool input.
    if (typeof candidate.findings === "string") {
      let decoded: unknown;
      try {
        decoded = JSON.parse(candidate.findings);
      } catch {
        return validation("AI findings string is not valid JSON; approval stopped.", "findings");
      }
      candidate = { ...candidate, findings: decoded };
    }
    const result = aiReviewSchema.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues[0];
      const field = issue?.path.map(String).join(".") || undefined;
      return validation(`AI review is missing or has invalid fields; approval stopped.`, field);
    }
    const data = result.data;
    const findings: Finding[] = data.findings.map((raw) => {
      const finding: Finding = { severity: raw.severity, title: raw.title, body: raw.body };
      const titleZh = trimmedOrUndefined(raw.titleZh);
      const bodyZh = trimmedOrUndefined(raw.bodyZh);
      const path = trimmedOrUndefined(raw.path);
      if (titleZh) finding.titleZh = titleZh;
      if (bodyZh) finding.bodyZh = bodyZh;
      if (path) finding.path = path;
      if (typeof raw.line === "number") finding.line = raw.line;
      return finding;
    });
    const requests = cleanList(data.verificationRequests);
    const requestsZh = cleanList(data.verificationRequestsZh);
    return ok({
      summary: data.summary,
      summaryZh: trimmedOrUndefined(data.summaryZh),
      findings,
      verificationRequests: requests.length > 0 ? requests : [...DEFAULT_VERIFICATION],
      verificationRequestsZh: requestsZh.length > 0 ? requestsZh : [...DEFAULT_VERIFICATION_ZH],
    });
  } catch {
    // Getters or proxies that throw: still a validation failure, never an exception.
    return validation("AI output could not be read.");
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** Highest severity present, or null. Unknown runtime severities are ignored here. */
export function highestSeverity(findings: readonly Finding[]): Severity | null {
  for (const severity of SEVERITY_ORDER) {
    if (findings.some((f) => f?.severity === severity)) return severity;
  }
  return null;
}

const APPROVABLE: ReadonlySet<string> = new Set(["P1", "P2", "Nit"]);

/**
 * REQUEST_CHANGES on any P0. Fails closed: a finding whose severity is not exactly one of the
 * known non-blocking values (e.g. "p0", "critical", "") is treated like a blocker.
 */
export function decideGithubEvent(findings: readonly Finding[]): GithubReviewEvent {
  for (const f of findings) {
    if (!f || !APPROVABLE.has(f.severity)) return "REQUEST_CHANGES";
  }
  return "APPROVE";
}

/** 🟢 / 🔴 verdict. Same fail-closed rule as `decideGithubEvent`: anything but APPROVE is not a pass. */
export function reviewVerdict(findings: readonly Finding[]): ReviewVerdict {
  return decideGithubEvent(findings) === "APPROVE" ? "pass" : "changes_requested";
}

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

/** GitHub rejects comments over 65,536 chars; stay well below it and keep room for the marker. */
export const MAX_COMMENT_BODY_CHARS = 60_000;
const MAX_SUMMARY_CHARS = 4_000;
const MAX_TITLE_CHARS = 300;
const MAX_BODY_CHARS = 4_000;
const MAX_PATH_CHARS = 300;
const MAX_REQUEST_CHARS = 1_000;
const TRUNCATION_NOTICE = "\n\n_(comment truncated: remaining content omitted)_";

const MARKER_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Dedupe marker appended to the comment so a retried worker can find its earlier comment. */
export function reviewCommentMarker(key: string): Result<string, DomainError> {
  if (typeof key !== "string" || !MARKER_KEY_RE.test(key)) {
    return validation("Invalid review comment dedupe key.", "dedupeKey");
  }
  return ok(`<!-- review:${key} -->`);
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${cutSurrogateSafe(value, max)}…`;
}

function cutSurrogateSafe(value: string, max: number): string {
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Replaces every line break (with its surrounding blanks) by one space, so a value cannot start a new block. */
const oneLine = (value: string) =>
  value.replace(/[^\S\n\r\u2028\u2029]*[\n\r\u2028\u2029]\s*/g, " ").trim();

/** Closes a code fence left open so later sections still render as markdown. */
function balanceFences(value: string): string {
  let open: { char: string; length: number } | null = null;
  for (const line of value.split("\n")) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    const char = m[1][0];
    if (open) {
      if (char === open.char && m[1].length >= open.length && m[2].trim() === "") open = null;
    } else if (!(char === "`" && m[2].includes("`"))) {
      open = { char, length: m[1].length };
    }
  }
  return open ? `${value}\n${open.char.repeat(open.length)}` : value;
}

/**
 * Neutralises model-controlled text before it is embedded in a GitHub comment. Policy:
 *  - HTML comment delimiters `<!--` and `-->` become entities, so text can never forge or hide
 *    the dedupe marker (`<!-- review:KEY -->`);
 *  - `@name` mentions get a zero-width space after the `@`, so nobody is notified (emails such
 *    as `a@b.com` are left alone);
 *  - ATX heading markers at the start of a line are backslash-escaped, so multi-line text
 *    cannot forge a section such as `## 🔴 P0 (Blockers)`;
 *  - an unclosed code fence is closed.
 * Everything else (links, emphasis, inline code) is left as the reviewer wrote it, on purpose:
 * the findings are meant to be readable markdown.
 */
function neutralise(value: string, balance = true): string {
  const base = value
    .replace(/\r\n?/g, "\n")
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/(^|[^A-Za-z0-9_])@(?=[A-Za-z0-9])/g, "$1@​")
    .replace(/^( {0,3})(#{1,6})(?=\s|$)/gm, "$1\\$2");
  return balance ? balanceFences(base) : base;
}

function formatFindingBullet(finding: unknown): string {
  if (finding === null || typeof finding !== "object") return "- **(malformed finding)**";
  const f = finding as Partial<Finding>;
  const title = neutralise(cap(oneLine(text(f.title)), MAX_TITLE_CHARS));
  const path = cap(oneLine(text(f.path)).replace(/`/g, "'"), MAX_PATH_CHARS);
  const hasLine = typeof f.line === "number" && Number.isFinite(f.line);
  const loc = path ? ` (\`${path}${hasLine ? `:${f.line}` : ""}\`)` : "";
  const body = neutralise(cap(text(f.body), MAX_BODY_CHARS), false);
  // Balance the whole bullet: a fence only counts at the start of a line, and the body's first
  // line sits after `- **title**: `.
  return balanceFences(`- **${title}**${loc}: ${body}`);
}

function sectionBullets(findings: readonly unknown[], severity: Severity): string[] {
  // Unknown or malformed severities are shown under P0: never hide something we cannot rank.
  const items = findings.filter((f) => {
    const s = (f as Partial<Finding> | null)?.severity;
    return severity === "P0"
      ? !SEVERITY_ORDER.includes(s as Severity) || s === "P0"
      : s === severity;
  });
  return items.length === 0 ? ["- None."] : items.map(formatFindingBullet);
}

/**
 * Renders the review as a GitHub comment. Total: never throws, output is capped below the GitHub
 * limit (P0 findings come first so truncation hits lower severities first), and all
 * model-controlled text is neutralised (see `neutralise`). When `dedupeKey` is a valid key the
 * marker is appended last; an invalid key is ignored, so callers that need dedupe should
 * validate it with `reviewCommentMarker` first.
 */
export function buildReviewCommentBody(
  review: AiReviewResult,
  options: { dedupeKey?: string } = {},
): string {
  const findings: readonly unknown[] = Array.isArray(review?.findings) ? review.findings : [];
  const requests = (Array.isArray(review?.verificationRequests) ? review.verificationRequests : [])
    .map((item) => oneLine(text(item)))
    .filter((item) => item.length > 0);

  const lines: string[] = [
    "## Summary",
    "",
    neutralise(cap(text(review?.summary), MAX_SUMMARY_CHARS)),
    "",
    "## 🔴 P0 (Blockers)",
    "",
    ...sectionBullets(findings, "P0"),
    "",
    "## 🟠 P1 (High)",
    "",
    ...sectionBullets(findings, "P1"),
    "",
    "## 🟡 P2 (Medium)",
    "",
    ...sectionBullets(findings, "P2"),
    "",
    "## 🔵 Nit",
    "",
    ...sectionBullets(findings, "Nit"),
    "",
    "## Verification Requests",
    "",
  ];
  (requests.length > 0 ? requests : [DEFAULT_VERIFICATION[0]]).forEach((item, index) => {
    lines.push(`${index + 1}. ${neutralise(cap(item, MAX_REQUEST_CHARS))}`);
  });

  let core = lines.join("\n");
  if (core.length > MAX_COMMENT_BODY_CHARS) {
    core = balanceFences(
      cutSurrogateSafe(core, MAX_COMMENT_BODY_CHARS - TRUNCATION_NOTICE.length) + TRUNCATION_NOTICE,
    );
  }
  if (options.dedupeKey !== undefined) {
    const marker = reviewCommentMarker(options.dedupeKey);
    if (marker.ok) return `${core}\n\n${marker.value}`;
  }
  return core;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Send every file together, without character limits, truncation, or splitting. */
export function buildReviewDiff(files: readonly ReviewDiffFile[]): string {
  return files.map(({ header, patch }) => `${header}\n\`\`\`diff\n${patch}\n\`\`\`\n`).join("\n");
}
