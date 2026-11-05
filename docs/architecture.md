# Architecture

Status: **approved 2026-11-03; synced with the 2026-11-04 product decisions and the stage 3 implementation**. Last updated 2026-11-04.

**Source of truth for behaviour:** [requirements.md](./requirements.md) (FR-* IDs) and [product.md](./product.md). This document only says **where** each rule lives. When the two disagree, requirements.md wins, and this file is fixed.

This document is the target architecture for Review platform after the migration described in [migration-plan.md](./migration-plan.md). The test strategy that goes with it is in [testing.md](./testing.md), and the UI rules are in [styling.md](./styling.md).

---

## 1. Principles

1. **Ports and adapters.** Domain and application code never import a framework, SDK, database driver, `process.env`, `Date` or `fetch`. Every side effect goes through a port, which is an interface. Adapters implement the ports, and a single composition root wires them together.
2. **Pure core, thin edges.** State machines, policies (merge rules, active hours, read state) and decisions are pure functions over plain data. Routes and server functions only parse input, call a use case and map the result.
3. **Durable state in PostgreSQL, coordination in Redis.** Losing Redis may delay work but never lose it. Every record a user can see lives in PostgreSQL.
4. **Idempotent side effects.** Every external write (GitHub comment, review or merge; Slack reply or reaction) is either guarded by a checkpoint stored in the same transaction as the state change, or deduplicated by a deterministic marker.
5. **Fail closed.** Invalid config stops the process at boot. Malformed AI output, unknown repos, unverified Slack signatures and missing sessions are all rejected. There is no "best effort" path around a security check.
6. **Typed errors, one mapping.** Use cases return or throw typed domain errors. A single function maps them to HTTP. This replaces today's matching on Chinese error substrings (`slack-review-runner.ts:30-45`).

---

## 2. Layers

```
src/
  domain/<context>/        pure types, state machines, policies         (no imports outside domain/)
  application/<context>/   use cases: orchestrate domain + ports        (imports domain/, ports/)
  ports/                   interfaces for every side effect             (imports domain/ types only)
  adapters/                implementations of ports                     (imports SDKs, drivers)
    db/                    drizzle schema, migrations, repositories
    redis/                 locks, dedupe, rate limit, wake-up
    github/ slack/ llm/  external services
    system/                clock, id, logger
  server/
    config.ts              env → validated Config (zod), parsed once at boot
    container.ts           composition root: Config → adapters → use cases
    errors.ts              DomainError → HTTP status / body
    middleware/            auth, request id, rate limit
    workers/               review-job consumer, Slack review worker entry
  routes/                  TanStack Start: pages, server routes (external callers)
  functions/               createServerFn wrappers (internal UI calls)
  queries/                 TanStack Query queryOptions
  ui/                      design-system primitives (styling.md)
```

**Dependency rule.** Each layer imports only from the layers listed before it in the tree above:

- `domain` imports nothing outside `domain`.
- `application` imports `domain` and `ports`.
- `adapters` imports `ports` and `domain` (types only).
- `server`, `routes` and `functions` import anything.

oxlint enforces this with `import/no-restricted-paths`, so a violation fails CI.

### Server routes vs server functions

| Caller                                                                  | Mechanism                                                | Why                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Our own UI                                                              | `createServerFn` in `src/functions/`, validated with zod | End-to-end types, no hand-written fetch, and the same auth middleware            |
| Slack Events API, better-auth                                           | Server routes in `src/routes/api/`                       | External callers need a stable URL and raw body access (Slack HMAC)              |

This narrows the "keep every route contract identical" rule in migration-plan.md: contracts are preserved **only for external callers**. The UI is rewritten in P4 anyway, so it moves to server functions.

---

## 3. Bounded contexts

