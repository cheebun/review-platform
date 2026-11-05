# Requirements (PRD)

Status: **draft 2026-11-04**. This document states the **target** behaviour of Review platform after the migration described in [migration-plan.md](./migration-plan.md). Where the target differs from the legacy Next.js code, the difference is noted as **Legacy:**. The product overview for human readers is [product.md](./product.md). The architecture is in [architecture.md](./architecture.md).

Conventions:

- Facts are cited as `path:line`, relative to the repository root.
- Anything not established by code or by an approved document is marked **(assumed)**.
- Requirements proposed by the user on 2026-11-04 but not yet designed in code are marked **(new)**.
- "Must", "should" and "may" carry their RFC 2119 meanings.

---

## 1. Purpose, users and scope

### 1.1 Purpose

Review platform is a single-user operations workbench. It automates **PR review and shipping** for one engineer: an LLM reviews GitHub pull requests on an allowlisted repository, posts the result, approves or requests changes, and merges when policy allows. Reviews can be started from the web UI or by an @mention in Slack.

### 1.2 Users and callers

| Caller                                       | Kind         | Authenticates with                                         | What it does                                                                     |
| -------------------------------------------- | ------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Owner**                                    | human        | login token, then a better-auth session cookie             | Uses every page and every UI action.                                             |
| **Slack**                                    | service      | HMAC signature on the raw body (the stored signing secret) | Delivers Events API callbacks to `POST /api/slack/events`.                       |
| **Operator CLI**                             | human, shell | direct database access                                     | `pnpm db:migrate`, `pnpm llm:ping` (`package.json` scripts).                     |

There is exactly **one user**, the owner. Whoever completes the first `/setup` step chooses the login token and owns the system (FR-AUTH-01).

### 1.3 In scope

- The pages in §2.7: Overview `/`, `/review` (plus the detail page), `/merge` and Settings `/settings`, plus `/setup`, `/login` and the shared shell.
- The external server routes for Slack events and auth.
- The Slack review worker (`scripts/slack-review-worker.ts`).
- Persisted review records, an audit history, explicit Approve and Merge actions, and the owner's Slack `merge` command **(new)**.

### 1.4 Out of scope

- Multi-user or multi-tenant use, roles, and sharing.
- Any repository that is not in the owner's repo list in `/settings` (FR-GITHUB-07, decided 2026-11-04).
- Changing which LLM model is used, beyond replacing the deprecated default (migration-plan.md:20).
- Slack token rotation. The Slack app does not implement it (docs/slack-pr-review.md:86).

---

## 2. Functional requirements

Each requirement lists its trigger or input, its output, its error cases and acceptance criteria (AC). Every AC must be testable by an automated test unless it says "manual".

### 2.1 Authentication and access (FR-AUTH)

#### FR-AUTH-01 First-run setup (`/setup`)

- **Description.** The system is **initialized** when a `login_token` row exists; that is the only setup state. Until then, every page redirects to `/setup`. Once initialized, every `/setup` URL redirects away. The URL never carries the step or any value.
- **Access.**
  - Not initialized: `/setup` renders the wizard. A `/setup` URL with a query redirects to plain `/setup`.
  - Initialized: every `/setup` URL redirects to `/` for a signed-in user and to `/login` otherwise.
- **Trigger / input.** The `/setup` wizard. It has four steps:
  1. **Login token (required).** The owner chooses the login token and enters it twice.
  2. **AI (Anthropic), optional.** API key or auth token, Base URL and model (FR-LLMCFG-01).
  3. **GitHub, optional.** The token and the repo selection (FR-GITHUB-02, FR-GITHUB-07).
  4. **Slack, optional.** The User token and the Signing secret (FR-SLACKCFG-01).

  **Nothing is written before 完成.** The values live in the page's React state only: not in localStorage, sessionStorage, a cookie or the URL. 上一步 and 下一步 keep them. A reload starts again at step 1 with every field empty, and the page says so in one line. 下一步 checks the token rules and the confirmation in the browser. Each of steps 2–4 has "稍后配置" ("稍后配置并完成" on step 4), which leaves that section out of the submission, so its stored values stay. A section that already has stored values shows "已配置". Anything left out can be configured later on `/settings`.

  完成 calls the public `finishSetup({ token, confirm, anthropic?, github?, slack? })` server function (`src/functions/setup.ts`, `src/application/identity/setup.ts`). In order:
  1. If the system is already initialized: 409 `conflict`, before any hashing.
  2. The setup rate limit (below).
  3. Every section is validated with the same rules and upstream checks as `/settings`: the token rules and confirmation (FR-AUTH-02), the Anthropic credential probe, the GitHub token and repo access, and the Slack token. Any failure is a 400 (or 403 for a rejected credential) whose `field` names the path, e.g. `token`, `confirm`, `anthropic.apiKey`, `github.repos` or `slack.userToken`. The wizard jumps to that step and shows the error inline.
  4. One database transaction (`SetupUnitOfWork`, `src/adapters/db/pg-setup-unit-of-work.ts`) inserts the `login_token` row first (`INSERT … ON CONFLICT DO NOTHING`), then the owner user, the encrypted settings, the GitHub credential and the repos. If the row already existed, everything rolls back and the result is 409. Any error rolls everything back; there is no partial setup.
  5. After the commit: the session cookie. The wizard then goes to `/`.
- **Setup-only checks.** The wizard's 已配置 marks and its 测试连接 / 验证并加载仓库 buttons use public server functions that write nothing: `getSetupSections` (booleans only), `testSetupAnthropic` (probe model `claude-haiku-5-5`), `listSetupGithubRepos` and `testSetupSlack`. Like `finishSetup`, each returns 409 once the system is initialized.
- **Rate limit.** All setup functions share one attempt limiter per client IP, in its own `setup:` namespace: 30 attempts per 15 minutes, then a 15-minute lockout. Over the limit: 429 `rate_limited` with `Retry-After`.
- **Output.** A `login_token` row, the owner user, the submitted sections and a session cookie, all or nothing.
- **Errors.**
  - The token fails the rules in FR-AUTH-02, or the two entries differ: the error is shown inline on the field, with `aria-invalid` and `aria-describedby`.
  - Initialization is **first-writer-wins**. If another submission initialized the system first, the request gets a 409 `conflict` and nothing is written. The page then shows a "系统已初始化" alert with a "前往登录" button; it does not redirect on its own.
  - Secrets are never logged and never returned; the wizard never shows the server's own error text.
- **AC.**
  1. With no `login_token` row, an anonymous `GET /` and `GET /login` redirect to `/setup`.
  2. With a `login_token` row, any `/setup` URL redirects to `/` when signed in and to `/login` otherwise.
  3. No server function writes anything before 完成; only the setup-only checks are called.
  4. 上一步 and 下一步 keep the entered values; a reload shows step 1 with every field empty.
  5. A section left for later is not sent, and its stored values are unchanged.
  6. A validation failure in any section writes nothing and puts the wizard on that section's step.
  7. A failure inside the transaction leaves no `login_token`, user, settings or repo rows.
  8. Concurrent `finishSetup` calls produce exactly one `login_token` row. One succeeds, the others get `conflict`.
  9. Every setup function returns 409 once the system is initialized.

#### FR-AUTH-02 Token login and session

- **Description.** There is one user, the owner, and one credential, the login token. `/login` has a single token field. A correct token issues the normal better-auth session cookie. Sessions last 7 days and are refreshed daily (`src/adapters/auth/auth.ts:62`).
- **Token rules.** The owner chooses the token. It has at least 6 characters, no maximum length, and no leading or trailing whitespace; surrounding whitespace is rejected, never trimmed. Inner spaces are allowed.
- **Storage.** Only a salted slow hash is stored: PBKDF2-HMAC-SHA256 through WebCrypto, 600000 iterations, a 16-byte random salt. It lives in the singleton table `login_token` (`id = 1`, `token_hash`, `created_at`, `rotated_at`). The plaintext token is never stored or logged.
- **Output.** An `HttpOnly`, `SameSite=Lax` cookie. It is also `Secure` when `BETTER_AUTH_URL` is https (`src/adapters/auth/auth.ts:41,63-66`).
- **Errors.** A wrong token shows "wrong token". Repeated failures are rate-limited and return 429 `rate_limited`. Anything else shows a generic error.
- **AC.**
  1. A correct token sets the cookie and navigates to `safeRedirect(redirect)`.
  2. The token comparison is constant-time.
  3. Repeated wrong tokens are rate-limited.
  4. A double submit while pending sends one request.
  5. No response, log line or table other than `login_token.token_hash` contains the token or anything derived from it.

#### FR-AUTH-03 Page guard

- **Description.** Every page under the `_authed` layout requires a signed-in user. Before initialization every page redirects to `/setup` instead (FR-AUTH-01). An unknown page redirects anonymous callers to `/login` before it returns 404, so pages cannot be probed (`src/routes/$.tsx:4-12`).
- **Trigger / input.** Any page navigation.
- **Output.** The page, or a redirect to `/login?redirect=<href>` (`src/routes/-guard.ts:8-14`).
- **Errors.** Any failure of the viewer lookup counts as "no viewer" and fails closed.
- **AC.**
  1. An anonymous `GET /` responds with a redirect to `/login?redirect=%2F`.
  2. A signed-in user who requests an unknown page gets 404. An anonymous user gets the login redirect.

#### FR-AUTH-04 API access policy

- **Description.** Every `/api/*` route and every server function requires an actor, except for this short public list (`requiresAuth` and `PUBLIC_SERVER_FNS` in `src/application/identity/access-policy.ts`):
  - `/api/auth/<something>`, which is better-auth
  - `POST /api/slack/events`, which relies on the Slack signature
  - the `/login` submit, and the `/setup` functions (`finishSetup` and the setup-only checks, FR-AUTH-01), which work without a session and return 409 once the system is initialized
- **Trigger / input.** Any API or server-function request.
- **Output.** The request continues with `context.actor`, or a JSON error `{ kind, message, requestId }` is returned (`src/server/middleware/auth-middleware.ts:22-53`).
- **Session only.** The session cookie is the only way to authenticate. Any request to a guarded route that carries an `Authorization` header gets 401, whatever the header holds and even with a valid session cookie.
- **Errors.** 401 `unauthenticated`. 500 `internal` if actor resolution throws (`src/server/middleware/access.ts:50-56`).
- **AC.**
  1. Path normalisation never widens the public list. Dot segments, encoded dots, backslashes, doubled slashes, trailing slashes, control characters and case variants all require auth (`src/application/identity/access-policy.test.ts:65-120`).
  2. `GET`, `PUT` and lowercase `post` to `/api/slack/events` require auth.
  3. Every 401 body carries a `requestId` and a fixed message.
  4. A request with any `Authorization` header gets 401, with or without a valid session cookie.

#### FR-AUTH-06 Post-login redirect sanitising

- **Description.** The `redirect` search parameter is accepted only as a same-origin path with a single leading `/`. It is re-checked after up to three rounds of percent-decoding. Anything else falls back to `/` (`src/routes/-safe-redirect.ts:17-38`).
- **AC.** `//evil.com`, `/\evil.com`, `/%2Fevil.com`, `/%255Cevil.com`, `https://evil.com` and non-strings all resolve to `/`.

#### FR-AUTH-07 Login token rotation

- **Description.** The "登录令牌" section on `/settings` has three fields: the current token, the new token and its confirmation. The current token must match, and the new one is checked against the FR-AUTH-02 rules. The new hash replaces the old one and `rotated_at` is set.
- **Output.** Every existing session is invalidated, including the current one, and the browser reloads `/login` so the owner signs in with the new token.
- **Errors.** A wrong current token is shown inline on that field. Too many attempts return 429, shown as "N 分钟后再试".
- **AC.** After rotation the old token is rejected, the new one is accepted, and a session cookie issued before the rotation gets 401.

#### FR-AUTH-08 Sign-out (assumed)

- **Description.** The shell offers a sign-out action at the bottom of the sidebar, next to Settings (§2.7, decided), that calls better-auth `POST /api/auth/sign-out` and returns the user to `/login`. **(assumed)**: no sign-out UI exists in `src/routes/` yet.

---

### 2.2 PR review (FR-REVIEW)

#### FR-REVIEW-01 Open PR list

- **Description.** The app lists the open, non-draft PRs across **every repository in the `/settings` repo list** (FR-GITHUB-07) whose author is on the review author list and that were updated within the last 15 days (`src/lib/github.ts:16-31`, `src/ports/github.ts:39-45`). A repo picker filters by repository (decided).
  - Legacy hard-coded one repository (`src/lib/repos.ts:1-2`). That constant is removed.
  - With an empty repo list, the page shows "未配置仓库 → /settings" (FR-GITHUB-07).
  - The review author list has 9 logins (`src/lib/repos.ts:17-27`).
- **Trigger / input.** Opening the PR list page or pressing Refresh.
- **Output.** For each PR: the number, title, author label, `approved` (GitHub reviewDecision is APPROVED), `updatedAt`, and the head → base branches (`src/lib/types.ts:54-65`).
- **Errors.** A GitHub failure returns the mapped `DomainError` with a generic message and a request ID (S4). The UI shows an error alert and keeps Refresh available.
- **AC.**
  1. Draft PRs and PRs by authors outside the list are never shown.
  2. The call uses the single GitHub account configured in `/settings` (FR-GITHUB-02). Without a token, the page shows "GitHub 未配置" (FR-GITHUB-05).
  3. The base branch `main` is visually emphasised (`src/app/review/components/PrListItem.tsx:74`).
- **Legacy:** `GET /api/pulls/open` took the account from the `x-github-account` header (`src/app/api/pulls/open/route.ts:14`) and returned the raw error message (`:30-31`).

#### FR-REVIEW-02 Author filter

- **Description.** The full list can be filtered by author chips that show counts. Only authors with at least one PR get a chip. If the selected author drops to zero after a refresh, the filter falls back to "all" (`src/app/review/hooks/use-review-page.ts:60-92`, `src/app/review/components/AuthorFilter.tsx:32`).
- **AC.** The counts equal the number of listed PRs per author. The chips are disabled while an action is running.

#### FR-REVIEW-03 Start a web review (Ship)

- **Description.** For a PR by someone else, the owner presses **Ship**. The server creates a `review_job` with `source='web'` (architecture.md §10.3), reviews the full diff with the LLM, and continues through FR-SHIP-01. The review can outlast one request. The server answers `deferred` (202) until it finishes, and the client polls.
- **Trigger / input.** The PR URL, which must match `https://github.com/{owner}/{repo}/pull/{n}` with an optional `/files`, `/commits` or `/checks` suffix (`src/lib/parse-pr-url.ts:3-4`).
- **Output.** An `ExecuteResult` (`src/lib/types.ts:33-52`) with the PR metadata, the review summary, findings, verification requests, `highestSeverity`, `approved`, `merged`, `githubEvent`, the comment body and the GitHub review ID.
- **Errors.**
  - 400 `validation`: a bad URL.
  - 403 `forbidden`: the repo is not on the allowlist, or the PR is the actor's own.
  - 409 `conflict`: the PR is closed, a draft or already merged, the SHA changed, or the session lock is held.
  - 429 `rate_limited`.
  - 502 or 503 `upstream`.
  - The diff is incomplete, or empty, or the LLM output is invalid twice: the review fails and nothing is approved (docs/slack-pr-review.md:78-82).
- **AC.**
  1. Client polling uses TanStack Query `refetchInterval` with a maximum number of attempts, and it stops on unmount (migration-plan.md:230). **Legacy:** an unbounded `for (;;)` loop with a 1 s sleep (`src/app/review/hooks/use-review-page.ts:99-119`).
  2. Two concurrent requests for the same job run the review once.
  3. A clean result (approved with zero findings) shows a toast. Any other result opens the result dialog (`src/app/review/lib/review-ui.ts:61-63`).
  4. The browser receives only an opaque job ID, never the session contents (`src/lib/review-session.ts:27`).

#### FR-REVIEW-04 Review content and LLM contract

- **Description.** The reviewer receives every changed file, the PR title, the body and the branch information in one request, with no character limit and no splitting (`src/lib/review-input.ts:13-16`).
  - PR content is wrapped as delimited untrusted input. Closing tags inside it are neutralised (`src/adapters/llm/untrusted.ts:1-17`).
  - A missing textual diff is rebuilt from Git blobs at the merge base. If that fails, the review fails (docs/slack-pr-review.md:76-78).
  - Output is schema-validated. One correction round is allowed. A second invalid output fails the review and is **never** treated as "no findings" (docs/slack-pr-review.md:80).
- **Output.** An `AiReviewResult` (`src/domain/review/types.ts`). Each finding has a severity of `P0 | P1 | P2 | Nit` (`src/lib/types.ts:1`) and a title, a body, an optional `path` and `line`, and optional Chinese copy for the UI.
- **Errors.** `upstream` with `retryable` set from the SDK error type (architecture.md §7).
- **AC.**
  1. Provider choice is by configuration only: Anthropic when it is configured, otherwise 503 `not_configured`. There is no alternate provider (`src/adapters/llm/settings-providers.ts`).
  2. A truncated output (`max_tokens`) fails the review.
  3. A `findings` value that arrives as a JSON string is parsed strictly, and each element is validated.

#### FR-REVIEW-05 Persisted review record (new)

- **Description.** Every review run, from the web or from Slack, is persisted and can be listed and re-opened later. One record per **PR URL per run** **(assumed)**, because a Slack job can carry several PRs.
- **Record fields and current coverage:**

  | Field                                              | Stored today?      | Where                                                                                                                          |
  | -------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
  | PR ref (owner, repo, number, URL)                  | partly             | `review_job.urls` and `progress[url].pr` (jsonb) (`src/adapters/db/schema.ts:26-27`, `src/domain/review-queue/types.ts:30-41`) |
  | Head SHA (and base SHA)                            | partly             | `progress[url].pr.sha` / `baseSha`, inside jsonb, so it is not indexed or queryable                                            |
  | Source (`web` or `slack`)                          | yes                | `review_job.source`                                                                                                            |
  | Requester / actor                                  | partly             | `actor_user_id` for web jobs. Slack sender in `slack.user`.                               |
  | Model (provider and model ID)                      | **no**             | gap                                                                                                                            |
  | Started and finished times                         | **no**             | Only `created_at` and `updated_at` exist. There is no `started_at` or `finished_at`.                                           |
  | Status                                             | yes                | `review_job.state` (`queued`, `running`, `done`, `failed`)                                                                     |
  | Structured findings (severity, file:line, message) | partly             | `progress[url].review.findings` (jsonb), written once by the state machine (`src/domain/review-queue/state-machine.ts:75`)     |
  | Verdict (APPROVE / REQUEST_CHANGES / COMMENT)      | **no** (derivable) | Can be recomputed from the findings with `decideGithubEvent`, but it is not stored. `progress[url].result` is opaque.          |

- **Gap.** `review_job` is a work-queue row. It holds the result only as opaque jsonb checkpoints, and it is deleted after 30 days (architecture.md §5.1, Retention). A durable, queryable record needs either:
  - a `review_result` table **(assumed)**: `id`, `job_id`, `pr_url`, `owner`, `repo`, `number`, `head_sha`, `base_sha`, `source`, `actor_kind`, `actor_id`, `provider`, `model`, `started_at`, `finished_at`, `status`, `verdict`, `highest_severity`, `findings jsonb`, `summary`; or
  - typed columns on `review_job` **(assumed)**.

  Retention of review records must be longer than that of `review_job` **(assumed: 1 year)**.

- **Severity mismatch.** The request asked for severities P0 to P3. The code uses `P0 | P1 | P2 | Nit` in the domain, the schema and the UI (`src/domain/review-queue/types.ts:7`, `src/domain/review-queue/progress.ts:12`, `src/app/review/lib/review-ui.ts:4-9`). This document keeps the code's set. Whether to map `Nit` to P3 is open question Q8.
- **Trigger / input.** A review run reaches a terminal state (`done` or `failed`), or a review checkpoint is written.
- **Output.** A record that can be listed and opened through FR-REVIEW-06 and FR-REVIEW-07.
- **Errors.** If writing the record fails, the job must not reach `done`. Write the record in the same transaction as the state change (architecture.md §1 principle 4) **(assumed)**.
- **AC.**
  1. Every terminal job yields one record per URL, and each record has all of the fields above.
  2. A failed run is recorded with `status=failed` and a generic, non-leaking error category.
  3. A retried job produces a new record. It does not overwrite the old one **(assumed)**.
  4. Records survive the `review_job` retention purge.

#### FR-REVIEW-06 Review history / audit timeline (new)

- **Description.** An append-only timeline of every review, approval and merge event. Each event records the actor (a user ID, or a Slack user ID for Slack-triggered work) and a timestamp.
  - Event types **(assumed)**: `review_started`, `review_finished`, `review_failed`, `comment_posted`, `approved`, `changes_requested`, `force_approved`, `merged`, `merge_failed`.
- **Route (decided).** The review records and results are listed at `/review`, filterable by PR, status, source (`web` or `slack`) and date, and paginated. The open PR list (FR-REVIEW-01) sits at the top of the same page, and new reviews are started from it. Merge history is listed at `/merge` (FR-SHIP-05).
- **Trigger / input.** A list query with optional filters: repo, PR number, status, source (`web` or `slack`), and a date range. Pagination is cursor-based **(assumed)**, with a default page size of 50 **(assumed)**.
- **Output.** A page of events, newest first, plus a next cursor.
- **Errors.** 400 on invalid filters, such as a malformed repo or `from > to`.
- **AC.**
  1. Events are never updated or deleted by the application. A database role or trigger prevents `UPDATE` and `DELETE` on the event table **(assumed)**.
  2. Every GitHub write in FR-SHIP produces exactly one event, even after a retry. The event is keyed by job, URL and step **(assumed)**.
  3. The filters combine with AND. Pagination is stable while new events are appended.
- **Verdict markers (decided).** Each record in the `/review` list and on `/review/$reviewId` shows the same markers as Slack: 🟢 for a passing verdict, 🔴 for changes requested, and ✅ 已合并 once merged. Failed reviews show no verdict marker, only their failed status.
- **Implemented (stage 3: `a37d726`, `75512d8`, `0c9b6ce`).** `review_result` and `review_event` exist. The `/review` history:
  - is **view-only**: the list starts nothing (Q26);
  - keeps its filters in the URL search params, and pages with a cursor through a **"加载更多"** button;
  - interprets dates as **UTC+8 calendar days**;
  - shows **no PR title**, because the record does not store it;
  - **hides records of repos that were removed from the `/settings` list**, while the `/merge` history still shows them. This inconsistency is open question **Q27**.

#### FR-REVIEW-07 Review detail (new)

- **Route (decided).** `/review/$reviewId`.
- **Description.** One review record opened on its own page. It shows:
  - the PR and the head SHA
  - the verdict
  - the findings grouped by severity, with file:line (as `FindingsBySeverity` does today, `src/app/review/components/FindingsBySeverity.tsx:13-55`)
  - the verification requests
  - the status emoji (⏳, 🟢, 🔴, 🟡, plus ✅ once merged)
  - the approval state: auto-approved, force-approved, skipped (with the reason) or failed, with the SHA
  - the event timeline for that PR

- **Read-only (decided 2026-11-04).** The page has **no buttons and no actions at all**: no approve, no retry, no force approve, no re-review. It only shows the result. Approve, force approve and re-review exist **only** as Slack thread commands (`approve`, `force approve`, `review`, `updated`; FR-SLACK-13, FR-SLACK-14). The only web action on a PR is the Merge button on `/merge` (FR-SHIP-05). A plain link to `/merge` is **(assumed)**.

- **AC.**
  1. The page renders no form, button or server-function call that writes anything. A stale review shows the notice "PR changed since this review" and no action.
  2. Opening a record for another repo returns 404, not 403, so allowlisted repos are not enumerable **(assumed)**.
- **Implemented (`0c9b6ce`).** `src/routes/_authed/review.$reviewId.tsx` and `src/functions/review.logic.ts`, with no write path.

#### FR-REVIEW-08 Single server-held GitHub account (decided)

- **Decision (2026-11-04).** There is exactly **one** GitHub account. The owner configures it in the app (FR-GITHUB-01..06), not through env. Every GitHub call, from the web, Slack or the `merge` command, uses that one token, which is read on the server.
- **S3 is moot.** No request can choose an account. Any `x-github-account` header is ignored.
- **Removed from legacy:**
  - the two-account map (`src/lib/accounts.ts:1`)
  - the `x-github-account` header (`src/app/api/execute/route.ts:20`, `src/app/api/pulls/open/route.ts:14`)
  - the top-bar `AccountSwitcher` with its localStorage key (`src/components/AccountSwitcher.tsx:31-38`)
  - the env vars `GH_TOKEN_WGBX`, `GH_TOKEN_ZHIYONG_ENG` (`src/server/config.ts:314-320`) and `SLACK_REVIEW_GITHUB_ACCOUNT` (`:226`)
- **"Own PR" (decided 2026-11-04).** A PR is the owner's own when its author equals the **login of the connected GitHub account** (FR-GITHUB-02), and only then. This drives the self-approve rule (`src/domain/ship/policy.ts:112-119`) and the own-PR Copy+Merge row. It replaces the hard-coded `zhiyong-eng` (`src/domain/ship/authors.ts:7-10`). With no token, nothing is an own PR, and the GitHub features show FR-GITHUB-05.
- **AC.**
  1. A request with `x-github-account: anything` behaves exactly like one without it.
  2. `config.ts` no longer accepts the `GH_TOKEN_*` keys. A leftover key only produces a boot-time warning.

---

### 2.3 Ship, approve and merge (FR-SHIP)

#### FR-SHIP-01 Review verdict, auto-approve on 🟢, merge always manual (decided 2026-11-04)

- **Decision.** **Merge is always manual and separate**, triggered only by the owner, on the web or in Slack. **A passing review (🟢) automatically submits a GitHub APPROVE** (decided 2026-11-04). This supersedes the earlier "a review never approves" rule and Q25's premise. The earlier "`merge` approves first" rule stays superseded, and Q15 stays closed.
- **Auto-approve on 🟢 (decided 2026-11-04).**
  - **Sources.** Every review: the first Slack review, the requester's `updated`, the owner's `review` (FR-SLACK-14), and web-triggered reviews **(assumed)**.
  - **SHA pinning.** The APPROVE is pinned to the reviewed head SHA (FR-SHIP-03). If the PR head changed between the review and the approve, the approve is skipped and the thread (or the web detail) says to re-review.
  - **Policy checks still apply:**
    - the repo is in the list (FR-SHIP-02), and the token has write access;
    - the PR is open, not a draft and not merged;
    - the PR is not the connected account's own (FR-REVIEW-08; GitHub forbids self-approval). If it is, the approve is skipped, and the thread says so.
  - **Record.** An `approved` event (FR-REVIEW-06) with actor = system on behalf of the owner, the SHA, the GitHub review ID, and the reason "auto: review passed". A skipped or failed auto-approve is also recorded, as `approve_skipped` or `approve_failed` with the reason.
  - **Outcomes (implemented, `013dbff`, `524723f`).** Each 🟢 URL ends with exactly one outcome, `approved | approve_skipped(reason) | approve_failed`, stored as a checkpoint before the URL completes. **An approve failure never fails the job.** The skip reasons are the `AutoApproveSkipReason` values in `src/domain/ship/policy.ts`: `not_passed`, `repo_not_allowed`, `pr_merged`, `pr_closed`, `pr_draft`, `own_pr`, `sha_changed` and `already_approved`.
  - **Idempotent.** If the PR is already approved for that SHA, it does nothing. The existing-review lookup (`src/ports/github.ts:92-100`) is reused.
  - **Order.** Verdict → APPROVE → swap ⏳ for 🟢. If the APPROVE fails with a GitHub error, 🟢 is still shown, because it reflects the verdict. The thread reply says that the approval failed, and the event is recorded. The owner can retry with `approve` (FR-SHIP-04).
  - **Residual risk (prompt injection, migration-plan.md §4.1).** Content injected into a PR could steer the LLM to a pass and so produce an **approval** without a human. A **merge** still needs the owner's explicit `merge` (or the `/merge` button), so the human gate stays on merge. Any branch protection that counts this approval toward required reviews is affected by this risk **(assumed; see Q1)**.
- **Review step.** A review (web or Slack) posts the GitHub review comment and records the verdict. A pass is then auto-approved (above). **(Assumed:)** a P0 also submits `REQUEST_CHANGES`.
  - The verdict is derived from the findings. Any P0, or any finding whose severity is not a known non-blocking one, gives `REQUEST_CHANGES` (🔴). Otherwise the review passes (🟢) (`src/domain/ship/policy.ts:154-174`).
  - A review that cannot be read is never a pass (`src/domain/ship/policy.ts:164-165`).
- **Owner actions after a review:**

  | Action        | Slack (exact reply in the review thread) | Web                            | Requirement |
  | ------------- | ---------------------------------------- | ------------------------------ | ----------- |
  | Approve       | automatic on 🟢; `approve` retries       | **none** (detail is read-only) | FR-SHIP-04  |
  | Force approve | `force approve`                          | **none**                       | FR-SHIP-06  |
  | Merge         | `merge`                                  | Merge button on `/merge`       | FR-SHIP-05  |

- **Removals (changes still to make in code):**
  - ShipPolicy's `ship` mode is split. **Auto-approve is back** (on 🟢 only, above). **Auto-merge stays removed.**
  - `mergeDecision` is reduced to a review-verdict function: P0 → REQUEST_CHANGES, else pass. It no longer decides whether to merge.
  - The `authorMergeable` input and the no-merge author list (`src/domain/ship/authors.ts:50-65`) are removed.
  - The **system** actor can never merge or force-approve. It may approve only through the auto-approve path, when the verdict passes and the SHA matches.
- **AC.**
  1. A finished 🟢 review, on web or Slack, makes exactly 1 APPROVE call at the reviewed SHA and 0 merge calls. A 🔴 review makes 0 APPROVE calls and 0 merge calls.
     1a. Head moved between the review and the approve: 0 APPROVE calls, and the reply says to re-review.
     1b. The connected account's own PR: 0 APPROVE calls, and the reply says that self-approval is not possible.
     1c. Already approved at that SHA: 0 new APPROVE reviews.
     1d. APPROVE returns a GitHub error: 🟢 is still added, the reply says the approval failed, and an `approve_failed` event is recorded.
     1e. The `approved` event has actor = system (on behalf of the owner) and the reason "auto: review passed".
  2. The verdict function's table tests: P0 → REQUEST_CHANGES; P1, P2 or Nit only → pass; an unreadable review → not a pass.
  3. Only the auto-approve path can approve without a user.
  4. The comment is in English. The UI copy may be in Chinese (docs/slack-pr-review.md:12).
- **Legacy:** Ship approved every PR without a P0, and merged it unless the author was on the no-merge list (`src/lib/ship-pr.ts`, `src/lib/slack-review-runner.ts:6-28`).

#### FR-SHIP-02 Repository allowlist (S2)

- **Decision (2026-11-04).** The allowlist is the **repo list stored in `/settings`** (FR-GITHUB-07), in PostgreSQL. `GITHUB_REPO_ALLOWLIST` is removed from env, and there is no hard-coded repository.
- **Description.** Every ship, approve, merge and force-approve path, on both web and Slack, checks that the PR's `owner/repo` is in the list. The match is case-insensitive on the canonical form. **An empty list denies everything.** The existing policy check (`src/domain/ship/policy.ts:71-80`) stays, and is passed the stored list instead of the env list (`src/server/config.ts:189-200`).
- **Errors.** 403 `forbidden`, "Repository is not in your repo list". The UI links to `/settings`.
- **AC.**
  1. With an empty list, every write action returns 403 and the UI shows "未配置仓库 → /settings".
  2. A repo that was removed from the list is refused for new reviews, approvals and merges. Its history stays readable.
  3. The Slack URL matcher (FR-SLACK-03), the PR list (FR-REVIEW-01) and the write gate all read the same stored list.
  4. The web buttons are covered, not only the Slack path (migration-plan.md:90).
  5. `config.ts` no longer parses `GITHUB_REPO_ALLOWLIST`.
- **Legacy:** `merge` and `force_approve` acted on any repo the token could reach (`src/app/api/execute/route.ts:39-121`). Only the Slack path was limited, to one hard-coded repo (`src/lib/ship-pr.ts:59-65`).

#### FR-SHIP-03 SHA pinning and stale-review guard