| Context             | Domain (pure)                                                                                                                                                                                                                | Use cases                                                                                                                                                         | Ports used                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **identity**        | `User`, `Actor` (user, or system-on-behalf-of-owner), login-token rules (length, whitespace)                                                                                                                                 | `initialize` (first-writer-wins), `signInWithToken`, `rotateLoginToken`, `getCurrentUser`, `requireUser`                                                          | `AuthPort` (better-auth), `LoginTokenStore`                                                                                               |
| **settings**        | `parseRepoEntry` (format, case-insensitive dedupe, max 50), LLM settings validation (exactly one Anthropic credential), credential state per section (`configured`, `not_configured` "未配置", `needs_reset` "需要重新设置") | `saveSecret`, `removeSecret`, `addRepo`, `removeRepo`, `revalidateRepos`, `setReviewChannels`, `testConnection` (GitHub `GET /user`, Slack `auth.test`, LLM ping) | `SettingsStore`, `TokenCipher`, `GitHubPort`, `SlackPort`, `LlmProbe`, `ReviewEventRepo`                                                  |
| **review**          | `Finding`, `Severity`, `AiReviewResult`, `decideGithubEvent`, `highestSeverity`, `buildReviewDiff`, comment rendering                                                                                                        | `reviewPullRequest`, `listReviews`, `getReview`                                                                                                                   | `Reviewer` (LLM), `GitHubPort`, `ReviewRecordRepo`, `ReviewEventRepo`                                                                     |
| **ship**            | `ShipPolicy` (§4.2), `ShipCheckpoint`                                                                                                                                                                                        | `autoApprove`, `approve` (retry), `forceApprove`, `mergePullRequest`                                                                                              | `GitHubPort`, `SettingsRepo`, `ReviewRecordRepo`, `ReviewEventRepo`, `ReactionOutbox`                                                     |
| **review-queue**    | `ReviewJob` state machine (§4), retry/backoff policy, visibility rules                                                                                                                                                       | `enqueueReview`, `claimAndRunNext`, `retryFailed`, `markRead`, `listVisibleJobs`                                                                                  | `ReviewJobRepo`, `ReviewRecordRepo`, `SlackPort`, `Clock`, `WakeUp`                                                                       |
| **slack-intake**    | `matchSlackReviewMessage` with `extractReviewPrUrls(text, repoList)`, `withinActiveHours`, `parseThreadCommand` (§4.3), status-emoji machine (§4.1)                                                                          | `ingestSlackEvent` (HTTP Events API), `handleThreadCommand`                                                                                                       | `EventDedupe`, `RateLimiter`, `ThreadReviewIndex`, `SettingsRepo`, `ReactionOutbox`, review-queue and ship use cases                      |

- **Removed context: github-accounts.** There is one GitHub account, entered on `/settings` (FR-REVIEW-08, FR-GITHUB-06). `resolveAccountForUser`, the env-backed `SecretStore` and `review_job.github_account` go away.
- **Thread commands** go through the same Slack ingress and dedupe as review triggers. `handleThreadCommand` dispatches to the ship use cases (`approve`, `force approve`, `merge`) or the review-queue use cases (`review`, `updated`).

Most of the domain functions already exist and are already pure (`repos.ts`, `slack-review-rules.ts` and `review-ai.ts`). They move into `domain/` largely unchanged. The work is extracting the side effects around them.

---

## 4. Review job state machine

Today the job lifecycle is spread across `slack-review-runner.ts:96-152`, `slack-review-queue.ts:77-124` and `ship-pr.ts`. It becomes one pure function:

```ts
transition(job: ReviewJob, event: ReviewJobEvent, now: Instant): ReviewJob | DomainError
```

```
             enqueue                         retry
               │                               │
               ▼                               ▼
            queued ◀── deferred / interrupted(<3) / lease_expired(<3) ──┐
               │ claim (lease, attempts += 1)                            │
               ▼                                                         │
            running ─────────────────────────────────────────────────────┘
               │  │  ▲
               │  │  └─ reclaim after lease expiry: interruptions += 1, in the claim query
               │  │
               │  └── all_completed ──▶ done      (records + outbox rows + reply, one transaction)
               │
               └── failed / interrupted(3) / lease_expired(3) / interruption_limit ──▶ failed
                                                   (records + outbox rows + reply, one transaction)

  per 🟢 URL inside running: commented ──▶ approve_pending ──▶ approved | approve_skipped | approve_failed
```

- **Invariants.** These are property-tested in [testing.md](./testing.md):
  - `done` and `failed` are terminal, except that `retry` takes `failed` back to `queued`.
  - Every external write (comment, review, merge, reply, reaction) happens at most once per job. Each is recorded as a checkpoint in `progress` before the state advances.
  - `attempts` only increases.
- **Lease-expired reclaims count as interruptions (decided, `cb079da`).** When the claim query takes over a `running` job whose lease expired, it increments `interruptions` in the same statement and keeps `runStartedAt`. A reclaimed job that has reached `MAX_INTERRUPTIONS` (3) is not run again: the new owner sends the domain event `interruption_limit`, which fails it as `interrupted` through the normal terminal transition. The review record, the outbox rows and the result reply are therefore still written. The repo never moves a job to a terminal state by itself.
- **Checkpoints** are stored per PR URL, matching today's per-URL `completed` flags. The recovery rule "already merged → mark merged" (`ship-pr.ts:141-143`) is preserved.
- **Done in stage 3** (`013dbff`, `524723f`, `cb079da`; `src/domain/review-queue/state-machine.ts`, deviations D9–D12):
  - The review step no longer merges. On a 🟢 verdict it runs **auto-approve** (FR-SHIP-01) after the comment checkpoint, as its own checkpoint. The outcome is `approved | approve_skipped(reason) | approve_failed`; the skip reasons are `AutoApproveSkipReason` in `src/domain/ship/policy.ts`. **An approve failure never fails the job.**
  - `reaction_pending` is gone. Reactions are rows in the reaction outbox (§5.1), written in the same transaction as the terminal transition (FR-SLACK-08).
  - The terminal transition writes the review records and their events in the same transaction (FR-REVIEW-05).