- **Description.** The review, the comment, the GitHub review and the merge are pinned to the head SHA that was reviewed.
  - Before each write, the PR is re-read. If the head SHA, the base or the base SHA changed, or the PR is no longer open, the operation stops with `conflict` (`src/lib/ship-pr.ts:77-83,145-154`).
  - The merge passes `sha` to GitHub, so GitHub rejects a moved head (`src/ports/github.ts:105-106`).
- **AC.** A head that moves between the review and the merge yields no approval and no merge. The UI explains that the PR changed.

#### FR-SHIP-04 Approve: automatic on 🟢, manual retry (decided 2026-11-04)

- **Description.** Approve submits a GitHub `APPROVE` review pinned to the **current head SHA**. It never merges. **Normally it runs automatically when a review passes (FR-SHIP-01).** The manual entry points below are a **retry** for when the auto-approve was skipped (for example the head moved) or failed.
- **Entry points:**
  - automatic, when a review passes (FR-SHIP-01)
  - the owner's Slack reply `approve` in the review thread, as the manual retry (FR-SLACK-13)

  There is **no web entry point**: `/review/$reviewId` is read-only (FR-REVIEW-07, decided 2026-11-04). Both entry points run the same use case.

- **Preconditions.** All must hold, or the action is refused:
  1. The repo is in the list (FR-SHIP-02).
  2. The actor is the owner, a user, **or** the system on the auto-approve path.
  3. The PR is open, not a draft and not merged.
  4. The PR is not the connected account's own (FR-REVIEW-08, `src/domain/ship/policy.ts:112-119`).
  5. The latest review is for the **current** head SHA. If there are new commits since the review, it is refused with "new commits since review, re-review needed".
  6. The latest review for that SHA **passed** (🟢). If it is 🔴, it is refused with a pointer to `force approve` (Slack only, FR-SHIP-06).
- **Already approved.** If an approval (normal or forced) is already recorded for this SHA, the action is a no-op that just replies "already approved". No GitHub call is made.
- **`hasApproval(ref, sha)` (decided, `f334203`).** The GitHub check looks only at the connected account's **latest** review that is `APPROVED` or `CHANGES_REQUESTED`. It is an approval only if that review is `APPROVED` on `sha`. Comment-only reviews and dismissed reviews are ignored.
- **Output.** The GitHub review ID. An `approved` event (FR-REVIEW-06) with the actor, the SHA, the GitHub review ID, the source (auto, web or slack) and the time. **Emoji:** none is added, so 🟢 stays **(assumed, Q25)**. The approval shows on the web and in the thread reply.
- **Errors.** 403 (repo not in list, own PR). 409 (stale SHA, 🔴 verdict, closed, draft, merged, or no review on record). 502/503 upstream.
- **AC.**
  1. When the head SHA differs from the reviewed SHA, it is refused and no GitHub call is made.
  2. With a 🔴 latest review, it is refused, the message names `force approve`, and there is no GitHub call.
  3. Repeating Approve for the same SHA does not create a second GitHub review. An existing review by the authenticated user on that commit is found first (`src/ports/github.ts:92-100`).
  4. Approve makes 0 merge calls.
  5. The `approve` reply on an SHA that was already auto-approved replies "already approved" and makes 0 GitHub calls.
  6. No web route or server function exposes approve to the browser.
- **Gap.** There is no separate Approve use case or policy mode today. `canExecute` knows only `ship | merge | force_approve` (`src/domain/ship/policy.ts:13`).

#### FR-SHIP-05 Explicit Merge (new)

- **Description.** Merge is a separate, explicit owner action. There are two entry points, and both run the same use case and the same gates:
  - the Merge button in the **`/merge`** view (decided). That view lists the reviewed PRs that are waiting to be merged, each with its gate status: **已批准** (approved for this SHA), head SHA unchanged, no P0, mergeable, checks green. The button is enabled only when **every** gate passes. Below that is the merge history, with the merge SHA, the actor and the source (web, or the Slack `merge` reply).
  - the Slack `merge` thread command (FR-SLACK-13, decided).
- **Merge only (decided 2026-11-04).** Merge **never approves**.
- **Preconditions.** All must hold:
  1. **An approval, normal (`approved`) or forced (`force_approved`), is recorded for the CURRENT head SHA.** Otherwise it is refused with **"请先 approve（或 force approve）"**. GitHub's `reviewDecision` alone is not enough **(assumed)**.
     1a. The actor is the owner.
  2. The repo is on the allowlist.
  3. The head SHA is unchanged since that approval.
  4. The latest review for the head SHA has no P0 finding, **unless** there is a `force_approved` event for this same head SHA (FR-SHIP-06).
  5. GitHub reports the PR as mergeable. **Unknown mergeability is a failing gate** (`mergeableUnknown`, "try again shortly"): the adapter re-reads a bounded number of times, then fails closed (`c3fed41`).
  6. The required status checks are green, on both entry points (`GitHubPort.getChecks`, `f334203`).
- **Shared rules (decided, `c3fed41`).** `mergeChecklist` (the gate list shown on `/merge`) and `mergePr` (the action) run the same gates in `src/application/ship/ship.ts`, so the page can never enable a merge that the action refuses.
- **Head pinning.** The merge pins the head SHA that the user confirmed (`expectedSha`). If the live head differs, the merge is refused with `headMoved` **before any write**.
- **No approve-first.** The earlier "`merge` approves first" rule is **superseded** (2026-11-04).
- **Merge method (decided, `f334203`).** There is **no env var**. The container sets a preference list, with the legacy method (`merge`) first, and the GitHub adapter picks the first method the repository allows. No allowed method is a `conflict`. Making the list configurable on `/settings` is a possible stage-4 item **(assumed)**. Q13 is closed.
- **`/merge` page (implemented, `159036f`).**
  - The gate checklist is live, read from GitHub when the page loads.
  - Merge opens a confirmation dialog that shows the **full** head SHA.
  - Merges are rate-limited to **10 per minute per user** (fails closed).
  - GitHub's raw error text is never shown; the page maps reasons this codebase wrote to fixed copy (S4).
  - The queue checks at most **50 PRs**, at most **6 concurrently**.
- **Output.** `{ merged: true, sha }`. A `merged` event is appended with the resulting merge commit SHA (`src/ports/github.ts:70`). If the PR has a Slack origin, FR-SHIP-08 then adds ✅. This applies to both entry points, the web `/merge` button and the Slack `merge` reply.
- **Errors.** 403 (repo not in list). 409 (no approval for the current SHA, stale SHA, P0 without a force approval for this SHA, not mergeable, checks not green, already merged). 502/503 upstream. A merge refused by GitHub appends `merge_failed`.
- **AC.**
  1. Each precondition, on its own, blocks the merge with a distinct reason.
  2. A merge request with the wrong `sha` is rejected by GitHub and reported as 409.
  3. The event records the merge SHA.
  4. A merge started from the web `/merge` button for a Slack-origin PR also triggers FR-SHIP-08.
  5. With no approval for the current SHA: refused with "请先 approve（或 force approve）", and **0 APPROVE calls and 0 merge calls**.
  6. Approval at SHA X followed by a push to Y: merge is refused until there is a re-review and a new approval at Y.
  7. GitHub has not computed mergeability yet: the gate fails with `mergeableUnknown`, and there is no merge call.
  8. The page showed head X, and the live head is now Y: refused with `headMoved`, with no GitHub write and no event.
- **Own PRs.** Own PRs (author == connected login, FR-REVIEW-08; legacy `zhiyong-eng`, `src/domain/ship/authors.ts:7-10`) currently show **Copy** and **Merge** instead of Ship, and they merge without an AI review (`src/app/review/components/PrListItem.tsx:81-109`). The current `mergePlan` checks only the allowlist and the PR state (`src/domain/ship/policy.ts:180-185`). Whether own PRs are exempt from conditions 1 and 4 is open question Q6.
- **Legacy:** `mode: "merge"` merged whatever head the PR had at that moment (`src/app/api/execute/route.ts:39-48`).

#### FR-SHIP-06 Force approve, Slack only (decided 2026-11-04)

- **Entry point: Slack only.** The owner replies in the review thread with a message whose **entire trimmed text** is `force approve`, compared case-insensitively. The match rules are the same as for `merge` (FR-SLACK-13):
  - The sender's Slack user ID equals the owner's.
  - The thread maps to a recorded review.
  - The message is not an edit, not `message_changed`, and not a bot post.
  - Anything else is ignored and logged with the sender ID.
  - A thread with several PRs asks which PR is meant (Q16).
- **Removed.** There is **no web force-approve button**. The legacy web and API path (`mode: "force_approve"` on `POST /api/execute`, `src/app/api/execute/route.ts:78-121`, and the "Approve anyway (+ Merge)" button in `ShipResultModal`, `src/app/review/hooks/use-review-page.ts:211-215`) is dropped. `/review/$reviewId` only **shows** that a force approval happened.
- **Policy checks that still apply** (`src/domain/ship/policy.ts:82-125`):
  - the repo is in the list (FR-SHIP-02)
  - the PR is open, not a draft and not merged
  - it is **not the connected account's own PR** (FR-REVIEW-08)
  - the head SHA is a valid full SHA
  - a review record exists for the PR
  - **the latest review is for the current head SHA (decided, `8d47c50`).** If new commits arrived since the review, force approve is refused with "new commits since review, re-review needed": the owner must reply `review` (or the requester `updated`) first, so a force approval never covers unreviewed commits.
- **Effect: approve only.**
  1. Submit a GitHub `APPROVE` review pinned to the **current head SHA**. The GitHub review is matched first, so a retry does not create a duplicate (FR-SHIP-07).
  2. Append a `force_approved` event with the actor (the owner via Slack), the head SHA, the **overridden verdict** (for example REQUEST_CHANGES with N P0 findings), the review ID and the time.
  3. It does **not** merge. The `force_approved` event counts as the approval for this SHA that FR-SHIP-05 requires. Merging is a separate step, through the `merge` reply (FR-SLACK-13) or the `/merge` button (FR-SHIP-05).
- **Waiver at merge time.** The "no P0" merge gate (FR-SHIP-05, precondition 4) is waived **only** if there is a `force_approved` event for the **same head SHA** as the PR's current head. New commits void the override, and a normal review is needed again. All other merge gates still apply: allowlist, open and not draft, mergeable, checks green, and SHA pinning.
- **Emoji.** The verdict reaction is swapped on the message that carries the verdict: 🔴 is removed, then 🟡 `large_yellow_circle` is added. This uses the same outbox, ordering and per-PR tracking as FR-SLACK-14. After a confirmed merge, ✅ is added next to 🟡 (FR-SHIP-08). 🟡 counts as the PR's one verdict emoji, and a later re-review replaces it.
- **Web.** `/review` and `/merge` show 🟡 **强制批准**, with the override noted ("P0 overridden by owner at <sha>").
- **Already passing (assumed).** If the latest review already passed (🟢), `force approve` replies "already approved by review — use `approve`" and changes nothing.
- **Thread replies.** On success, "force-approved at <short sha>; reply `merge` to merge" **(assumed wording)**. On refusal, the gate that failed, with generic text (S4).
- **ShipPolicy change (done, `8d47c50`).** `forceApprovePlan` returns only `approve_only` or `noop`. The `approve_and_merge` variant, the `authorMergeable` input and the merge outcomes of force approve are removed. The no-merge author list no longer applies to force approve.
- **AC.**
  1. `force approve`, `Force Approve` and `FORCE APPROVE` from the owner in a review thread submit one APPROVE at the current head SHA and make **0** merge calls.
  2. `force approve please`, the same text from another user, an edit, or a bot post: no GitHub call, and the attempt is logged.
  3. On the owner's own PR, on a closed or draft PR, or on a repo not in the list: refused, with no GitHub call.
  4. After a force approve at SHA X, `merge` with head X and a P0 on record passes the P0 gate. With head Y ≠ X, it is refused with "new commits since force approve, re-review needed".
  5. The reactions go: `remove(red_circle)`, then `add(large_yellow_circle)`. After the merge, `add(white_check_mark)`. 🟡 is not removed.
  6. With the latest review green: the reply is "already approved by review", and there are no GitHub or reaction calls.
  7. No web route or server function accepts a force-approve request. A contract test checks this.
  8. Latest review at SHA X, head now Y: `force approve` is refused with "new commits since review, re-review needed", with no GitHub call.

#### FR-SHIP-07 Idempotent GitHub writes

- **Description.** Each write is checkpointed per PR URL in `progress` before the state advances. The checkpoint flags are monotonic, and `commentId`, `githubReviewId` and `review` are write-once (`src/domain/review-queue/state-machine.ts:74-148`).
  - A comment carries a hidden marker, `<!-- review:<sha256(requestId:sha)> -->`, so a retry finds it instead of posting a second comment (`src/lib/ship-pr.ts:155-177`).
  - A GitHub review is matched by actor, commit and state before a new one is submitted (`src/lib/ship-pr.ts:179-209`).
  - The rule "already merged → mark merged" survives restarts (`src/lib/ship-pr.ts:140-143`).
- **AC.** Kill the consumer after each step, let the lease expire and reclaim the job. The msw call counts then show at most one comment, one review and one merge per job (architecture.md §8).
- **Implemented (`013dbff`, `524723f`).** The review and ship use cases run on the ports, and `UrlProgress` carries the checkpoints, including the auto-approve outcome.

#### FR-SHIP-08 Merge completion marks ✅ (decided 2026-11-04)

- **Trigger.** GitHub confirms a merge (`merged: true` and a merge commit SHA), started from either the web `/merge` button or the Slack `merge` reply. The PR also has a **Slack origin**: its review record came from a Slack job, so its `channel` and `ts` are known (`review_job.slack`, `src/adapters/db/schema.ts:20-55`).
- **Actions:**
  1. Add the `white_check_mark` reaction to the **original Slack message that contained the PR link**, as the owner with the stored Slack user token (FR-SLACKCFG-02). An `already_reacted` response counts as success. This is the legacy behaviour (`src/lib/slack-review-config.ts:60-68`).
  2. Post a short thread reply with the merge SHA **(assumed: keep it)**. If the merge came from the Slack `merge` reply, this is the outcome reply of FR-SLACK-13 step 3, not a second message.
- The verdict reactions 🟢 and 🔴 are added at review time by FR-SLACK-08. 🟢 stays after ✅ is added.
- **Never** add ✅ when a review completes, when a PR is approved, or when a merge is refused or fails. On a refusal or failure, the reason goes in a thread reply and no reaction is added.
- **No re-review after a merge (decided).** A merged PR is final: `review` and `updated` start no new round for it, and **✅ is never removed** (the status-emoji machine has no transition out of a merged state, `src/domain/slack/status-emoji.ts`).
- **Reaction failure.** The merge stays recorded as **successful**: the `merged` event and the merge SHA are already persisted. The failure is logged, and the reaction is retried by the outbox drainer with backoff, up to a bound **(assumed: 24 h)**. A failed reaction never rolls back or re-attempts the merge. The retry runs from a durable outbox row that is written in the same transaction as the `merged` event.
- **Web.** `/merge` history and `/review/$reviewId` show a **✅ 已合并** badge for merged PRs, whether or not the PR had a Slack origin.
- **AC.**
  1. After a successful merge on a Slack-origin PR, `reactions.add` is called once, with the original `channel` and `ts`.
  2. `already_reacted` counts as success, and no retry is scheduled.
  3. A failed `reactions.add` leaves the merge recorded as successful, logs a warning and schedules a retry. A restart does not lose the pending reaction.
  4. With a refused merge, a GitHub merge error, an approve-only action or a finished review, `reactions.add` is called 0 times.
  5. A PR that did not come from Slack makes no Slack calls when it is merged.
  6. A merged PR shows the ✅ 已合并 badge in `/merge` history and on its review detail page.

---

### 2.4 Slack-triggered review (FR-SLACK)

#### FR-SLACK-01 Events API ingress

- **Description.** `POST /api/slack/events` verifies the Slack signature on the **raw** body. It uses HMAC-SHA256 over `v0:<ts>:<body>`, a ±300 s replay window, and a constant-time compare (`src/lib/slack-signature.ts:4-19`, `src/domain/slack/signature.ts`).
  - It answers `url_verification` with the challenge.
  - It acknowledges with 200 within Slack's 3 s budget, and does the work asynchronously. **Implemented (`65130e3`):** the route verifies, acks first, then processes. **Known gap:** an event that was acked is lost if the process crashes before it is processed, because Slack does not retry an acked event.
- **Errors.**
  - 401 for a bad or missing signature.
  - 400 for invalid JSON.
  - 503 `not_configured` when no signing secret is stored (FR-SLACKCFG-05).
  - 500 on an internal failure, which makes Slack retry.
- **AC.**
  1. A valid signature without a session returns 200 (migration-plan.md:189).
  2. A body modified after signing returns 401.
  3. A timestamp older than 300 s returns 401.
- **Legacy:** identical, but it ran `after()` work on Vercel (`src/app/api/slack/events/route.ts:39-41`).

#### FR-SLACK-02 Event dedupe

- **Description.** The HTTP Events API route may receive repeated deliveries of the same event. Each event is claimed with `SET slack:event:<event_id> 1 NX EX 86400` before any side effect (migration-plan.md:109-111, `src/adapters/redis/redis-event-dedupe.ts:9-13`).
  - The review job ID is derived from `team:channel:ts` (`src/domain/slack/review-rules.ts:89`), which is a second layer of deduplication: a duplicate job id is a `conflict` and enqueues nothing.
- **Errors.** If Redis is unavailable, the claim **fails closed**: the event is not processed, and Slack's retry gets a non-2xx response (architecture.md §8).
- **AC.**
  1. Concurrent `ingestSlackEvent` calls with the same `event_id` create one job and one "on it" reply.
  2. A Slack retry of an accepted event creates nothing new.

#### FR-SLACK-03 Message matching

- **Decided 2026-11-04.** Anyone in the configured Slack workspace can start a review. They @mention the owner, in an allowed channel or a DM, with a message that contains a PR URL for a **repository in the `/settings` repo list** (FR-GITHUB-07). Any other link, or a message with no PR link, is **ignored silently**: no reply and no job. With an empty repo list, nothing triggers.
- **Description.** A message triggers a review only when **all** of the following hold (`src/domain/slack/review-rules.ts:47-96`):
  - The payload is an `event_callback` for the configured team, authorised for the owner's user (not a bot).
  - The event is a human `message`. It is not a bot message, not hidden, and its subtype is none, `file_share` or `thread_broadcast`. Edits and deletes are ignored.
  - The sender is any user in the workspace. There is **no sender allowlist** (FR-SLACK-04). **The owner's own messages never start a review** (decided): the app posts as the owner, and the owner uses the `review` thread command instead.
  - It was **sent** during active hours, UTC+8 [09:00, 19:00), judged by the message `ts` (`src/domain/slack/review-rules.ts:26-32,79-80`). Messages outside those hours are dropped, not queued for later.
  - The text mentions the owner (`<@USER>`).
  - In a channel (anything that is not a DM), the channel is in the **review channels** selected on `/settings` (FR-SLACKCFG-04). An empty selection means all channels; DMs always count.
  - The text contains at least one `https://github.com/<owner>/<repo>/pull/<n>` URL whose `owner/repo` is in the stored repo list. The match is case-insensitive, and the URL is normalised to the canonical `owner/repo` form from the list. Suffixes `/files`, `/changes`, `/commits` and `/checks` are allowed. URLs are deduplicated after normalisation.
- **AC.** The table tests in `src/domain/slack/review-rules.test.ts` pass, including each rejection reason.
- **Done (`1f47b66`).** `extractReviewPrUrls(text, repoList)` replaces the hard-coded regex. The matcher stays pure: the list is passed in, never read from the database inside the domain.

#### FR-SLACK-04 Sender policy (decided: no sender allowlist)

- **Decision (2026-11-04).** `SLACK_REVIEW_ALLOWED_USER_IDS` is **dropped** as a trigger gate. Any workspace member may trigger a review, which keeps the legacy behaviour (docs/slack-pr-review.md:10).
- **Cost and abuse control** comes from four other gates:
  - the review channels selected on `/settings` (FR-SLACKCFG-04)
  - the rate limit, S6 **(assumed: per Slack sender and globally; values in Q11)**
  - event dedupe (FR-SLACK-02)
  - active hours (FR-SLACK-03)
- **Done (`1f47b66`).** The sender allowlist check and the `allowedUserIds` option are removed. `SLACK_REVIEW_ALLOWED_USER_IDS` is removed from env (§4).
- **AC.**
  1. A mention with a valid PR URL from any non-bot workspace member, in an allowed channel and within active hours, creates a job.
  2. A sender over the rate limit gets no job. Whether they get a reply is **(assumed: no reply, logged only)**.
- **UI copy.** "Whitelisted members" (`src/app/review/components/SlackReviewStatus.tsx:100`) must be reworded to match the decision.
- **Legacy:** any sender could trigger a review. `senderIds` existed on `RuleOptions` but was never checked (`src/lib/slack-review-rules.ts:16`).

#### FR-SLACK-05 Enqueue and acknowledge

- **Description.** A matched message creates a `review_job` with `source='slack'` and `state='queued'`, and wakes the consumer through `WakeUp`, which is Redis pub/sub and optional (architecture.md §5.2).
  - On **first** creation only, the app replies `on it` in the message's thread (`src/app/api/slack/events/route.ts:49-56`).
- **Errors.** A failed "on it" reply is logged and does not fail the event.
- **Accepted reaction ⏳ (decided 2026-11-04).** As soon as a request is **accepted** (it passed the trigger rules of FR-SLACK-03: mention, a PR link for a listed repo, active hours, dedupe; and its job was enqueued, including re-review requests), the app adds ⏳ `hourglass_flowing_sand` to the PR's status message as the owner. This happens **before** the LLM runs, through the same durable outbox (FR-SHIP-08, FR-SLACK-14).
  - For a re-review, the previous 🟢, 🔴 or 🟡 is removed first, so the PR still has exactly one status emoji (see the invariant in FR-SLACK-08).
  - For an `updated` or owner `review` round (FR-SLACK-14), the status message is the original message that contains the PR link (decided). A new top-level request moves the status to the new message **(proposed, Q24)**.
  - A request skipped because there are **no new commits** gets **no ⏳** (FR-SLACK-14 (a)).
- **AC.**
  1. A duplicate delivery never sends a second `on it`, and never adds a second ⏳.
  2. An accepted request gets `reactions.add(hourglass_flowing_sand)` before the review's first LLM call **(assumed: before it is claimed)**.
  3. A rejected message (any FR-SLACK-03 rule fails) gets no reaction.

#### FR-SLACK-06 Review job state machine

- **Description.** The job lifecycle is the pure function `transition(job, event, now)` (`src/domain/review-queue/state-machine.ts`). The states are `queued`, `running`, `done` and `failed`; `reaction_pending` is gone (`013dbff`). The events include `claimed`, `lease_expired`, `interrupted`, `interruption_limit`, `checkpoint`, the auto-approve steps, `url_completed`, `deferred`, `all_completed`, `reply_sent`, `failed` and `retry`.
- **Rules:**
  - `done` and `failed` are terminal. `retry` takes `failed` back to `queued` and clears `lastError`, `interruptions` and `resultReplySent` (deviation D3).
  - The third consecutive interruption moves the job to `failed` with the category `interrupted` (`MAX_INTERRUPTIONS = 3`). A completed review resets the counter.
  - **A lease-expired reclaim counts as an interruption (decided, `cb079da`).** The claim query increments `interruptions` atomically when it takes over a `running` job whose lease expired. If the reclaimed job has reached the limit, the new owner does not run it: it sends the domain event `interruption_limit`, which fails the job as `interrupted` through the normal terminal transition, so the review record, the outbox rows and the result reply are still written (D12).
  - Reactions are not part of the job. Every job goes from `all_completed` straight to `done`; the terminal transition hands reaction intents to the outbox (D9, FR-SLACK-08).
  - An illegal event returns `conflict`. Bad input returns `validation`. The function never throws.
- **AC.** The table tests and property tests (`state-machine.test.ts`, `state-machine.property.test.ts`) pass, and Stryker scores at least 80 % on `src/domain/**` (migration-plan.md:215).

#### FR-SLACK-07 Claim with lease