### 4.1 Status-emoji machine (per PR, on the Slack status message)

The rules are FR-SLACK-08 and FR-SLACK-14. This pure function computes the **target** reaction set; the outbox converges Slack to it.

```
             accepted                 verdict pass (auto APPROVE first)
   (none) ───────────────▶ ⏳ ──────────────────────────────────────────▶ 🟢 ──merge──▶ 🟢✅
                           │  verdict P0                                    ▲
                           ├──────────────▶ 🔴 ──force approve──▶ 🟡 ──merge──▶ 🟡✅
                           │                │
                           │ errored /      │ re-review accepted (`updated` with new commits, or owner `review`)
                           │ abandoned      └──────────────────────▶ ⏳ (from 🟢, 🔴 or 🟡)
                           ▼
                        (none) + thread reply
```

- **Invariant:** at most one of ⏳ 🟢 🔴 🟡 per PR at any time. ✅ is the only emoji added next to another, after a confirmed merge (FR-SHIP-08).
- **No re-review after a merge (decided).** A merged state has no outgoing transition, so ✅ is never removed and `review` / `updated` start nothing for a merged PR.
- **Supersession (implemented, `1f47b66`, `524723f`).** Each transition bumps a per-PR `seq`. When a newer review supersedes an older one, the outbox drops the stale pending ops (`isStaleOp`) and rebuilds them with `convergeOps(placed, latest)`, which diffs the target set against the reactions actually placed.
- `targetReactions(prState) → Set<Emoji>`, and `diff(placed, target) → { remove[], add[] }`. Removes are always emitted before adds.
- Several PRs on one message: the aggregation rule is assumed (Q23) and isolated in one function.

### 4.2 ShipPolicy (pure, table-tested)

`src/domain/ship/policy.ts` is reshaped. The full rules are FR-SHIP-01..06.