- **Description.** Consumers claim jobs with one atomic `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. A job is claimable when it is `queued` and due, or `running` with an expired lease (architecture.md §5.1, `src/adapters/db/pg-review-job-repo.ts:93-115`).
  - The consumer is the worker process (FR-SLACK-12). It also reclaims jobs whose lease expired. The web process does not run a consumer.
  - Reclaiming a `running` job with an expired lease increments `interruptions` in the same statement (FR-SLACK-06).
- **AC.** With N parallel claims, each job is claimed exactly once. A crashed consumer's job is reclaimed after its lease expires. The third reclaim fails the job as `interrupted`, with its record, outbox rows and reply written.
- **Legacy:** a Redis lock per job plus a `pending` set, with interruption counting inside the lock (`src/lib/slack-review-queue.ts:66-92`).

#### FR-SLACK-08 Result reply in the thread (decided)

- **Decision (2026-11-04).** When the review finishes, the result is posted in the **same Slack thread**. **A 🟢 review is auto-approved** (FR-SHIP-01, decided 2026-11-04). **Nothing is auto-merged.**
- **Description.** For each PR in the job, the reply contains:
  - the verdict that the findings imply (APPROVE, REQUEST_CHANGES or COMMENT)
  - a findings summary: counts per severity, plus the P0 and P1 titles **(assumed format)**
  - a link to the review record, `/review/$reviewId` (FR-REVIEW-07)
  - the auto-approve outcome: approved at `<sha>`, skipped (with the reason: head moved, own PR), or failed **(assumed wording)**
  - a hint that the owner can reply `merge` in the thread (FR-SLACK-13) **(assumed)**

  **Status emoji invariant (decided 2026-11-04).** At any moment, each PR has **at most one status emoji**: ⏳, 🟢, 🔴 or 🟡. ✅ is the only emoji ever added alongside another, next to 🟢 or 🟡 after a merge.

  ```
  ⏳ → 🔴 → (new commits, re-review) ⏳ → (verdict, auto APPROVE) 🟢 → (merge) 🟢✅
  ⏳ → 🔴 → (force approve) 🟡 → (merge) 🟡✅
  ```

  **Finishing replaces ⏳.** When the review finishes, the app **removes ⏳, then adds** 🟢 or 🔴, through the same outbox. On a pass, the order is verdict → APPROVE → swap ⏳ for 🟢. A failed APPROVE does not hold back 🟢.
  - **Errored review:** ⏳ is removed, the reason is posted as a thread reply, and no verdict emoji is added.
  - **Lease expired and job reclaimed:** ⏳ stays until the final outcome.
  - **Abandoned after the maximum attempts** (`MAX_INTERRUPTIONS`, FR-SLACK-06): ⏳ is removed, and the error is posted in the thread.

  **Verdict reaction (decided 2026-11-04).** When the review finishes, the app reacts on the **original Slack message that contained the PR link**, as the owner with the stored Slack user token:

  | Reaction                | Meaning                                                                                                                      |
  | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
  | 🟢 `large_green_circle` | The verdict passes: there is no P0, and the PR is mergeable per the review (APPROVE, or COMMENT without a P0 **(assumed)**). |
  | 🔴 `red_circle`         | Changes requested: there is a P0, so the verdict is REQUEST_CHANGES.                                                         |
  | ✅ `white_check_mark`   | Added later, only on a confirmed merge (FR-SHIP-08). ✅ is **not** added on review completion.                               |
  - **One verdict reaction per PR.** A PR carries at most one of 🟢 and 🔴 at a time, and it reflects the **latest** review only. On a re-review, for example after new commits, the app first removes the previous verdict reaction with `reactions.remove` (where `no_reaction` counts as success), then adds the new one. The re-review flow, including which message carries the emoji, is in FR-SLACK-14. After a merge, 🟢 stays alongside ✅.
  - **Failed or errored reviews** get no verdict reaction, and their ⏳ is removed. A previous verdict was already replaced by ⏳ when the re-review was accepted, so after an errored re-review the PR has **no** status emoji until the next review **(follows from the invariant; it supersedes the earlier "left as it is" assumption)**. The outcome goes in the thread reply `review failed: <reason>` **(assumed)**.
  - **Reaction failures** use the same durable outbox and retry as ✅ (FR-SHIP-08). They never change the review result, its record or its events.
  - **Several PRs in one message.** The emoji are per PR, but a Slack message can carry each emoji only once. The rule is open (Q23). **(Assumed:)** 🔴 if any PR is red; 🟢 only if every PR is green; ✅ only when every PR is merged.
  - **Legacy:** only ✅ was added, after review and ship (`src/lib/slack-review-runner.ts`). There were no verdict emoji.

- **On failure.** The app replies `review failed: <reason>`. The reason is a user-facing text chosen from the `DomainError` kind, never the raw error (architecture.md §7). No ✅ is added.
- **State machine impact (done, `013dbff`).** `reaction_pending` is removed. A job goes from `all_completed` to `done`, and every reaction, including ✅ after a merge, is a row in the reaction outbox.
- **Reaction outbox (decided, `a37d726`, `524723f`).** When a newer review supersedes an older one, the outbox drops the older pending ops and rebuilds them with `convergeOps(placed, latest)`, which diffs the target set against the reactions actually placed (`src/domain/slack/status-emoji.ts`).
- **Result reply delivery.** The reply is retried, but it is **dropped after 3 Slack refusals**, and the drop is logged (known gap).
- **AC.**
  1. The result reply is sent at most once (`resultReplySent`).
  2. A 🟢 Slack-triggered review makes exactly 1 GitHub APPROVE call before the 🟢 reaction, and **no** merge call. A 🔴 review makes no APPROVE call (msw call counts).
     2a. A passing review adds 🟢, and a P0 review adds 🔴, on the original message. Neither one adds ✅.
     2b. A re-review that changes the verdict from 🔴 to 🟢 calls `reactions.remove(red_circle)` and then `reactions.add(large_green_circle)`. If the remove returns `no_reaction`, the add still happens.
     2c. A failed review calls `reactions.add` 0 times.
     2d. If `reactions.add` fails, the review stays `done` with its verdict, and a retry is scheduled in the outbox.
  3. The reply links to an existing review record (FR-REVIEW-05).
  4. The reply text never contains the raw LLM output or any secrets.
- **Legacy:** the reply said `approved`, `approved with minor issues` or `see comment` **after** approving or merging (`src/lib/slack-review-runner.ts:6-28`). Failure text was chosen by matching Chinese error strings (`:30-45`).
- **Security effect.** A human must still act before any **merge**, so the prompt-injection merge gate (migration-plan.md §4.1, Q1) stays closed for merge. Approval is now automatic on 🟢, which is a recorded residual risk (FR-SHIP-01).

#### FR-SLACK-09 Retry failed jobs

- **Description.** The owner can re-queue failed jobs. They resume from their checkpoints. A job whose PR SHA changed fails again, and the owner is pointed to a fresh web Ship (docs/slack-pr-review.md:68).
- **Trigger.** A UI action on the review page **(assumed)**, replacing `pnpm slack:review:retry` (`scripts/slack-review-retry.ts`) and `--retry-failed`.
- **AC.** Retrying never repeats a completed GitHub write (FR-SHIP-07).

#### FR-SLACK-11 Slack review status panel

- **Description.** The review page and the workbench show the panel "Slack auto review":
  - a listening state: `listening`, `resting` (outside active hours), `not started`, or `unavailable`
  - the active hours
  - the configured GitHub account
  - the most recent 10 visible jobs, each with its state label, its PR links, its error, and per-PR **Ship** buttons
  - **Read** and **Mark all read** buttons for finished jobs (`src/app/review/components/SlackReviewStatus.tsx:20-146`)

  A job is visible until it is marked read, either individually or by a `read_before` cursor (`src/lib/slack-review-queue.ts:32-46`). Read state is per user, in `review_job_read` and `read_cursor` (architecture.md §5.1).

- **Polling.** TanStack Query polling, which replaces a 15 s `setInterval` (migration-plan.md:231).
- **AC.**
  1. The Ship button is disabled for a URL that is still in a queued or running job.
  2. Marking read hides only finished jobs.
  3. Viewing the panel no longer triggers queue draining. **Legacy:** a page view could drain the queue at most once a minute (`src/app/api/slack/review-status/route.ts:34-37`). The worker's consumer replaces this.

#### FR-SLACK-12 Review worker

- **Description.** `scripts/slack-review-worker.ts` becomes a production service (`agent-ops-slack-worker`). It shares the PostgreSQL queue and the Redis dedupe with the web process (migration-plan.md:237).
- **Processes.** The worker process runs the review job consumer and reaction outbox drainer for HTTP-ingested jobs. The web process does not run these loops. The consumer reclaims jobs whose lease expired (FR-SLACK-07), so no separate backstop is needed.
- **Settings changes.** Saves publish `slack-settings:changed` to invalidate cached User token and Signing Secret reads.
- **AC.** Repeated HTTP deliveries create one job (FR-SLACK-02).
- **Legacy:** state lived in a local file (`.agent-ops/slack-review.json`).

#### FR-SLACK-13 Slack thread commands: owner `review`, `approve`, `force approve`, `merge`; requester `updated` (decided)

- **Decision (2026-11-04).** The owner's commands in a thread are `review`, `approve`, `force approve` and `merge`. The requester's only command is `updated`. Only the owner can approve or merge from Slack. **Each command does exactly one thing.**

  | Reply (exact, trimmed, any case) | Who may send it                                  | Effect                                                                                                                            | Requirement      |
  | -------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
  | `review`                         | Owner only                                       | Start a review round for the thread's PR, even on the same SHA and outside active hours. ⏳, then 🟢 or 🔴.                       | FR-SLACK-14 (a2) |
  | `approve`                        | Owner only                                       | Manual retry of the auto-approve. APPROVE at the current head SHA, only if the latest review is 🟢. Already approved: reply only. | FR-SHIP-04       |
  | `force approve`                  | Owner only                                       | APPROVE despite 🔴, for this SHA only. 🔴 becomes 🟡.                                                                             | FR-SHIP-06       |
  | `merge`                          | Owner only                                       | Merge only. It needs an approval for the current SHA, and **never approves**.                                                     | FR-SHIP-05       |
  | `updated`                        | The original requester only (not even the owner) | Re-review only if the head SHA changed; otherwise reply "上次审核后没有新提交". Active hours apply.                               | FR-SLACK-14 (a)  |

  `review` and `updated` are specified in FR-SLACK-14. Everything below applies to the three owner commands `approve`, `force approve` and `merge`. Where it says `merge`, read "the command".

- **Trigger / input.** A `message` event in a thread whose entire text, after trimming, is `merge`, compared case-insensitively. It must meet all of these:
  - The sender's Slack user ID equals the owner's Slack user ID. That ID is resolved with `auth.test` (`src/lib/slack-review-config.ts:40-45`), and the decision's `SLACK_USER_ID` is not a config key today (Q18). A `merge` from anyone else has **no effect**, and the attempt is logged with the sender ID.
  - The thread (`channel` plus `thread_ts`) maps to a recorded review (FR-REVIEW-05).
  - It is not an edit, not `message_changed`, not `message_deleted`, and not a bot message.
  - Active hours do **not** apply **(assumed, Q17)**.
- **Why whole-text matching.** The app posts its own thread messages with the owner's user token, so those messages carry the owner's user ID. Requiring the text to be exactly `merge` means the app's result replies can never trigger a merge.
- **Processing.**
  1. If the thread's review covers more than one PR, the bot refuses and asks which PR to merge. The syntax for choosing is open (Q16).
  2. Run the matching use case:
     - `approve`: FR-SHIP-04, a manual retry for a skipped or failed auto-approve. On 🔴, the reply points to `force approve`. On new commits, it asks for a re-review. If the SHA is already approved (normally by the auto-approve), it replies and makes no GitHub call.
     - `force approve`: FR-SHIP-06.
     - `merge`: FR-SHIP-05, **merge only**. Without an approval for the current SHA, the reply is "请先 approve（或 force approve）". The other gates also apply: the repo is in the list, the PR is open and not a draft, it is mergeable, and the checks are green. No P0 is required, unless there is a force approval for this SHA. FR-SHIP-03 (SHA pinning) applies.
  3. Reply in the thread with the outcome: the merge commit SHA, or the refusal reason (generic, S4).
     3a. **On a confirmed merge only**, add ✅ to the original message that contained the PR link (FR-SHIP-08, decided). On a refusal or failure, no ✅ is added.
  4. Append the one matching event, `approved`, `force_approved`, `merged` or `merge_failed`, to the review event history (FR-REVIEW-06), with actor = owner, via Slack.
- **Errors.** Every gate failure gives a thread reply naming the failed gate, and no GitHub write. An upstream failure replies with `merge failed: <generic reason>` **(assumed wording)**.
- **Idempotency.** The command is deduplicated by `event_id` (FR-SLACK-02). A second `merge` after a successful merge replies "already merged" and calls GitHub nothing more **(assumed)**.
- **AC.**
  1. `merge`, `Merge` and `MERGE` from the owner trigger the command. `merge please`, `please merge` and `merge` sent by another user do not.
  2. An edited message whose new text is `merge` does nothing.
  3. A thread with no review record does nothing, and the attempt is logged **(assumed: no reply)**.
  4. A thread with 2 PRs gets a disambiguation reply and no GitHub writes.
  5. When the head SHA moved after the review, the bot refuses, suggests a re-review, and makes no APPROVE or merge call.
  6. Success replies with the merge SHA, adds ✅ to the original trigger message, and appends events with actor = owner and source = slack.
  7. A refused or failed `merge` adds no reaction.
  8. `merge` with no approval for the current SHA: the reply is "请先 approve（或 force approve）", with 0 APPROVE calls and 0 merge calls.
  9. `approve` on a 🟢 review whose auto-approve failed gives 1 APPROVE call and 0 merge calls, and the emoji is unchanged **(Q25)**. On an already-approved SHA it gives 0 GitHub calls. `approve` on 🔴 is refused, and the reply names `force approve`.
  10. A 🟢 review (auto-approved) followed by `merge` gives exactly 1 APPROVE call in total, then 1 merge call.
- **Implemented (`1f47b66`, `65130e3`).** `parseThreadCommand` (`src/domain/slack/thread-command.ts`), the thread-to-review lookup `ThreadReviewIndex` (`slack_review_thread`), and the dispatch in `src/application/slack/commands.ts`.

#### FR-SLACK-14 Re-review: requester `updated`, owner `review`, and reaction swap (decided)

- **Decided scenario (2026-11-04).** This is the acceptance scenario:
  1. The first review **fails** (the verdict is changes requested, because there is a P0). 🔴 goes on the original message.
  2. The PR author pushes new commits, and the requester replies `updated` in the thread.
  3. The re-review **passes**. The app **removes 🔴** and **adds 🟢**.

  With ⏳ (decided 2026-11-04), the full sequence on the status message is: 🔴 → (re-review accepted) remove 🔴, add ⏳ → (review done) remove ⏳, add 🟢.

  Here "fails" means a REQUEST_CHANGES verdict, not an errored review. An errored review gets no emoji (FR-SLACK-08).

- **(a) Trigger: the `updated` reply (decided 2026-11-04).** This replaces the earlier proposal to treat an @mention in the thread as a re-review.
  - **Who.** The person who originally @mentioned the owner to request the review, which is the **requester recorded on the review** (`review_job.slack.user`). **Only that person** (decided 2026-11-04). An `updated` from anyone else, **including the owner**, is ignored and logged with the sender ID. The owner uses `review` instead (a2).
  - **What.** A reply in **that review's thread** whose entire trimmed text is `updated`, compared case-insensitively. No PR link and no @mention are needed, because the thread maps to its PR or PRs through the review record.
  - **Ignored:** edits (`message_changed`), deletes, bot messages, and any `updated` outside a recorded review thread.
  - **Guards that still apply:**
    - dedupe by `event_id` (FR-SLACK-02)
    - the rate limit (S6)
    - active hours (FR-SLACK-03). Outside them, the app **replies** that reviews run only between 09:00 and 19:00 UTC+8, instead of staying silent **(assumed wording)**.
  - **Behaviour:**
    1. **A review for this PR is already running** (a job that is queued or running): the reply says a review is in progress **(assumed wording)**. Nothing is enqueued.
    2. **Head SHA unchanged since the last review:** the reply is **"上次审核后没有新提交"**. No review runs, and the emoji is unchanged.
    3. **Head SHA changed:** ⏳ replaces the current status emoji on the **original message**, following the invariant in FR-SLACK-08 (remove, then add). A new review job is enqueued and runs.
  - **Several PRs in the thread:** `updated` re-reviews **every PR whose head SHA changed**, and replies "上次审核后没有新提交" for the others **(assumed; see Q23)**.
  - **Code change still to make.** `updated` is a thread command, like FR-SLACK-13. It needs the same lookup from thread to review, which does not exist yet. The trigger matcher (`src/domain/slack/review-rules.ts:34-44,83-86`) is not involved, because `updated` carries no PR URL.
- **(a2) Owner `review` command (decided 2026-11-04).**
  - **Who.** The owner only: the sender's Slack user ID equals the owner's ID from `auth.test` (`src/lib/slack-review-config.ts:40-45`). A `review` from anyone else is ignored and logged.
  - **What.** A thread reply whose entire trimmed text is `review`, compared case-insensitively. The thread's root message, or a message in the thread, must contain a PR link for a repo in the `/settings` list (FR-GITHUB). Edits, deletes and bot messages are ignored. Because the text must be exactly `review`, the app's own replies, posted with the owner's token, cannot trigger it.
  - **Effect.** It starts a review round for that PR. The emoji and status rules are the same as for any review: ⏳ replaces the current status emoji, then 🟢 or 🔴 (FR-SLACK-08).
  - **No earlier review (decided, `65130e3`).** `review` in a thread that has no earlier review is **ignored** (logged, no reply). The manual first review below is **not built**.
  - **After a merge.** No re-review: see FR-SHIP-08.
  - **Assumed details, pending user confirmation:**
    - **Manual first review (not built).** It would work even if the thread has **never** been reviewed, for example because the mention came outside active hours or was missed. The status message would be the message that contains the PR link (the root, if it has one), with the root's author as the recorded requester **(assumed)**. Today such a `review` is ignored (above).
    - **No active hours.** Active hours do not apply to the owner's `review`.
    - **Same SHA re-runs.** With no new commits, `review` still re-runs the review, as a manual override, for example after a model or prompt change. The reply says that this is a re-run on the same SHA.
    - **Already running.** If a review for this PR is queued or running, the reply is **"正在审核中"**, and nothing is enqueued.
    - **Several PRs.** It reviews every listed-repo PR in the thread (Q23).
    - Dedupe by `event_id` still applies.
- **New top-level request (proposed, pending user confirmation).** A brand-new top-level message with the same PR link is treated as a normal new request (FR-SLACK-03). Its status emoji moves to the new message (see (b)).

- **(b) Which message carries the emoji.**
  - **`updated` and `review` paths (decided).** The status emoji stays on the **original** message that contains the PR link. The command reply itself gets no emoji.
  - **New top-level request (proposed, pending user confirmation).** The app removes the status emoji from the earlier message, and puts ⏳, and then the new verdict, on the new message.
  - **Bookkeeping.** For each PR, the app records every reaction it placed, in PostgreSQL. For example, a table `slack_reaction` with `pr_ref`, `channel`, `ts`, `emoji`, `state (pending_add | placed | pending_remove | removed)` and `review_id` **(assumed schema)**. With this record the app can always remove its **own** previous reaction, and never touches reactions that other people added.
  - ✅ (FR-SHIP-08) is placed on the message that carries the verdict when the merge is confirmed **(proposed)**.

- **(c) Order and convergence.**
  - The app **removes the old reaction first, then adds the new one.** Both are durable outbox items, written in the same transaction as the review result.
  - A failed remove is retried, and the add waits until the remove has succeeded, or `no_reaction` was returned **(proposed)**.
  - The system must **converge to exactly one verdict emoji per PR**. Retries are idempotent: `already_reacted` and `no_reaction` both count as success.
  - If a newer review finishes while an older swap is still pending, the older outbox items are superseded. Only the latest review's target state is applied **(assumed: a compare on `review_id`)**.

- **AC.**
  1. **The decided scenario.** P0 review: one `reactions.add(red_circle)` on message M. Then new commits and a re-review that passes: `reactions.remove(red_circle, M)`, **then** `reactions.add(large_green_circle, …)`. At the end, the record holds exactly one placed verdict reaction for the PR.
  2. `updated` with no head-SHA change: no review runs, the reply is "上次审核后没有新提交", and no reaction calls are made.
     2a. `updated` from anyone other than the recorded requester, including the owner: no job, no reply, and the attempt is logged. `updated please`, an edit, or a bot post: ignored.
     2b. `updated` while a review of the PR is running: the reply says a review is in progress, and no second job is created.
     2c. `updated` outside active hours: a reply, and no job.
     2d. `updated` in a thread with PRs A (head changed) and B (unchanged): only A is re-reviewed **(assumed)**.
     2e. Owner `review`, `Review` or `REVIEW` with no new commits: the review re-runs at the same SHA, the reply says it is a re-run, and the reactions go ⏳ → 🟢 or 🔴. `review please`, or `review` from anyone else: nothing happens, and the attempt is logged.
     2f. Owner `review` in a thread that was never reviewed: ignored, with no job and no reply (decided; the manual first review is not built).
     2g. Owner `review` while a review of the PR is running: the reply is "正在审核中", and no second job is created.
     2h. Owner `review` in a thread with no PR link for a listed repo: no job **(assumed: a short reply naming the reason)**.
  3. A new top-level request N for the same PR: the status emoji is removed from M, and ⏳ and then the verdict are put on N **(proposed)**.
  4. The first `reactions.remove` fails, then a retry succeeds. The add happens only after that success, and the final state is one verdict emoji.
  5. Two re-reviews finishing close together leave the latest review's verdict emoji, and only that one.
  6. A reaction that a human added (for example someone else's 🟢) is never removed.
  7. **The decided scenario, with ⏳.** The reaction calls, in order: `add ⏳` → `remove ⏳`, `add 🔴` → (re-review accepted) `remove 🔴`, `add ⏳` → `remove ⏳`, `add 🟢`. After each outbox batch has drained, the PR has exactly one status emoji.
  8. An `updated` re-review skipped because there are no new commits makes no reaction calls, and 🔴 stays.
  9. An errored re-review leaves the PR with no status emoji, and the thread gets a reply with the reason.

---

### 2.7 Information architecture (decided 2026-11-04)

| Path                | Purpose                                                                                                                                                                                                         | Requirements                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `/`                 | Overview: a summary dashboard (the workbench).                                                                                                                                                                  | FR-SLACK-11                                    |
| `/review`           | The open PR list at the top, where a review is started. Below it, the review records and results, filterable by PR, status, source and date, and paginated. It replaces the legacy `GET /api/pulls/open` usage. | FR-REVIEW-01..03, FR-REVIEW-05..06             |
| `/review/$reviewId` | Review detail, **read-only (decided)**: the verdict and status emoji, the findings with file:line, the approval state (auto, forced, skipped or failed), and the event timeline. No buttons.                    | FR-REVIEW-07                                   |
| `/merge`            | Reviewed PRs awaiting merge, each with a Merge button and the gate status. Below them, the merge history: the merge SHA, the actor, and the source (web or Slack `merge`).                                      | FR-SHIP-05, FR-SLACK-13                        |
| `/settings`         | Settings. GitHub section: the single account token and the repo list (FR-GITHUB). Then Slack: the two Slack secrets and the review channels (FR-SLACKCFG). Then LLM (FR-LLMCFG).                              | FR-GITHUB, FR-SLACKCFG, FR-LLMCFG, FR-SETTINGS |
| `/setup`            | The setup wizard: login token (required), then AI, GitHub and Slack (optional). Unreachable once initialized.                                                                                                   | FR-AUTH-01                                     |
| `/login`            | Sign in with the login token.                                                                                                                                                                                   | FR-AUTH-02                                     |

**Navigation (decided 2026-11-04): a flat sidebar.** The labels are exactly these, in English:

```
Overview        → /
Review          → /review
Merge           → /merge
──────────
Settings        → /settings    (bottom of the sidebar, with sign-out, FR-AUTH-08)
```

- **AC.** (1) The sidebar renders exactly these labels in this order. (2) Settings and sign-out sit below the divider.
- The Chinese labels used earlier (工作台, 设置) are replaced. `src/routes/-nav.ts` defines the navigation.
- There is no external link: the legacy "Daily UI tweaks" item (`src/components/AppShell.tsx:7`, still in `src/routes/-nav.ts`) is removed (decided 2026-11-04).

**AC.**

1. These seven page routes are the only ones: `/setup`, `/login`, `/`, `/review`, `/review/$reviewId`, `/merge` and `/settings`. There are no redirects, no aliases and no legacy-URL compatibility (decided 2026-11-04, final). Any other page path returns 404 for a signed-in user. An anonymous user is sent to `/login` first (FR-AUTH-03, `src/routes/$.tsx:4-12`).
   - The external API contracts in §5.1 are not page addresses, and they are unchanged: auth and Slack events.
2. Every route above except `/setup` and `/login` is under `_authed` (FR-AUTH-03).

### 2.8 GitHub settings: token and repo list (FR-GITHUB) (decided 2026-11-04)

#### FR-GITHUB-01 Settings page

- **Description.** `/settings` is an `_authed` page (FR-AUTH-03), with the nav item **Settings** at the bottom of the sidebar, next to sign-out (§2.7). It has no aliases. Its "GitHub" section has two parts: (1) the token: the connection card plus the forms to save, replace and remove it (FR-GITHUB-02..04); and (2) the repo list (FR-GITHUB-07).
- **AC.**
  1. An anonymous `GET /settings` redirects to `/login?redirect=%2Fsettings`.
  2. The page never renders a token value, in the HTML, the loader data or a server-function response.

#### FR-GITHUB-02 Save token, validated first

- **Trigger / input.** The owner pastes a GitHub token and submits. It is a server function and needs a signed-in user.
- **Recommended token (decided 2026-11-04).** A fine-grained PAT whose **repository access is limited to the repos in the list** (FR-GITHUB-07), with these repository permissions:

  | Permission      | Access         | Needed for                                               |
  | --------------- | -------------- | -------------------------------------------------------- |
  | Contents        | read and write | Diffs, blobs and the merge base, plus **merge**          |
  | Pull requests   | read and write | Listing PRs, comments, **approve** and review submission |
  | Checks          | read           | The "checks green" merge gate                            |
  | Commit statuses | read           | The "checks green" merge gate                            |

  GitHub adds Metadata: read automatically. **Verify the exact permission names against GitHub docs when implementing `/settings`.**

- **Validation before saving.** Nothing is stored unless every step passes:
  1. Basic shape check: not empty, at most 255 characters **(assumed)**, no whitespace.
  2. `GET /user` succeeds. Its result gives the login and the avatar.
  3. Every repo already in the list is re-checked (FR-GITHUB-08). A repo that lost access is **flagged**, but the save still succeeds **(assumed)**.
  4. Each check result is recorded per repo. **Implemented:** only read-only calls are used (FR-GITHUB-09).
- **Output.** The connection card (FR-GITHUB-03). A `github_token_saved` event (FR-GITHUB-04).
- **Errors.** Each one shows a clear message and saves nothing:
  - `validation` (400): empty or malformed token.
  - `forbidden` (403, from the use case): "Token rejected by GitHub." when `/user` rejects it (`src/application/settings/github-token.ts:70-71`). The message is shown on the token field (`src/functions/settings.logic.ts:49-61`).
  - `upstream` (502/503): GitHub is unreachable. "Try again", and nothing is saved.
  - The messages never echo the token or the GitHub response body (S4).
- **AC.**
  1. With a token that is invalid or has no repo access, the database row is unchanged (it is still empty, or still holds the previous token).
  2. Validation and the write are one operation. A concurrent save is serialised, and the last validated token wins **(assumed: optimistic version check on the settings row)**.
  3. The token is rate-limited with S6, at 5 attempts per 10 minutes **(assumed)**.

#### FR-GITHUB-03 Storage and secrecy

- **Storage (implemented, commit `7c638a5`).** One row in `github_credential`: `id`, `ciphertext`, `iv`, `auth_tag`, `key_version`, `login`, `avatar_url`, `last4`, `permissions jsonb`, `saved_at`, `saved_by_user_id`, `version`. A check constraint keeps it a single row (`id = 'github'`) (`drizzle/20261104035857_github_settings/migration.sql:1-15`).
  - The token is encrypted with **AES-256-GCM**, with a random 96-bit IV for each write.
  - **Key derivation (decided 2026-11-04).** There is no new env var. The 32-byte key is derived from the existing, required `BETTER_AUTH_SECRET` (`src/server/config.ts:181`) with HKDF-SHA256, using `"agent-ops:github-token:v1"` as the salt and info string.
  - The ciphertext row stores the key version, `key_version = 1`, so a later derivation (`…:v2`) can coexist.
  - **Secret rotation.** If `BETTER_AUTH_SECRET` is rotated, decryption fails with a GCM auth-tag mismatch. The app then treats GitHub as **"需要重新设置"** (needs to be set up again). It shows that state on `/settings` and on every GitHub-dependent page (FR-GITHUB-05), and never crashes. The stale row is kept until the owner replaces or removes it **(assumed)**.
- **Secrecy.**
  - The decrypted token exists only in server memory, inside the GitHub adapter, and it is never logged.
  - The client sees only the GitHub login, the avatar, the last 4 characters, the saved-at time, and the permission check results.
- **AC.**
  1. The database row contains no plaintext token, which a test checks with a substring search.
  2. A tampered ciphertext or auth tag, or a rotated `BETTER_AUTH_SECRET`, fails decryption and yields the state "需要重新设置". It never crashes the process.
  3. The same secret and version always derive the same key, and a different secret derives a different key (unit test with fixed vectors).
  4. No response schema has a field that can carry the token. A contract test checks this.

#### FR-GITHUB-04 Replace and remove

- **Description.** The owner can replace the token, which runs FR-GITHUB-02 again, or remove it, after a confirmation dialog. Each change appends an event to the history (FR-REVIEW-06): `github_token_saved`, `github_token_replaced` or `github_token_removed`. The event records the actor, the time, the login and the last 4 characters, and **never the token**.
- **AC.**
  1. After removal, the next GitHub call behaves as in FR-GITHUB-05, with no restart needed.
  2. Jobs that are already running when the token changes pick up the new value at their next GitHub call. **Today the store is read on every call; the short cache is not built yet** (known gap, FR-GITHUB-09).

#### FR-GITHUB-05 Not configured

- **Description.** There are two "unusable" states: **"GitHub 未配置"** (no token is stored) and **"需要重新设置"** (a token is stored but cannot be decrypted, for example after a secret rotation, FR-GITHUB-03). In both states nothing crashes, and every surface below shows the matching text with a link to `/settings`:
  - `/review` and `/merge` show "GitHub 未配置" with a link to `/settings`, in place of the PR lists. The review history stays readable.
  - The workbench's GitHub-dependent sections show the same notice.
  - **Slack review.** The trigger is still matched and deduplicated. The bot replies in the thread that GitHub is not configured **(assumed wording: "GitHub not configured — set it up in Review platform settings")**, and **no** job is created **(assumed)**.
  - **Slack `merge`.** The bot replies that GitHub is not configured. It makes no GitHub call.
  - **Queued Slack jobs.** Queued jobs fail with a `GitHubNotConfigured` category, or are deferred, **(assumed: deferred until a token exists)**.
- **AC.** Every listed entry point returns its notice in both states, with an empty credential row and with one that cannot be decrypted. None gives a 500.

#### FR-GITHUB-06 Single account everywhere

- **Description.** Every GitHub port call gets its token from the credential row (FR-REVIEW-08). There is no account selector in the UI, the API or the config.
- **AC.** A grep for `GH_TOKEN_`, `x-github-account`, `githubAccount` and `accounts.ts` in `src/` finds nothing after migration, except in deprecation tests.

#### FR-GITHUB-07 Repo list (decided 2026-11-04)

- **Description.** The second part of the "GitHub" section on `/settings` is a list of `owner/repo` entries. The owner can add and remove several repositories. The list is stored in PostgreSQL in the `github_repo` table: `canonical` (primary key), `owner`, `repo`, `access`, `permissions jsonb`, `checked_at`, `added_at`, `added_by`, with a unique index on `lower(canonical)` (implemented, `drizzle/20261104035857_github_settings/migration.sql:17-26,43`). It is never stored in env.
- **Add: validation, in order.** Nothing is saved unless every step passes:
  1. **Format.** The entry matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`. Surrounding whitespace is trimmed first **(assumed)**.
  2. **Deduplication.** The comparison is case-insensitive against the existing entries.
  3. **Size limit.** At most 50 repositories (`MAX_REPOS`, `src/domain/settings/repo-entry.ts:7`; the number itself is assumed). The duplicate and size checks and the insert run under `LOCK TABLE github_repo IN SHARE ROW EXCLUSIVE MODE`, so concurrent adds cannot pass the limit (`src/adapters/db/pg-settings-repo.ts:38-46`).
  4. **Access.** A GitHub token must already be saved (FR-GITHUB-02). `GET /repos/{owner}/{repo}` must succeed, and the stored canonical name is the one GitHub returns.
  5. **Per-repo permissions.** Each repo shows the result for pull requests r/w, contents r/w, checks r and statuses r. Only read-only probes are used (FR-GITHUB-09). A repo the token cannot access (404 or 403) is rejected with 403 `forbidden`, "The token cannot access <owner/repo>.", shown on the repo field (`src/application/settings/repos.ts:51-55`, `src/functions/settings.logic.ts:59-61`). A repo that is readable but missing a write permission is saved with a warning (`src/application/settings/repos.ts:22-25`).
- **Remove.** The entry is deleted after a confirmation. That repo's review, approval and merge history stays readable, and new reviews, approvals and merges for it are refused (FR-SHIP-02).
- **Events.** `github_repo_added` and `github_repo_removed` are appended to the history (FR-REVIEW-06), with the actor and the time.
- **What the list drives:**
  - (a) The Slack trigger. Matching PR URLs are those whose repo is in the list (FR-SLACK-03).
  - (b) The repo picker and the open PR list on `/review`, across all listed repos (FR-REVIEW-01).
  - (c) The Approve and Merge allowlist, on web and Slack (FR-SHIP-02, S2).
- **An empty list fails closed.** There is no Slack trigger, `/review` shows no PRs, and Approve and Merge are refused. Every one of those surfaces shows **"未配置仓库 → /settings"**.
- **Errors.** `validation` (400) for the format, duplicate and limit checks. `forbidden` (403) for no access. `upstream` (502/503), with nothing saved. The messages never echo GitHub response bodies (S4).
- **AC.**
  1. `Foo/Bar`, entered when `foo/bar` is already listed, is rejected as a duplicate.
  2. `foo/bar/baz`, `foo`, ` /bar` and `foo/ba r` are all rejected on format.
  3. A repo the token cannot see is rejected, and the list is unchanged.
  4. After a repo is removed, a Slack link for it is ignored, and `/merge` refuses it. `/review` still shows its past records.
  5. Adding and removing each append exactly one event.
  6. The Slack matcher picks up a change to the list without a restart. Today the list is read from PG on every call; the short cache is not built yet (known gap, FR-GITHUB-09).

#### FR-GITHUB-08 Re-validate repos when the token changes

- **Description.** When the token is replaced, every listed repo is re-checked with the new token. Repos that lost access, or lost a required permission, are **flagged** in the list, for example "no access" or "missing contents:write". They are not deleted.
- **Effect.** A flagged repo stays in the list. GitHub calls for it may fail and are shown with a clear message. Approve and Merge for it are refused until it checks out again **(assumed)**. A **Re-check** action is available on each repo **(assumed)**.
- **AC.** After a token is replaced with one that lacks repo X, X is shown as flagged, and a merge on X is refused with a reason.

#### FR-GITHUB-09 Implementation status (commit `7c638a5`)

- **Implemented.**
  - **Tables** (`drizzle/20261104035857_github_settings/migration.sql`): `github_credential`, a single row (:1-15); `github_repo`, unique on `lower(canonical)`, with a table lock enforcing the maximum of 50 (:17-26, :43; `src/adapters/db/pg-settings-repo.ts:38-46`); `review_event`, append-only, enforced by a `BEFORE UPDATE OR DELETE` trigger that raises `insufficient_privilege` (:28-41, :50-56). `TRUNCATE` is not blocked, so test fixtures can empty it (:49).
  - **Permission detection, read-only calls only** (`src/adapters/github/octokit-github-verifier.ts:50-73`). Each cell is `granted`, `missing` or `unverified`, and `unverified` is never reported as granted (`src/domain/settings/permissions.ts:1-5`):
    - **PR write** is always `unverified` for fine-grained tokens, because every endpoint that needs it is a write (:69-70, :218).
    - **Contents write** for fine-grained tokens is inferred from the merge settings (`allow_merge_commit`, `allow_squash_merge`, `allow_rebase_merge`) that `GET /repos` returns: present → granted; absent while contents read is granted → missing; otherwise unverified (:63-65, :206-217).
    - Classic tokens use the `X-OAuth-Scopes` header and the repo role's `push` (:66-68).
    - A **5xx, a timeout, a dropped connection or a rate limit** maps to `unverified` (:72, :160-168).
  - **Errors.** A rejected token or an unreachable repo is 403 `forbidden`, shown on the form field (`src/functions/settings.logic.ts:49-61`).
- **Known gap.** The short in-process cache for the token and the repo list is **not built yet**; the stores are read on every call (`src/server/container.ts:228-229`). The behaviour is correct, only slower. The cache (invalidated on change) lands with `SettingsStore` (architecture.md §5.1a).

### 2.9 Slack settings (FR-SLACKCFG) (decided 2026-11-04, Q22 for Slack)

The Slack credentials and the review channels move from env into a **Slack** section on `/settings`, below GitHub. `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_REVIEW_CHANNEL_IDS` are removed from env (§4).

#### FR-SLACKCFG-01 Section and contents

- **Description.** `/settings` has a **Slack** section below the GitHub one (FR-GITHUB-01). It holds three items:
  1. **User Token** (`xoxp-`): the owner's user OAuth token. It reads messages, replies and reacts as the owner.
  2. **Signing Secret**: verifies Events API requests (FR-SLACK-01).
  3. **Review channels**: the channels in which a mention can trigger a review (FR-SLACK-03).
- It is an owner-only server function.

#### FR-SLACKCFG-02 Storage and secrecy

- **Encryption.** Each of the two active secrets is stored like the GitHub token (FR-GITHUB-03): AES-256-GCM with a random 96-bit IV per write, and a key from HKDF-SHA256 of `BETTER_AUTH_SECRET`, plus a stored key version. Each secret kind has its **own HKDF info**, `agent-ops:<kind>:v1`: `"agent-ops:slack-user-token:v1"` and `"agent-ops:slack-signing-secret:v1"` (`src/ports/settings-store.ts`).
- **Storage (implemented, `7e7e8a4`).** The `setting_secret` table, one row per `kind` (`slack_user_token`, `slack_signing_secret`): `ciphertext`, `iv`, `auth_tag`, `key_version`, `last4`, `saved_at`, `verified_at`, plus metadata (workspace and user name for the user token). The same table stores LLM credentials.
- **Never returned to the browser.** The page shows only the masked last 4 characters, the saved time, and the result of the connection test.
- **Independent replace and remove.** Each secret can be replaced or removed on its own. Each change appends an event (`slack_secret_saved`, `slack_secret_removed`, `slack_channels_changed`) with the actor and time, **without any value** (FR-REVIEW-06).
- **Decryption failure.** If either active Slack secret fails to decrypt (for example after `BETTER_AUTH_SECRET` was rotated), Slack is **"需要重新设置"**, the same as GitHub (FR-GITHUB-05). With no user token, Slack is "Slack 未配置" **(assumed wording)**.

#### FR-SLACKCFG-03 Validation on save

Nothing is stored unless the check passes.

| Secret         | Check                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User Token     | `auth.test` must succeed and **must return a user**, not a bot. The page shows the workspace name and the user name. The returned user ID is the owner's Slack ID (Q18). |
| Signing Secret | Format-checked only (no Slack call can test it). It is marked **verified** (`verified_at`) on the **first valid signed event**; until then the page shows **⚠ 未验证**.  |

- **Errors.** `validation` (400) for a format failure. `upstream` (502/503) when Slack cannot be reached, with nothing saved. Slack response bodies are never echoed (S4).
- **Rate limits (implemented, `7e7e8a4`).** Saves: 10 per 10 minutes per user. Channel listings: 30 per 10 minutes per user. Both fail closed (429).
- **UI wording.** An unverified value shows **⚠ 未验证**.