| Decision               | Rule                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ship` mode            | **Removed.** No path approves and merges in one step.                                                                                                                                                                                                              |
| `autoApprovePlan`      | Allowed only for the **system** actor, on a 🟢 verdict, when the reviewed SHA equals the current head, the repo is in the list, and the PR is open, not a draft, not merged and not own. Otherwise `skip(reason)`.                                                 |
| `approvePlan` (manual) | Owner only. Same gates. Already approved at this SHA → `noop`.                                                                                                                                                                                                     |
| `forceApprovePlan`     | Owner only. `approve_only` at the current SHA, or `noop`. Never merges. **The latest review must be for the current head SHA**; after new commits the owner replies `review` (or the requester `updated`) first.                                                   |
| `mergePlan`            | Owner only (the system actor is always refused). Requires an approval event for the **current** SHA. Requires no P0, **unless** a `force_approved` event exists for that same SHA. Also mergeable and checks green. Unknown mergeability fails the gate. |
| Repo allowlist (S2)    | The stored repo list (`SettingsRepo`), passed in as data. An empty list denies everything.                                                                                                                                                                         |
| Removed inputs         | `authorMergeable`, the no-merge and tracked author lists (`src/domain/ship/authors.ts`), and `shouldMergeAfterShip`.                                                                                                                                               |

Around the pure policy, `src/application/ship/ship.ts` adds (`c3fed41`):

- **One rule set for the page and the action.** `mergeChecklist` (the `/merge` gate list) and `mergePr` (the merge) evaluate the same gates, so the page never enables a merge that the action refuses.
- **Unknown mergeability fails closed.** GitHub's `mergeable: null` is re-read a bounded number of times, then reported as the failing gate `mergeableUnknown`.
- **Head pinning.** `mergePr` takes the head SHA the user confirmed (`expectedSha`); a different live head is refused with `headMoved` before any write.
- **`hasApproval(ref, sha)`** considers only the connected account's latest `APPROVED` or `CHANGES_REQUESTED` review; comment-only and dismissed reviews are ignored.

### 4.3 Thread commands and PR-link parsing (pure)

- `parseThreadCommand(event, { ownerId, requesterId }) → Command | Ignored(reason)`. The whole trimmed text must equal the command, case-insensitively. Edits, deletes and bot messages are ignored. The table of commands is FR-SLACK-13:
  - owner: `review`, `approve`, `force approve`, `merge`
  - recorded requester: `updated`
- `extractReviewPrUrls(text, repoList)` takes the repo list as input instead of the hard-coded regex at `src/domain/slack/review-rules.ts:36`. The sender allowlist check (`review-rules.ts:69-70`) is removed (FR-SLACK-04).
- The owner's Slack ID comes from `auth.test` on the stored user token, which must return a user (FR-SLACKCFG-03).
- **The owner's own messages never start a review** (decided). The owner uses `review`, and `review` in a thread with no earlier review is ignored (the manual first review is not built).

---

## 5. Data

### 5.1 PostgreSQL (drizzle 1.0, `src/adapters/db/`)

| Table                                        | Purpose                                                           | Key columns                                                                                                                                                                                                                                                          | Replaces                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `user`, `session`, `account`, `verification` | better-auth                                                       | generated by `npx auth generate`                                                                                                                                                                                                                                     | —                                                                           |
| `login_token`                                | the login token hash, singleton; its presence means initialized   | `id` (always 1), `token_hash` (PBKDF2-HMAC-SHA256 via WebCrypto, 600000 iterations, 16-byte salt), `created_at`, `rotated_at`                                                                                                                                        | —                                                                           |
| `review_job`                                 | Slack and web review **work queue** (deleted after 30 days)       | `id`, `source` (slack/web), `state`, `urls jsonb`, `progress jsonb`, `attempts`, `next_attempt_at`, `lease_owner`, `lease_until`, `slack jsonb` (`channel`, `ts`, `threadTs`, `user`), `actor_user_id`, `created_at`, `updated_at`. `github_account` is dropped (§3) | Redis `slack-review:job:*`, the `pending` and `recent` sets, the file store |
| `review_job_read`                            | per-user read marks                                               | `user_id`, `job_id` / `read_before`                                                                                                                                                                                                                                  | Redis `read-jobs`, `read-before`                                            |
| ~~`review_session`~~                         | merged into `review_job` (`source='web'`, `expires_at`) per §10.3 | —                                                                                                                                                                                                                                                                    | Redis `review-session:*`, `.agent-ops/review-sessions/`                     |
| `read_cursor`                                | per-user monotonic `read_before` (jobs)                           | `user_id`, `kind`, `read_before` (`GREATEST` on update)                                                                                                                                                                                                              | Redis `read-before`                                                         |

**New tables (decided 2026-11-04).** The review tables landed in `75512d8` (`drizzle/20261104061836_review_tables`). `setting_secret` and `slack_review_channel` are defined in `7e7e8a4` and migrated by 3w-2 (in progress). `setting_value` is stage 4.

| Table                  | Purpose                                                                                                                                                                                                                                                                                                                                                              | Key columns                                                                                                                                                                                                                           | Requirement                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `github_credential`    | **Implemented (`7c638a5`).** The single GitHub token, one row (check `id = 'github'`), **encrypted**: AES-256-GCM, key = HKDF-SHA256(`BETTER_AUTH_SECRET`, `"agent-ops:github-token:v1"`), random 96-bit IV per write                                                                                                                                                | `ciphertext`, `iv`, `auth_tag`, `key_version`, `login`, `avatar_url`, `last4`, `permissions jsonb`, `saved_at`, `version`                                                                                                             | FR-GITHUB-03, §3.7             |
| `github_repo`          | **Implemented (`7c638a5`).** The repo list: allowlist, Slack trigger set and `/review` picker. Unique index on `lower(canonical)`; adds run under a table lock so the maximum of 50 holds (`src/adapters/db/pg-settings-repo.ts:38-46`)                                                                                                                              | `canonical` (unique, case-insensitive), `owner`, `repo`, `permissions jsonb`, `checked_at`, `added_at`                                                                                                                                | FR-GITHUB-07, FR-SHIP-02       |
| `setting_secret`       | Every other settings secret, one row per kind: Slack user token and signing secret; Anthropic API key or auth token. Same cipher, a **distinct HKDF info per kind**, `agent-ops:<kind>:v1` (e.g. `agent-ops:slack-user-token:v1`). The signing secret gets `verified_at` on its first valid signed event | `kind` (unique), `ciphertext`, `iv`, `auth_tag`, `key_version`, `last4`, `saved_at`, `verified_at`, `test_result jsonb`                                                                                                               | FR-SLACKCFG-02, FR-SETTINGS-01 |
| `setting_value`        | Non-secret settings: Anthropic base URL and runtime model                                                                                                                                                                                               | `section`, `key`, `value jsonb`, `updated_at`                                                                                                                                                                                         | FR-LLMCFG-01                   |
| `slack_review_channel` | Selected review channels; empty = all channels, DMs always count. A selected channel that disappears is kept and flagged `missing`                                                                                                                                                                                                                                   | `channel_id` (unique), `name` (cached), `checked_at`, `missing`                                                                                                                                                                       | FR-SLACKCFG-04                 |
| `review_result`        | The durable review record, one per PR URL per run, kept after the job row is purged (assumed: 1 year)                                                                                                                                                                                                                                                                | `id`, `job_id`, `pr_url`, `owner`, `repo`, `number`, `head_sha`, `base_sha`, `source`, `requester` (Slack ID or user), `provider`, `model`, `started_at`, `finished_at`, `status`, `verdict`, `findings jsonb`                        | FR-REVIEW-05                   |
| `review_event`         | **Implemented (`7c638a5`).** Append-only history. `UPDATE` and `DELETE` are rejected by a `BEFORE UPDATE OR DELETE` trigger (`drizzle/20261104035857_github_settings/migration.sql:50-56`). Unique on (job, url, step) for idempotency                                                                                                                               | `id`, `pr_url`, `review_id`, `type` (`review_*`, `approved`, `approve_skipped`, `approve_failed`, `force_approved`, `merged`, `merge_failed`, `github_*` settings changes), `actor_kind`, `actor_id`, `sha`, `reason`, `source`, `at` | FR-REVIEW-06                   |
| `slack_review_thread`  | Thread → review lookup, for thread commands                                                                                                                                                                                                                                                                                                                          | (`channel`, `thread_ts`) → `pr_url[]`, `latest_review_id`, `requester_slack_id`, `status_message_ts`                                                                                                                                  | FR-SLACK-13, FR-SLACK-14       |
| `slack_reaction`       | The reactions the app placed, per PR, so it only ever removes its own                                                                                                                                                                                                                                                                                                | `pr_url`, `channel`, `ts`, `emoji`, `state` (`placed`, `removed`), `review_id`                                                                                                                                                        | FR-SLACK-14 (b)                |
| `reaction_outbox`      | Durable reaction writes: remove before add, latest wins (stale ops dropped and rebuilt with `convergeOps(placed, latest)`), `already_reacted` and `no_reaction` count as success                                                                                                                                                                                     | `id`, `pr_url`, `op` (add/remove), `emoji`, `channel`, `ts`, `review_id`, `seq`, `attempts`, `next_attempt_at`, `state`                                                                                                               | FR-SLACK-08, FR-SHIP-08        |

**Job claim** uses PostgreSQL, not a Redis lock:

```sql
UPDATE review_job SET state='running', lease_owner=$1, lease_until=now()+$2, attempts=attempts+1,
  interruptions = CASE WHEN state='running' THEN coalesce(interruptions,0)+1 ELSE interruptions END