#### FR-SLACKCFG-04 Review channel picker

- **When.** After a valid user token is saved.
- **Listing.** `conversations.list` with the user token: the public and private channels **the owner is a member of**. It is paginated on the server, with a search box and multi-select.
- **Bounds (implemented, `7e7e8a4`).** One listing reads at most **10 pages of 200** channels, or stops after **15 s**, whichever comes first. A cut-off listing reports `truncated`, and the page says so.
- **Stored** as channel IDs, with the names cached for display, in the `slack_review_channel` table (`channel_id`, `name`, `checked_at`, `missing`).
- **Rule, stated on the page:** **an empty selection means all channels.** DMs always count.
- **Stale channels.** A selected channel that disappears from the listing is **kept and flagged `missing`**, never dropped. A truncated listing does not newly flag a channel as missing.
- **AC.**
  1. With an empty selection, a valid mention in any channel the owner is in triggers a review.
  2. With channels selected, a mention in another channel is ignored silently; a DM still triggers.
  3. An archived or left channel is shown flagged, not dropped.

#### FR-SLACKCFG-05 Runtime use

- **Events route.** `POST /api/slack/events` reads the signing secret from the store on each use. A missing secret returns 503 `not_configured` (FR-SLACK-01).
- **Review worker.** It runs the job consumer and the reaction outbox drainer.
- **User token** is read per call by the Slack adapter, like the GitHub token.
- **Review channels** are passed into the pure matcher as data (FR-SLACK-03), like the repo list.

#### FR-SLACKCFG-07 Acceptance

1. No response, cookie, loader payload or log line contains a Slack secret (sentinel test, as in §3.7 AC 1).
2. A bot token in the User Token field is rejected, and nothing is stored.
3. Replacing the signing secret takes effect on the next event without a restart; the old secret no longer verifies.
4. A rotated `BETTER_AUTH_SECRET` turns Slack into "需要重新设置" without a crash, and the events route returns 503.
5. Each save or remove appends exactly one event, which contains no secret value.
6. **Done in stage 3 (`7e7e8a4`, `65130e3`; env removal in 3w).** The events route, the worker and the Slack adapter read the stored credentials; `SLACK_*` is removed from `Config`.

---

### 2.10 LLM settings (FR-LLMCFG) (decided 2026-11-04, closes Q22)

`/settings` has three sections, in order: **GitHub** (§2.8), **Slack** (§2.9) and **LLM**. After this, env holds only the bootstrap variables (§4).

#### FR-SETTINGS-01 Rules shared by every settings secret

- **Encryption.** AES-256-GCM with a random 96-bit IV per write. The key is HKDF-SHA256 of `BETTER_AUTH_SECRET`, with a **distinct info string per secret** (for example `"agent-ops:anthropic-api-key:v1"`), and the row stores the key version.
- **Never returned to the browser.** The page shows only the masked last 4 characters, the saved time and the last test result.
- **Independent changes.** Each value can be replaced or removed on its own. Every change appends an event to the history (FR-REVIEW-06) with the actor and time, **never the value**.
- **Runtime.** Adapters read credentials from the settings store on each use. **No restart is needed.**
- **Missing or undecryptable.** The feature shows **"未配置"** or **"需要重新设置"** with a link to `/settings`, and its API returns 503 `not_configured`.
- Non-secret settings (URLs, models) are stored in `setting_value` rows with typed JSON values.

#### FR-LLMCFG-01 LLM section

- **Provider.** Anthropic is the only LLM provider. Missing or unreadable credentials return `not_configured`.
- **Fields.** Optional base URL, exactly one API key or auth token, and the model used for review. Trailing slashes are removed from the base URL, and the SDK appends `/v1/messages`.
- **Authentication.** Credential type determines the header: an API key uses `x-api-key`; an auth token uses `Authorization: Bearer`.
- **Save.** Validate the form and persist the encrypted credential and values without any network request. Store unverified metadata. Saving does not require a successful connection test.
- **Test.** Independently validate and test the current form inputs without saving them. Send the fixed prompt `hi!` with model `claude-haiku-5-5`; the editable runtime model does not affect this probe. Display status, model and latency without exposing the credential. A successful test of exactly the saved settings (base URL, model, credential type and value; an empty credential field means the saved one) marks the saved credential verified (`verified_at`), and the badge changes from **⚠ 未验证** to verified. Testing an unsaved draft, or a failed test, records nothing and keeps an earlier verification.
- **AC.** (1) Both credentials supplied together are rejected. (2) Save succeeds without contacting the provider and leaves verification unset. (3) Test succeeds or fails without changing persisted settings; only a successful test of the saved settings marks the saved credential verified, and the next save makes it unverified again. (4) API key and auth token produce the derived headers. (5) Removing the Anthropic credential disables review without a restart.

#### FR-SETTINGS-02 Operator tooling and tests

- **`pnpm llm:ping`** reads the LLM settings from the store instead of env. It therefore needs `DATABASE_URL` and `BETTER_AUTH_SECRET` (and `DATABASE_SEARCH_PATH` if set). The CLI uses the same fixed connection probe as the independent Test action.
- **Switch-over.** After the switch-over the owner re-enters the LLM values on `/settings`. There is **no automatic import from env (assumed)**. A one-off import command is an option, not planned.
- **Tests.** Integration and msw tests must not depend on LLM env vars any more. They inject credentials through the settings-store fake.

---

## 3. Non-functional requirements

### 3.1 Security (S1–S6)

| ID  | Requirement                                                                                                                                                                                              | Verified by                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| S1  | Every page and `/api/*` route requires a session. A request with an `Authorization` header gets 401. The exceptions are FR-AUTH-04's public list.                                                        | `access-policy.test.ts`, `resolve-actor.test.ts`, the P2 route tests |
| S2  | Every Approve and Merge path, on web and Slack, is limited to the repos in the `/settings` repo list, stored in PG. An empty list denies everything (FR-SHIP-02, FR-GITHUB-07).                          | `policy.test.ts`, the FR-GITHUB-07 tests                             |
| S3  | **Moot (decided 2026-11-04).** There is one GitHub account, held on the server and configured in `/settings`. No request can choose an account. The `x-github-account` header is ignored (FR-REVIEW-08). | FR-REVIEW-08 AC1, FR-GITHUB-06                                       |
| S4  | Errors return the fixed public message, the `kind` and a `requestId`. Details are logged on the server only (`src/server/errors.ts:15-66`). LLM bodies are never echoed.                                 | `errors.test.ts`, route contract tests                               |
| S5  | Dev and prod bind to `127.0.0.1` (`vite.config.ts:9`, `src/server/config.ts:202`). Only the TLS reverse proxy is exposed.                                                                                | Manual (deploy checklist)                                            |
| S6  | LLM-triggering routes are rate-limited by a Redis sliding window (`src/ports/rate-limiter.ts`). The limiter fails closed when Redis is down.                                                             | `redis-rate-limiter.int.test.ts`, `redis-fail-closed.test.ts`        |

Additional rules:

- **Config errors.** Configuration error messages name the key and never the value (`src/server/config.ts:1-5`).
- **Untrusted LLM input.** PR content is delimited as untrusted input (FR-REVIEW-04). The deterministic merge gate is pending (Q1).
- **Destructive actions.** Force approve has no web button (Slack only, FR-SHIP-06). Merge is a `danger` button behind a confirmation dialog (DESIGN.md Do's and Don'ts).
- **CSRF.** better-auth's built-in checks, with `SameSite=Lax` cookies (migration-plan.md:183).

### 3.2 Reliability

- **Durability.** Durable state lives in PostgreSQL. Losing Redis may delay work but never loses it (architecture.md §1 principle 3).
- **Leases.** Review jobs are claimed with a lease (FR-SLACK-07). On SIGTERM, the consumer stops claiming, then finishes or abandons the current job within a grace period (architecture.md §8).
- **Retries.** Adapters retry only retryable errors (rate limits, 5xx, network), with jitter and a bound. Each service has a circuit breaker (architecture.md §8). Reaction retries wait 30 s. Interruptions fail a job at 3.
- **Timeouts.**
  - GitHub: 30 s per request (`src/adapters/github/octokit-github.ts:29`).
  - LLM: a per-request `timeoutMs`, with the SDK default when it is unset (`src/adapters/llm/options.ts:34-37`). Long outputs stream (`:15-16`).
- **Fail-closed coordination.** Event dedupe, locks and rate limits fail closed. `WakeUp` degrades to polling (architecture.md §8).
- **Boot validation.** Invalid config stops the process at boot and lists every invalid key (`src/server/config.ts:15-26,326`).

### 3.3 Performance