WHERE id = (
  SELECT id FROM review_job
  WHERE (state='queued' AND coalesce(next_attempt_at, '-infinity') <= now())
     OR (state='running' AND lease_until < now())
  ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
RETURNING *;
```

This one statement is atomic, safe with several consumers (worker processes), and recovers from crashes through lease expiry. Taking over an expired `running` job counts as one interruption (§4). It replaces the Redis `lock:{id}` and `pending` set, and the interruption counting at `slack-review-queue.ts:77-85`.

**Retention.** A daily job deletes rows past their retention windows: `review_job` after 30 days (web jobs once `expires_at` has passed), and `reaction_outbox` rows once applied. `review_result` and `review_event` are kept longer (assumed: 1 year; `review_event` is never edited).

### 5.1a New and changed ports

| Port                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Requirement                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `GitHubPort` (`src/ports/github.ts`)              | **Done (`f334203`, `c3fed41`).** `getChecks(ref, sha)` (check runs and commit statuses, for the merge gate), `getRepo(owner, repo)` with permissions (for the repo list), `hasApproval(ref, sha)` (the latest `APPROVED` or `CHANGES_REQUESTED` review of the account; comment-only and dismissed reviews ignored) and a mergeable signal with a bounded re-read. **Merge method:** no env var; the container passes a preference list (legacy `merge` first) and the adapter picks the first method the repo allows. A `/settings` control is a possible stage-4 item **(assumed)**. The token comes from `SettingsStore`, per call.                 | FR-SHIP-05, FR-GITHUB-07                   |
| `GitHubVerifier` (`src/ports/github-verifier.ts`) | **Implemented (`7c638a5`).** Checks a token and each repo with **read-only calls only** (`src/adapters/github/octokit-github-verifier.ts:50-73`). Each cell is `granted`, `missing` or `unverified`. PR write is always `unverified` for fine-grained tokens, because no read-only probe exists. Contents write is inferred from the merge settings returned by `GET /repos`. A 5xx, a timeout or a rate limit maps to `unverified`. A rejected token or an unreachable repo becomes 403 `forbidden`, shown on the form field.                                                                                                                        | FR-GITHUB-02, FR-GITHUB-07, FR-GITHUB-09   |
| `SettingsStore` (was `CredentialStore`)           | **New.** One store for every section: `getSecret(kind)` returns the value, `not_configured` or `needs_reset`; `getValues(section)`; `saveSecret`, `removeSecret`, `setValues`. Wraps `github_credential`, `setting_secret`, `setting_value` and a `TokenCipher` (AES-GCM + HKDF with a per-kind info). Reads go through a short in-process cache, invalidated on change via Redis pub/sub (`WakeUp`-style). The in-memory fake is how tests inject credentials. **Today (`7c638a5`)** the GitHub part ships as `CredentialStore` / `PgCredentialStore` with **no cache**: the store is read on every call (`src/server/container.ts:228`). Known gap. | FR-GITHUB-02..05, FR-SLACKCFG, FR-SETTINGS |
| `SettingsRepo`                                    | **New; the repo list is implemented (`7c638a5`).** The repo list and the Slack review channels: `list()`, `add()`, `remove()`, with a short cache invalidated on change (cache not built yet; read on every call).                                                                                                                                                                                                                                                                                                                                                                                                                                    | FR-GITHUB-07                               |
| `ReviewRecordRepo`, `ReviewEventRepo`             | **Implemented (`a37d726`).** The durable record and the append-only events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | FR-REVIEW-05, -06                          |
| `ThreadReviewIndex`                               | **Implemented (`a37d726`).** (`channel`, `thread_ts`) → review; requester and status message.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | FR-SLACK-13                                |
| `ReactionOutbox`                                  | **Implemented (`a37d726`).** Enqueue in the caller's transaction, plus a drain for the outbox drainer in the worker. Stale ops are replaced by `convergeOps(placed, latest)`. Reads and writes `slack_reaction`.                                                                                                                                                                                                                                                                                                                                                                                                                                      | FR-SLACK-08, -14                           |
| `LoginTokenStore`                                 | **New.** `exists()` (initialized), `create(hash)` with `INSERT … ON CONFLICT DO NOTHING` returning `conflict` when a row exists, `get()`, `rotate(hash)` which also deletes every session. Only hashes cross the port.                                                                                                                                                                                                                                                                                                                                                                                                                                | FR-AUTH-01, FR-AUTH-07                     |
| `RateLimiter`                                     | Bounds calls to settings operations and remaining external-service entry points; failures deny the operation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S6                                         |

### 5.2 Redis (node-redis 6, `src/adapters/redis/`)

| Port          | Key                                                                                                           | Mechanism                                                                                                | Why Redis                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `EventDedupe` | `slack:event:{event_id}`                                                                                      | `SET NX EX 86400`                                                                                        | Both Slack ingress paths race on the same event (migration-plan §4.2)                                                     |
| `Lock`        | `lock:{name}`                                                                                                 | `SET NX PX` + token, released with a compare-and-delete Lua script (as today, `review-session.ts:40-46`) | Review-session single flight                                                                                               |
| `RateLimiter` | Bounds calls to settings operations and remaining external-service entry points; failures deny the operation. | S6                                                                                                       |
| `Throttle`    | `throttle:{name}`                                                                                             | `SET NX PX`                                                                                              | review-status poll throttle (today `slack-review-queue.ts`)                                                               |
| `WakeUp`      | `review-job:wake`                                                                                             | `PUBLISH` / `SUBSCRIBE`                                                                                  | Wakes the consumer immediately on enqueue. It is optional: the consumer also polls, so losing a message only adds latency |

Every key gets a configurable prefix (`REDIS_KEY_PREFIX`, default `agent-ops:`), so test runs are isolated (see [testing.md](./testing.md) §5).

---

## 6. Composition root and configuration

```ts
// src/server/config.ts — the ONLY module that reads process.env
export const Config = z.object({ databaseUrl: z.url(), redisUrl: z.url() /* ... */ });
export function loadConfig(env = process.env): Config; // throws a readable error listing every invalid key

// src/server/container.ts
export function createContainer(config: Config, overrides?: Partial<Ports>): Container;
```

- **Startup.** `createContainer` is called once per process, by the web server and by the worker. Tests call it with `overrides`, which means in-memory fakes in the unit tests and real adapters in the integration tests.
- **Env is bootstrap only (decided 2026-11-04).** `config.ts` keeps `DATABASE_URL`, `DATABASE_SEARCH_PATH`, `REDIS_URL`, `REDIS_KEY_PREFIX`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `HOST` and `PORT`. Why each must stay in env is requirements.md §4. Env variables the app does not read only produce a warning at boot.
- **Integration settings live in the store.** GitHub, Slack and Anthropic settings are loaded from `SettingsStore`, never from env. There is no automatic env import.
- **Slack settings changes** are published on the Redis channel `slack-settings:changed`; cached User token and Signing Secret reads are invalidated.
- **Processes.** The worker process (not the web process) runs the review job consumer and the reaction outbox drainer, for HTTP-ingested jobs. The consumer reclaims jobs whose lease expired, so it needs no external backstop.
- **Migrations at startup (decided 2026-11-05).** The web server, `pnpm dev` and the worker each run pending migrations before anything else, through `migrateOnBoot` (`src/server/migrate-on-boot.ts`) under a Postgres advisory lock keyed by `agent-ops:migrate:<schema>` (wait bounded at 60 s). Whichever process starts first migrates; the other waits and finds nothing pending. In production the Nitro entry is `src/server/node-entry.ts`, which migrates and only then imports Nitro's node-server entry, because a Nitro 3 async plugin does not delay listen (it only holds requests). A failed migration exits the process non-zero before it listens or starts a consumer. There is no opt-out flag. Migrations follow expand/contract (development.md §2).
- **Integration adapters are built per call from `SettingsStore`.** `createContainer` exposes a settings-backed reviewer factory. Changes apply without a restart.
- **LLM provider.** Anthropic is the only provider, used for review. Missing or undecryptable credentials return `not_configured`. Credential type determines authentication: API key uses `x-api-key`; auth token uses `Authorization: Bearer`.
- **LLM Save and Test.** Save validates and persists encrypted credentials with unverified metadata and makes no network call. Test validates current form inputs and invokes `LlmProbe` without writing settings. The connection probe sends `hi!` using fixed model `claude-haiku-5-5`. `pnpm llm:ping` reads stored settings and uses the same probe; it needs `DATABASE_URL` and `BETTER_AUTH_SECRET`. Existing base-URL handling is unchanged.
- **Tests** never read integration env vars. Unit and msw tests inject credentials through the `SettingsStore` fake; integration tests seed the real store.
- **Removed.** `UPSTASH_REDIS_REST_*`, `KV_REST_API_*` and `SLACK_REVIEW_STATE_FILE` are removed in P1.
- **System ports.** `Clock` (`now(): Instant`), `IdGenerator` (`uuid()`) and `Logger` (structured, with a request id) are injected everywhere. Nothing calls `Date.now()`, `new Date()` or `randomUUID()` directly. The current hard-wired call sites are listed in testing.md §3.

---

## 7. Errors

```ts
type DomainError =
  | { kind: "validation"; field?: string; message: string } // 400
  | { kind: "unauthenticated" } // 401
  | { kind: "forbidden"; reason: string } // 403 (e.g. repo not in allowlist)
  | { kind: "not_found"; entity: string } // 404
  | { kind: "conflict"; reason: string } // 409 (lock held, SHA changed)
  | { kind: "deferred"; resumeToken?: string } // 202 (review continues)
  | { kind: "rate_limited"; retryAfterMs: number } // 429
  | {
      kind: "not_configured";
      feature: "llm" | "slack" | "slack_events" | "github";
    } // 503; configuration errors use the relevant remaining feature
  | { kind: "upstream"; service: "github" | "slack" | "llm"; retryable: boolean }; // 502/503
```

- **Contract.** Use cases return `Result<T, DomainError>`. Unexpected exceptions become a 500 with a request id. The body is never the raw error message (S4). Details go to the log.
- **User-facing text.** Slack replies, UI messages and other user-facing Chinese text are rendered from `DomainError.kind`, not by matching on error strings.
- **Adapters.** Each adapter maps its SDK's typed errors to `upstream` with a `retryable` flag. For example, `Anthropic.RateLimitError` and 5xx errors are retryable, and 400 is not.

---

## 8. Concurrency and failure modes

| Scenario                                                             | Guard                                                                                                                                                 | Test                                                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Two consumers claim the same job                                     | `FOR UPDATE SKIP LOCKED` + lease                                                                                                                      | integration: N parallel claims, each job is claimed exactly once                              |
| A consumer crashes mid-job                                           | Lease expiry reclaims the job; checkpoints make the external writes idempotent                                                                        | integration: claim → kill → expire → reclaim, with no duplicate GitHub write (msw call count) |
| HTTP Events API repeats delivery of the same event                   | `EventDedupe` `SET NX` on `event_id`, then the deterministic job id as a second layer                                                                 | integration: concurrent `ingestSlackEvent` with the same id → 1 job                           |
| A job's lease keeps expiring (consumer crashes or hangs)             | Each reclaim increments `interruptions` in the claim query; at 3 the new owner sends `interruption_limit` and the job fails as `interrupted`          | unit (state machine) + repo contract                                                          |
| GitHub has not computed mergeability                                 | The gate fails closed as `mergeableUnknown` after a bounded re-read                                                                                   | unit                                                                                          |
| The events route crashes after the ack                               | **Known gap:** the event is lost; Slack does not retry an acked event                                                                                 | —                                                                                             |
| Slack refuses the result reply                                       | Retried; **dropped after 3 refusals** and logged (known gap)                                                                                          | unit                                                                                          |
| An LLM call outlives its job's lease                                 | **Known gap:** LLM calls take no `AbortSignal` and cannot be cancelled (stage 4); checkpoints keep the GitHub writes idempotent                       | —                                                                                             |
| The PR head changes between review and merge                         | SHA check before every write; merge pinned to the SHA the user confirmed, refused with `headMoved` before any write                                   | unit                                                                                          |
| Redis is unavailable                                                 | Dedupe and lock **fail closed** (reject or retry later). WakeUp degrades to polling. Rate limiting fails closed on LLM routes                         | unit with a failing fake                                                                      |
| An LLM, GitHub or Slack call is slow or failing                      | Each adapter has a timeout, bounded retries with jitter (retryable errors only), and a circuit breaker per service                                    | unit with fakes + msw                                                                         |
| A process restarts during a deploy                                   | systemd `KillSignal=SIGTERM`. The consumer stops claiming, finishes or abandons the current job within a grace period, and the lease handles the rest | manual (deploy checklist)                                                                     |
| A reaction swap is interrupted, or two reviews finish close together | Outbox rows applied in `seq` order, remove before add; rows of an older `review_id` are superseded                                                    | integration: fail the first remove → retry → exactly one status emoji (FR-SLACK-14 AC 4–5)    |
| Slack reaction rate limits (HTTP 429)                                | The outbox honours `Retry-After`, with backoff and jitter. A reaction never blocks or changes a review result                                         | unit with a 429 fake                                                                          |
| The same thread command arrives twice                                | `EventDedupe` on `event_id`; `merge` and `approve` are idempotent per SHA (an existing approval or merge is a no-op)                                  | integration: duplicate `merge` → 1 merge call                                                 |
| `updated` / `review` while a review is running                       | One active job per PR (queued, running): the command replies and enqueues nothing                                                                     | unit + integration                                                                            |
| `BETTER_AUTH_SECRET` is rotated                                      | GCM decryption of every settings secret fails closed → "需要重新设置" per section; no outbound call, no crash, 503 `not_configured`                   | unit with fixed vectors                                                                       |

---

## 9. Security

The security fixes S1–S6 from [migration-plan.md](./migration-plan.md) §4 sit at these points:

- **Authentication.** The owner signs in with the login token; it is compared in constant time against the stored PBKDF2 hash, failures are rate-limited, and success issues a better-auth session. Until a `login_token` row exists, every page redirects to `/setup`; once it exists, every `/setup` URL redirects away. The wizard keeps its values in the page and writes once: the public `finishSetup` (`src/application/identity/setup.ts`) validates every section, then a `SetupUnitOfWork` transaction (`src/adapters/db/pg-setup-unit-of-work.ts`) inserts the `login_token` row first with `ON CONFLICT DO NOTHING` (a lost race rolls everything back as 409), then the owner user, the encrypted settings and the repos; the session is issued after the commit. That and the read-only setup checks (`getSetupSections`, `testSetupAnthropic`, `listSetupGithubRepos`, `testSetupSlack`) are the only unauthenticated setup functions; all of them return 409 once initialized and share a per-IP attempt limiter in the `setup:` namespace. Middleware covers the edge. Only the session cookie authenticates; any request with an `Authorization` header gets 401. Use cases additionally take an `Actor` argument and check it (defence in depth).
- **Repo allowlist (S2).** Enforced in `ShipPolicy` (§4.2) against the stored repo list. Every review, approve, force-approve and merge path, on web and Slack, goes through it.
- **GitHub account (S3).** Moot: there is one server-held account (FR-REVIEW-08). `x-github-account` is ignored.
- **Token model.** The session cookie proves the owner's identity; the GitHub token and every other settings secret never leave the server (FR-SETTINGS-01). Both request flows (browser and Slack) use the same decrypt-and-call path in the GitHub adapter. The full model and the flow diagrams are requirements.md §3.7.
- **Actors.** Only the owner can approve (manually), force-approve or merge. The **system** actor may approve only through `autoApprovePlan`.
- **Untrusted LLM input.** PR text is wrapped as delimited untrusted input (`src/adapters/llm/untrusted.ts`). Because 🟢 now auto-approves, an injection can produce an approval. A merge still needs the owner's explicit `merge`, so the human gate is on merge (requirements.md Q1; migration-plan.md §4.1).
- **Removed attack surface.** Multi-account selection, the `x-github-account` header, the hard-coded repo (`bosinc/katana-web`) and author lists, and the Slack sender allowlist gate.

---

## 10. Open decisions

1. **Forced `tool_choice` on newer Claude models** (migration-plan §8). This affects the `Reviewer` adapter only, because the port contract stays `review(input) → AiReviewResult`.
2. ~~Prompt-injection merge gate~~. **Closed for merge** (requirements.md Q1): merge is always a human action. The residual auto-approve risk is recorded there.
3. ~~`review_session` as a separate table~~. **Resolved:** merged into `review_job` with `source='web'`.
4. **Schema names** in §5.1 (new tables) are assumed until their migrations land. The behaviour they must support is fixed by the FR IDs in each row.
5. Product questions that affect the design (several PRs per message, Q23; the `/review` list being view-only, Q26) are tracked in requirements.md §6, not here.