- **Ack time.** The Slack event is acknowledged in under 3 s (Slack's requirement). The target is p95 under 500 ms **(assumed)**.
- **Lists.** The PR list and the status panel respond in under 2 s p95, excluding GitHub latency **(assumed)**.
- **Polling.** Review polling is bounded (FR-REVIEW-03). Status polling stops when the tab is hidden **(assumed: the TanStack Query default)**.
- **Review history.** The history query (FR-REVIEW-06) uses indexed filters: repo, PR, status, source and the created time **(assumed)**.

### 3.4 Observability

- **Logs.** Structured logs with a request ID, injected through `Logger` (architecture.md §6). The `requestId` in an error body matches a log line.
- **No secrets or content in logs.** Logs never contain secrets or Slack message content.
- **Health check.** A health endpoint **(assumed)**, for example `GET /api/health`. None exists yet.
- **Tracing.** `@anthropic-ai/sdk` emits OpenTelemetry spans once a global tracer is registered. None is registered today (migration-plan.md:274).
- **LLM connectivity check.** `pnpm llm:ping` (`scripts/llm-ping.ts`), reading the stored LLM settings (FR-SETTINGS-02); the same probe runs through the independent Test action in `/settings` (FR-LLMCFG-01).

### 3.5 Accessibility

- **Contrast.** WCAG contrast of at least 4.5:1 for text, or 3:1 for large text. It is enforced by `src/styles/tokens.test.ts` (DESIGN.md Colors, "Contrast budget").
- **Reduced motion.** Every animation is gated by `motion-safe:`. Animated SMIL icons are paired with static ones (docs/styling.md §9). State is never conveyed by motion or colour alone.
- **Forms.** Form errors use `aria-invalid` and `aria-describedby`. Loading buttons set `aria-busy` (docs/styling.md §9 Ownership). Icon-only buttons have an `aria-label` (as in `SlackReviewStatus.tsx:122`).
- **Keyboard.** Dialogs and selects are built on Base UI primitives, with focus trap and keyboard navigation **(assumed: Base UI defaults)**.
- **Language.** The document language is `zh-CN` (`src/routes/__root.tsx:20`). The UI copy is in Chinese, and GitHub comments are in English.

### 3.6 Supported runtime

- **Node.** Node.js 26 or later (`package.json` `engines`). Verified with 26.13.0 (migration-plan.md:30).
- **Hosting.** Self-hosted on Linux under systemd, with two units: web and worker (migration-plan.md §3). There is no Vercel dependency.
- **Bind address.** `HOST` defaults to `127.0.0.1` and `PORT` defaults to `3000` (`src/server/config.ts:201-202`). The dev server binds `127.0.0.1:5555` (`vite.config.ts:9`).
- **Data stores.** PostgreSQL (TLS for remote hosts) and Redis (`rediss://` for Redis Cloud).

### 3.7 Tokens and credentials (decided 2026-11-04)

There are two tokens with different jobs. They must never be confused.

| #   | Token                 | Issued or entered by                                  | Where it lives                                                                                                                                                                                                                 | Who can read it                                                                                                                                                                    | Proves or does                         | Lifetime and rotation                                                                                                                                                                                                           |
| --- | --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **App session token** | better-auth, after a successful `/login` (FR-AUTH-02) | Browser cookie: `HttpOnly`, `SameSite=Lax`, and `Secure` whenever `BETTER_AUTH_URL` is https (`src/adapters/auth/auth.ts:41,63-66`). Production is https. In dev over http the cookie is not Secure. The session row is in PG. | The browser sends it automatically. **JavaScript cannot read it.** The server verifies it.                                                                                         | The **owner's identity** to Review platform. | Expires 7 days after it is issued, and is refreshed when it is used and more than 1 day old (`expiresIn: 7d`, `updateAge: 1d`, `src/adapters/auth/auth.ts:62`). Signed with `BETTER_AUTH_SECRET`. Sign-out deletes the session; rotating the login token deletes every session. |
| 2   | **GitHub token**      | The owner, on `/settings` (FR-GITHUB-02)              | PG, encrypted with AES-256-GCM. The key is HKDF-SHA256 of `BETTER_AUTH_SECRET` with `"agent-ops:github-token:v1"`, and the row stores the key version (FR-GITHUB-03).                                                          | **Only the server**: SSR loaders, server functions, the Slack review worker, inside the GitHub adapter. It is **never** sent to the browser, not even in a cookie. | agent-ops **acting on GitHub**.        | Until the owner replaces or removes it, or GitHub expires the PAT. Rotating `BETTER_AUTH_SECRET` makes it unreadable, giving "需要重新设置".                                                                                    |

**Other server-held secrets.** None of them ever reaches the browser.

| Secret                                               | Purpose                                                                                           | Where it lives                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                                 | Signs sessions. The HKDF input key for every settings secret (FR-SETTINGS-01).                    | Server env (the systemd `EnvironmentFile`) **(assumed path)**, validated by `src/server/config.ts:181`. |
| Login token                                          | Signs the owner in on `/login` (FR-AUTH-02).                                                      | PG, as a PBKDF2-HMAC-SHA256 hash only, in `login_token`. Set on `/setup`, rotated on `/settings`.       |
| Anthropic API key or auth token                      | LLM calls.                                                                                        | PG, encrypted, entered on `/settings` (FR-LLMCFG-01).                                                   |
| Slack User Token, Signing Secret                     | Acting as the owner in Slack, verifying HTTP events.                                              | PG, encrypted, entered on `/settings` (FR-SLACKCFG-02). Each has its own HKDF info.                     |
| `DATABASE_URL`, `REDIS_URL` (credentials in the URL) | Data stores.                                                                                      | Server env.                                                                                             |

**Flow A: a browser action that needs GitHub.**

```
Browser                         Review platform server                            PG                GitHub
  | request + session cookie      |                                                 |                   |
  | (HttpOnly; no GitHub token)   |                                                 |                   |
  |------------------------------>| better-auth: verify session -> actor=owner      |                   |
  |                               |-- read github_credential ---------------------->|                   |
  |                               |<-- ciphertext, iv, tag, key_version ------------|                   |
  |                               | HKDF(BETTER_AUTH_SECRET) -> AES-GCM decrypt     |                   |
  |                               |   (fails -> "需要重新设置", no GitHub call)       |                   |
  |                               |-- Authorization: Bearer <github token> ------------------------------>|
  |<-- result (no token in body)--|<---------------------------------------------------------- response -|
```

**Flow B: a Slack-triggered review, or the owner's `merge` reply. No browser is involved.**

```
Slack                           Review platform server / worker                   PG                GitHub
  | event (signed HTTP callback)|                                                 |                   |
  |------------------------------>| verify signature (stored signing secret),        |                   |
  |                               | dedupe event_id, match rules                    |                   |
  |                               |-- read github_credential ---------------------->|                   |
  |                               | HKDF(BETTER_AUTH_SECRET) -> AES-GCM decrypt     |                   |
  |                               |   (fails -> thread reply "GitHub not configured")                   |
  |                               |-- Authorization: Bearer <github token> ------------------------------>|
  |<-- thread reply (no token) ---|<---------------------------------------------------------- response -|
```

**Rejected alternative: the GitHub token in an HttpOnly cookie.** A cookie only reaches the server with a browser request. A Slack-triggered review and the Slack `merge` reply have no browser request, so they have no cookie and could never call GitHub. The cookie would also send the token on every request, and the session would be tied to one browser. The token therefore lives encrypted in PG and is decrypted only on the server.

**AC.**

1. No HTTP response, `Set-Cookie` header, loader payload or log line contains the GitHub token. A test checks for this with a sentinel token.
2. Flows A and B use the same decrypt-and-call path in the GitHub adapter.
3. A request without a valid session never triggers decryption.

---

## 4. Configuration

Every variable is read only in `src/server/config.ts`. **No values are listed here.** After the 2026-11-04 decisions, env holds **only the bootstrap**: what the server needs before it can read the database, decrypt the settings, or authenticate a caller. Every integration credential lives on `/settings` (§2.8–§2.10).

**Env that remains, and why it must stay in env:**

| Variable               | Required | Meaning                                                                                       | Why it cannot move to `/settings`                                                                                                                                      | Source          |
| ---------------------- | -------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `DATABASE_URL`         | yes      | PostgreSQL connection string.                                                                 | The settings live in this database; the app cannot read them without it.                                                                                               | `config.ts`     |
| `DATABASE_SEARCH_PATH` | no       | Schema for all tables and the migration journal (`^[a-z_][a-z0-9_]*$`).                       | Chooses where the settings tables are, so it is needed before the first query.                                                                                         | `config.ts:190` |
| `REDIS_URL`            | yes      | Redis connection string.                                                                      | Dedupe, locks and the settings-change notification depend on it from boot.                                                                                             | `config.ts`     |
| `REDIS_KEY_PREFIX`     | no       | Prefix for every Redis key. Default `agent-ops:`.                                             | Isolates environments and test runs; must be known before the first Redis call.                                                                                        | `config.ts`     |
| `BETTER_AUTH_SECRET`   | yes      | Session signing secret, at least 32 characters. The HKDF input key for every settings secret. | It is the root key that decrypts the settings; storing it next to them would defeat the encryption. Rotating it forces every secret to be set up again (FR-GITHUB-03). | `config.ts:181` |
| `BETTER_AUTH_URL`      | yes      | Public origin (http or https). Decides whether cookies are `Secure`.                          | Needed to issue the session cookie that is required to reach `/settings` at all.                                                                                       | `config.ts:182` |
| `HOST`                 | no       | Bind address. Default `127.0.0.1` (S5).                                                       | Needed to start listening, before any request or database read.                                                                                                        | `config.ts:208` |
| `PORT`                 | no       | HTTP port. Default 3000.                                                                      | Same as `HOST`.                                                                                                                                                        | `config.ts:201` |

**Removed from env (decided 2026-11-04):**

| Variable or group                                                                                                                          | Replacement                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `GH_TOKEN_WGBX`, `GH_TOKEN_ZHIYONG_ENG`, `GITHUB_REPO_ALLOWLIST`, `SLACK_REVIEW_GITHUB_ACCOUNT`                                            | GitHub token and repo list on `/settings` (FR-GITHUB-02, -07)                       |
| `SLACK_USER_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_REVIEW_CHANNEL_IDS`                                                                     | Slack section on `/settings` (FR-SLACKCFG-01..04)                                   |
| `SLACK_REVIEW_ALLOWED_USER_IDS`                                                                                                            | None: there is no sender allowlist (FR-SLACK-04)                                    |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`                                                       | LLM section, Anthropic (FR-LLMCFG-01)                                               |

**Status.** Integration credentials are read from the encrypted settings store; env holds bootstrap settings only.

Not added:

- `SLACK_USER_ID`: the owner's Slack user ID comes from `auth.test` on the stored user token. See Q18.
- `GITHUB_MERGE_METHOD`: **not added (decided)**. The merge method is a preference list in the container (FR-SHIP-05).
- No env var for any integration, and no encryption-key variable (decided). The keys are derived from `BETTER_AUTH_SECRET` (FR-SETTINGS-01).

Removed in P1: `UPSTASH_REDIS_REST_*`, `KV_REST_API_*` and `SLACK_REVIEW_STATE_FILE` (architecture.md §6).

---

## 5. External interfaces

### 5.1 Target route contracts

The UI talks to the server through `createServerFn` RPCs (`/_serverFn/*`). Those RPCs need a session and are not a public contract (architecture.md §2). The server routes below are the stable contracts. Every error body is `{ kind, message, requestId }` (`src/server/errors.ts:3-7`).

| Method and path                | Auth                 | Request         | Success                                       | Errors                                         | Status in code                                  |
| ------------------------------ | -------------------- | --------------- | --------------------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| `GET, POST /api/auth/*`        | public (better-auth) | better-auth API | better-auth                                   | 400, 401                                       | done (`src/routes/api/auth/$.ts`)               |
| `GET /api/me`                  | session              | —               | 200 `{ actor: { kind } }`, `no-store`         | 401                                            | done (`src/routes/api/me.ts`)                   |
| `POST /api/slack/events`       | Slack signature      | raw Slack JSON  | 200 empty, or `{ challenge }`                 | 400, 401, 503, 500 (so Slack retries)          | done (`65130e3`)                                |

### 5.2 Legacy UI routes and their target mechanism

| Legacy route                    | Legacy contract                                                                                                                                                                                                                                                                 | Target                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/execute`             | Body `{ url, mode?: ship\|merge\|force_approve, sessionId? }` (`force_approve` is **dropped** in the target, FR-SHIP-06), header `x-github-account`. Returns 200 `ExecuteResult`, 202 `{ pending, sessionId }`, 400 or 500 `{ error }` (`src/app/api/execute/route.ts:17-133`). | Server functions `shipPr`, `approvePr` (new), `mergePr` and `forceApprovePr` **(assumed names)**, with errors from §7 of architecture.md. |
| `GET /api/pulls/open`           | Header `x-github-account`. Returns `{ owner, repo, authors, items }` or 500 (`src/app/api/pulls/open/route.ts:12-33`).                                                                                                                                                          | Server function plus `queryOptions`. The account comes from the actor.                                                                    |
| `GET /api/slack/review-status`  | Returns `{ mode, active, problem?, account?, canMarkRead, jobs[≤10], activeHours, withinHours }` (`src/app/api/slack/review-status/route.ts:21-62`).                                                                                                                            | Server function `listVisibleJobs`. There is no `mode: local` any more.                                                                    |
| `POST /api/slack/review-status` | `{ id? }` marks one finished job read, or all of them (`:65-78`).                                                                                                                                                                                                               | Server function `markJobRead`.                                                                                                            |

### 5.3 Outbound integrations

| Service   | Interface                                                                                                                                                                                                                                    | Credential                                    |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| GitHub    | REST through Octokit: list PRs, get a PR and its files, blobs, comments, reviews, and merge pinned to a SHA (`src/ports/github.ts:76-107`). Settings validation also calls `GET /user` and `GET /repos/{owner}/{repo}` for each listed repo. | the in-app token (FR-GITHUB-03)               |
| Slack     | Web API: `auth.test`, `chat.postMessage`, `reactions.add`, `reactions.remove` and `conversations.*`. HTTP Events API for input.                                                                                   | stored on `/settings` (FR-SLACKCFG-02)        |
| Anthropic | Messages API through `@anthropic-ai/sdk` 1.x, with structured output.                                                                                                                                                                        | stored on `/settings` (FR-LLMCFG-01)          |

---

## 6. Open questions and pending decisions

| #   | Question                                                                                                                                                                                                                                                                                                                            | Options and notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Q1  | **Prompt-injection merge gate** (migration-plan.md §4.1).                                                                                                                                                                                                                                                                           | **Closed for merge (decided 2026-11-04).** No review ever auto-merges, and a merge needs the owner's explicit `merge` reply or `/merge` button (FR-SHIP-05, FR-SLACK-13). **Residual risk (recorded):** a 🟢 review auto-approves (FR-SHIP-01), so injected PR content could produce an approval. Open: whether branch protection should count that approval toward required reviews.                                                                                                                                                                                                                                                                                                                                                    | user (closed for merge) |
| Q2  | **`SLACK_REVIEW_ALLOWED_USER_IDS`.**                                                                                                                                                                                                                                                                                                | **Decided 2026-11-04: dropped.** Any workspace member may trigger a review. Cost control comes from the channel list, the rate limit, event dedupe and active hours (FR-SLACK-04). The check is removed (`1f47b66`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | closed                  |
| Q3  | **Default model `claude-opus-5-5` and its cost.** It replaces the deprecated `claude-sonnet-4-5-20250929` default (`src/adapters/llm/options.ts:9-13`). Full diffs are sent without limits, and `max_tokens` is 64,000 (`:16`), so the per-review cost may rise sharply.                                                            | Keep Opus. Default to a cheaper model and keep Opus as an override. Add a per-review token or cost ceiling, and record the model and token usage on each review record (FR-REVIEW-05). Note: migration-plan.md:20 says the model choice does not change, but the default did change.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | user                    |
| Q4  | **GitHub account.**                                                                                                                                                                                                                                                                                                                 | **Decided 2026-11-04.** There is exactly one account. The owner configures it in `/settings` after login, and it is stored encrypted in PostgreSQL (FR-GITHUB-01..06). Multi-account support and the `GH_TOKEN_*` env vars are removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | closed                  |
| Q6  | **Own PRs and the Merge preconditions.** Own PRs merge without an AI review today.                                                                                                                                                                                                                                                  | Exempt own PRs from "approved" and "no P0", or require a review for every merge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | user                    |
| Q7  | **Two sources of repo truth.**                                                                                                                                                                                                                                                                                                      | **Closed 2026-11-04.** There is one stored repo list, which drives the Slack matcher, the PR list and the write gate (FR-GITHUB-07).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | closed                  |
| Q8  | **Severity scale.** The new requirement says P0 to P3. The code uses P0, P1, P2 and Nit.                                                                                                                                                                                                                                            | Keep the current set, or rename `Nit` to `P3`, which needs a jsonb migration for stored progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | user                    |
| Q10 | **Forced `tool_choice` on newer Claude models** (architecture.md §10.1, migration-plan.md:203).                                                                                                                                                                                                                                     | `auto` plus `strict: true`, or structured outputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | architect               |
| Q11 | **Rate-limit values.** Reviews consume LLM calls.                                                                                                                                                                                                                                                              | Confirm per-user limits for the LLM entry points.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | architect               |
| Q12 | **Review record retention and model.** A `review_result` table, or typed columns on `review_job`, and how long to keep the records (FR-REVIEW-05).                                                                                                                                                                                  | Separate tables, `review_result` and `review_event`, kept for 1 year **(assumed)**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | architect               |
| Q13 | **Merge method.** It is hard-coded to `merge`. docs/slack-pr-review.md:12 says the author rules decide whether a merge commit is used.                                                                                                                                                                                               | **Closed (stage 3, `f334203`).** No env var. The container sets a preference list (legacy `merge` first), and the adapter picks the first method the repo allows. A `/settings` control is a possible stage-4 item **(assumed)**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | closed                  |
| Q14 | **Active hours** are hard-coded to 09:00–19:00 UTC+8 (`src/domain/slack/review-rules.ts:26`).                                                                                                                                                                                                                                       | Keep them hard-coded, or make them configurable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | user                    |
| Q15 | **Web Ship auto behaviour.**                                                                                                                                                                                                                                                                                                        | **Closed 2026-11-04, updated.** Merge is always manual and separate. A 🟢 review auto-approves, on web and Slack (FR-SHIP-01). Auto-merge stays removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | closed                  |
| Q16 | **Slack `merge` disambiguation syntax** for a thread that contains several PRs (FR-SLACK-13).                                                                                                                                                                                                                                       | For example `merge #123`, or `merge <PR url>`. Until this is decided, the bot refuses and asks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | user                    |
| Q17 | **Active hours for the `merge` command.**                                                                                                                                                                                                                                                                                           | **(assumed: they do not apply)**. Active hours gate only review triggers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | user                    |
| Q18 | **Owner Slack user ID source.** The decision names `SLACK_USER_ID`, but no such variable exists. The owner ID is resolved at runtime with `auth.test` on the stored Slack user token (FR-SLACKCFG-03) (`src/lib/slack-review-config.ts:40-45`) and passed in as `ReviewRuleOptions.userId` (`src/domain/slack/review-rules.ts:14`). | Keep resolving it with `auth.test` **(assumed)**, or add an explicit `SLACK_USER_ID` and check that it equals `auth.test`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | architect               |
| Q19 | **Required checks source** for the merge gate (FR-SHIP-05 precondition 6).                                                                                                                                                                                                                                                          | Branch-protection required checks, or every check on the head SHA. The port has no checks method yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | architect               |
| Q20 | **Where the repo allowlist lives.**                                                                                                                                                                                                                                                                                                 | **Re-closed 2026-11-04.** It lives in the `/settings` repo list, in PG. It is removed from env, and there is no hard-coded repo (FR-GITHUB-07). Supersedes the earlier "code constant" decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | closed                  |
| Q21 | **PAT permissions.**                                                                                                                                                                                                                                                                                                                | **Closed 2026-11-04.** A fine-grained PAT on the listed repos: Contents read and write, Pull requests read and write, Checks read, Commit statuses read (FR-GITHUB-02). Verify the exact names against GitHub docs when implementing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | closed                  |
| Q22 | **Other credentials in `/settings`?**                                                                                                                                                                                                                                                                                               | **Closed 2026-11-04.** Slack (§2.9) and the LLM credentials (§2.10) all move to `/settings`, each secret with its own HKDF info. Env keeps only the bootstrap variables (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | closed                  |
| Q23 | **Several PRs in one Slack message or thread.** Emoji are per PR, but a message can carry each emoji only once.                                                                                                                                                                                                                     | **(Assumed:)** 🔴 if any PR is red, 🟢 only if every PR is green, and ✅ only when every PR is merged. Until every PR is merged, a partial merge shows only in thread replies. `updated` re-reviews every PR in the thread whose head SHA changed, and leaves the others alone. The owner's `review` reviews every listed-repo PR in the thread.                                                                                                                                                                                                                                                                                                                                                                                         | user                    |
| Q24 | **Re-review mechanics (FR-SLACK-14).**                                                                                                                                                                                                                                                                                              | **(a) Decided 2026-11-04:** only the recorded requester replies `updated` in the thread; the owner uses `review`, which also re-runs on the same SHA and ignores active hours (FR-SLACK-14 (a2); its edge cases are assumed). An @mention in the thread no longer counts. **Decided:** on the `updated` and `review` paths, the status emoji stays on the original message, and the `updated` reply gets no emoji. **Still proposed, pending user confirmation:** (1) a new top-level message with the same PR link is a normal new request, and the emoji moves to it; (2) ✅ goes on whichever message carries the current status; (3) older pending emoji changes are dropped once a newer review finishes, by comparing `review_id`. | user                    |
| Q25 | **Emoji for an approval.**                                                                                                                                                                                                                                                                                                          | **(Assumed, pending user confirmation):** an approval (automatic, or the manual `approve` retry) adds no new emoji, and 🟢 stays. The approval shows on the web (已批准) and in the thread reply. `force approve` turns 🔴 into 🟡, and a merge adds ✅. The earlier premise that a review never approves is superseded (FR-SHIP-01).                                                                                                                                                                                                                                                                                                                                                                                                    | user                    |
| Q26 | **Is the `/review` list also view-only?** The detail page is read-only (FR-REVIEW-07, decided).                                                                                                                                                                                                                                     | **Implemented as view-only (stage 3, `0c9b6ce`).** The `/review` page lists and filters review records and starts nothing; reviews start from Slack. Adding a web start (FR-REVIEW-03) later stays open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | user                    |
| Q27 | **Records of removed repos.** `/review` hides the records of repos that were removed from the `/settings` list, while the `/merge` history shows them (FR-REVIEW-06).                                                                                                                                                               | **OPEN.** Unify both pages. **Recommended: show** the records on both, marked as no longer listed, since FR-SHIP-02 AC2 and FR-GITHUB-07 say that history stays readable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | user                    |

### 6.1 Known gaps and follow-ups after stage 3

| Gap                                                                                                                                       | Where            | Follow-up                                |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------- |
| LLM calls cannot be cancelled: the `Reviewer` port takes no `AbortSignal`, so a job that loses its lease still finishes its LLM call.     | FR-REVIEW-04     | Stage 4 (LLM adapters are rebuilt there) |
| A result reply is dropped after 3 Slack refusals; the drop is only logged.                                                                | FR-SLACK-08      | Open                                     |
| An event acked by the events route is lost if the process crashes before it is processed.                                                 | FR-SLACK-01      | Open                                     |
| The owner's manual first review through the thread `review` command is not built: `review` in a thread with no earlier review is ignored. | FR-SLACK-14 (a2) | Open                                     |
| `/review` hides records of removed repos while `/merge` shows them.                                                                       | FR-REVIEW-06     | Q27                                      |
