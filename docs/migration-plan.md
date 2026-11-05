# Migration Plan: Next.js 16 → TanStack Start

> **Historical migration record.** Phase statuses, file lists and decisions below describe the earlier migration and preserve its history; they are not current product or setup instructions. Current behavior is in [requirements.md](./requirements.md) and [product.md](./product.md); Slack callback setup is in [development.md](./development.md).

Status: **P0, P1 and P2 done; P3 and P4 in progress (§5.1 stage 1 and stage 3 done, except the 3w-2 wiring, in progress; stage 4 done)**. Last updated 2026-11-05. Risks R2 (drizzle 1.0 RC + better-auth), R3 and R6 are resolved.

- **Done in P3/P4 so far:** the domain wave (state machine, ShipPolicy, review domain; `b7b781c`), the LLM, GitHub and Slack ports and adapters (`e449067`, `51d0f14`), the UI primitives (P4-1) and the login form on TanStack Form (`7566e1e`). Stage 1, the `/settings` GitHub section with the sidebar nav (`7c638a5`), and stage 3, `/review`, `/merge`, the Slack review flow and the Slack settings (§5.1), are done. Stage 4, the LLM section on `/settings` with env reduced to bootstrap values (§5.1), is done. The stage 3 wiring sub-task 3w-2 is in progress.
- **Remaining:** the pages and flows in §5.1, in that order.

Product behaviour is defined in [requirements.md](./requirements.md) (FR-* IDs) and [product.md](./product.md). This plan only orders the work; the decisions it depends on are listed in §9.

This document preserves the migration history. For current implementation work, read the current requirements and architecture together with [styling.md](./styling.md).

---

## 1. Goals

1. **Framework.** Replace Next.js 16 (App Router, Vercel) with TanStack Start (Vite 8, SSR), self-hosted on Node.
2. **Data and forms.** Adopt TanStack Query, TanStack Form and TanStack Devtools on the client.
3. **UI.** Replace antd with Tailwind CSS v4 + `react-twc` + `tailwind-variants` + Base UI, following [styling.md](./styling.md).
4. **Security.** Close the security gaps found in the initial review. The most important is that no API route currently authenticates its caller.
5. **Dependencies.** Upgrade every dependency to its latest version, and replace ESLint and Prettier with oxlint and oxfmt.

### Non-goals

- Changing review product behaviour, except where a security fix requires it.
- Changing which Claude model is used. The SDK upgrade keeps the same defaults; from stage 4 the model is set on `/settings` instead of `ANTHROPIC_MODEL`.

---

## 2. Decisions

All versions are the npm `latest` dist-tag, or the tag named in the table, as checked on 2026-11-03 against registry.npmjs.org and nodejs.org.

| Area                     | Choice                                                                       | Version (date)                                        | Notes                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Runtime                  | Node.js LTS                                                                  | 26.13.0 (2026-10-28)                                  | `engines.node >=26`. The tightest dependency requirement is nitro, at >=22.22.                          |
| Package manager          | pnpm                                                                         | 12.16.1                                               | `minimumReleaseAge` is kept on (pnpm default). The temporary exclusions were lifted on 2026-11-05 (§7). |
| Framework                | @tanstack/react-start / react-router                                         | 1.169.4 / 1.170.46 (2026-10-22)                       | SSR is **on**.                                                                                          |
| Build                    | vite / @vitejs/plugin-react                                                  | 8.3.5 (2026-10-21) / 6.2.1 (2026-11-02)               | Start requires Vite ≥ 8.                                                                                |
| Node server              | nitro                                                                        | 3.0.261102-rc (2026-11-02)                            | **RC.** No stable release exists.                                                                       |
| Data fetching            | @tanstack/react-query (+ devtools, router-ssr-query)                         | 5.105.3 (2026-11-02)                                  |                                                                                                         |
| Forms                    | @tanstack/react-form / react-form-start                                      | 1.33.5 (2026-08-11)                                   | `react-form-start` adds server validation.                                                              |
| Devtools                 | @tanstack/react-devtools                                                     | 0.10.14 (2026-10-29)                                  | Plugins for Query, Router and Form. Loaded in dev only.                                                 |
| Styling                  | tailwindcss / @tailwindcss/vite                                              | 4.3.4 (2026-11-02)                                    | Tokens are defined in `@theme`.                                                                         |
| Variants and composition | tailwind-variants / react-twc                                                | 4.0.1 (2026-10-31) / 1.5.1 (2025-07-18)               | react-twc has had no release in about 15 months. See risk R5.                                           |
| Headless UI              | @base-ui/react                                                               | 1.9.0 (2026-10-09)                                    | Dialog, Select, Collapsible.                                                                            |
| Toasts                   | sonner                                                                       | 2.0.8 (2026-08-09)                                    | Replaces antd `message`.                                                                                |
| Icons                    | unplugin-icons + @iconify-json/{lucide, simple-icons, line-md, svg-spinners} | 24.0.0 (2026-09-11)                                   | See styling.md §8–9. Vite 8 support is unverified (R3).                                                 |
| Type checking            | tsrs (primary) + typescript (CI cross-check)                                 | 0.20.1-ts7.1.0-beta (2026-10-28) / 7.0.2 (2026-07-08) | tsrs is pre-stable, so both run in CI until tsrs ships a stable release.                                |
| Lint / format            | oxlint + oxlint-tsgolint / oxfmt                                             | 1.90.0 / 7.0.2005 / 0.75.0                            | oxfmt is configured to match the existing style: double quotes, semicolons, trailing commas, width 100. |
| Database                 | PostgreSQL via `postgres` (postgres.js) + drizzle-orm / drizzle-kit          | 4.0.0 (2026-10-29) / **1.0.0-rc.5** (2026-10-21)      | Drizzle is pinned to an **RC** at the user's request (R2).                                              |
| Cache / queue            | Redis Cloud via `redis` (node-redis)                                         | 6.3.1 (2026-10-29)                                    | Redis recommends node-redis over ioredis for new projects. Connects over TLS with `rediss://`.          |
| Auth                     | better-auth                                                                  | 1.7.15 (2026-11-01)                                   | Has an official TanStack Start integration. Its peer range for drizzle-orm accepts the 1.0 RC.          |
| Anthropic SDK            | @anthropic-ai/sdk                                                            | 1.4.0 (2026-11-02)                                    | Major upgrade from 0.125.                                                                               |
| Slack                    | HTTP Events API                                                              | @slack/web-api 8.3.0                                  | Events are deduplicated by event ID (§4.2).                                                             |

### Removed

next, eslint, eslint-config-next, antd, `@ant-design/*` and `@tailwindcss/postcss`.

`@upstash/redis` and `proper-lockfile` are removed in P1, once their callers have been replaced.

---

## 3. Target architecture

```
                 ┌──────────── reverse proxy (TLS) ────────────┐
Browser ────────▶│  /*            → web (127.0.0.1:5555)        │
Slack Events ───▶│  /api/slack/events → web (signature-verified)│
                 └──────────────────────────────────────────────┘
web (systemd: agent-ops-web)          worker (systemd: agent-ops-slack-worker)
  TanStack Start SSR + server routes    review-queue consumer
  better-auth sessions                  reaction outbox drainer
  Slack events route (ack, then work)   expired-lease reclaim
          │                                     │
          ├────────── PostgreSQL (users, sessions, review queue + records + events,
          │                       encrypted settings secrets, repo list, review channels, reaction outbox)
          └────────── Redis Cloud (locks, rate limits, event dedupe, wake-up, slack-settings:changed)
```

- **Rendering.** Pages are SSR route components under `src/routes/`. Loaders prefetch data through `queryClient.ensureQueryData`.
- **API.** Server routes live under `src/routes/api/`. Response shapes and status codes are kept identical to the current Next routes, so the client can migrate route by route.
- **Background work.** Next's `after()` is replaced by the queue consumer and the reaction outbox drainer in the **worker** process (decided in stage 3). The web process runs no consumer. Jobs are durable in PostgreSQL (architecture.md §5.1), so a restart does not lose them, and the consumer reclaims jobs whose lease expired.
- **Storage.** PostgreSQL holds durable records. Redis holds only coordination state: the queue, locks, rate limits and dedupe keys. Losing Redis must never lose a review record.

---

## 4. Security changes

These are fixed as part of the migration. Each fix starts with a failing test.

| #   | Issue (from the initial review)                                                    | Fix                                                                                                                                                                                                                                                          | Phase   |
| --- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| S1  | No API route authenticates its caller                                              | better-auth session required on all pages and `/api/*`. A request with an `Authorization` header gets 401. `/api/slack/events` is exempt and relies on Slack signature verification.                                                                     | P2      |
| S2  | `/api/execute` `merge` / `force_approve` acts on any repo the token can reach      | The allowlist is the repo list stored on `/settings` (FR-GITHUB-07, FR-SHIP-02). An empty list denies everything. Applies to every web and Slack path.                                                                                                       | P3      |
| S3  | The client picks the GitHub token through the `x-github-account` header            | **Moot.** One GitHub account, entered on `/settings` and held encrypted on the server (FR-REVIEW-08, FR-GITHUB-03). The header is ignored.                                                                                                                   | P3      |
| S4  | Raw error messages and upstream response bodies are returned to the client         | Return a generic message plus a request ID, and log the details on the server.                                                                                                                                                                               | P3      |
| S5  | `next dev` listens on all interfaces                                               | Dev and prod bind to `127.0.0.1`. Only the reverse proxy is exposed.                                                                                                                                                                                         | P0 / P6 |
| S6  | Unauthenticated callers can trigger paid LLM work (review-status GET)              | Covered by S1. A Redis-backed rate limit is added on LLM-triggering routes.                                                                                                                                                                                  | P2 / P3 |

### 4.1 Prompt injection: auto-approve, never auto-merge (decided 2026-11-04)

PR bodies and diffs are passed into the review prompt as delimited untrusted input. A PR author could still write text that persuades the model to report no P0.

- **Decided:** a 🟢 review **auto-approves** at the reviewed SHA (FR-SHIP-01), but **nothing auto-merges**. A merge always needs the owner's explicit `merge` reply or the `/merge` button (FR-SHIP-05, FR-SLACK-13). The human gate is on merge.
- **Residual risk (R10):** an injection can produce a GitHub approval without a human. See requirements.md Q1 for the open branch-protection question.

### 4.2 Slack event dedupe

The Events API route may receive the same Slack event more than once. Each event is claimed with `SET slack:event:<event_id> 1 NX EX 86400` before any side effect, and the deterministic job id is a second layer. A test covers the same event arriving concurrently. The events route acks first, then processes; an event lost to a crash after the ack is a known gap.

---

## 5. Phases

Each phase follows the same loop:

1. Write failing tests.
2. Implement.
3. Run the full check: `pnpm typecheck && pnpm typecheck:tsc && pnpm lint && pnpm format:check && pnpm test && pnpm build`.
4. Commit once.

Within a phase, every file has exactly one owning agent. Phases are sequential unless marked parallel.

### P0 — Toolchain and skeleton

- **P0-A** (done; install OK, 64 of 64 tests pass; type errors remain only in legacy `src/components`, which P0-B excludes):
  - Updates `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` (TS 7), `vite.config.ts`, `.oxlintrc.json`, `.oxfmtrc.json` and `.gitignore`.
  - Deletes `next.config.ts`, `eslint.config.mjs` and `postcss.config.mjs`.
  - Excludes the legacy `src/app/**` and `src/lib/slack-review-vercel.ts` from type checking and linting until they are rewritten.
- **P0-B** (parallel with C):
  - Creates `src/router.tsx`, `src/routes/__root.tsx`, `src/routes/index.tsx` (placeholder), `src/start.ts`, `src/styles/app.css` (`@theme` tokens), `src/ui/twx.ts` and `tests/ui-twx.test.tsx`.
  - **Smoke test.** A lucide icon, `simple-icons/slack` and `line-md/loading-loop` must render as inline SVG in `vite dev`, in `vite build` and in SSR HTML.
- **P0-C** (parallel with B):
  - Migrates the Anthropic SDK calls in `src/lib/review-ai.ts` to `@anthropic-ai/sdk` 1.x, using the installed package's CHANGELOG and MIGRATION notes.
  - The 1.x upgrade produced no type errors. The remaining work is a runtime-behaviour review against API version 2026-10-21.
  - Fixes the oxlint errors in `src/lib`.
- **Acceptance:**
  - All 64 existing tests pass, plus the new guard test.
  - Both type checkers report no errors.
  - The smoke test passes.
- **Result (2026-11-03): done.**
  - 65 of 65 tests pass, and tsrs and tsc are both clean.
  - The icon smoke test passes in dev and in prod: 4 `<svg>` elements and 1 SMIL `<animate>` each. R3 is resolved. unplugin-icons works on Vite 8, but it needs `@svgr/core` and `@svgr/plugin-jsx` 8.1.0.
  - tailwind-variants 4.0.1 `cn` merges conflicting classes, so R6 is verified.
  - Applying oxfmt to the existing code is committed separately, as a pure formatting commit.

Phases P1–P3 follow [architecture.md](./architecture.md) (ports and adapters) and [testing.md](./testing.md) (TDD). Remote test PostgreSQL and Redis replace docker-compose. Their URLs are in `.env.test.local`, which git ignores.

### P1 — Test harness, ports and data layer

- **Step 0: test harness and smoke tests.** Each smoke test is red first.
  - Install vitest and the testing.md §1 toolchain, and convert the existing 9 `node:test` files to vitest without losing any test.
  - Configure the vitest `projects`: unit, db-fast, integration and component.
  - Smoke tests:
    - remote PG over TLS, plus the database name
    - remote Redis over TLS
    - drizzle 1.0 RC on PGlite
    - msw intercepting Octokit, Slack and Anthropic `fetch`
    - Base UI under jsdom
  - Integration setup and teardown implement testing.md §5: per-run schema and key prefix, a production guard, and stale-schema cleanup.
- **Step 1: system ports and config.**
  - Adds `Clock`, `IdGenerator`, `Logger` and `src/server/config.ts` (zod, with failing tests for every invalid env var), plus `src/server/container.ts` and `src/server/errors.ts` (`DomainError` → HTTP).
  - Adds the import-boundary lint rules.
- **Step 2: storage ports, fakes and contract suites.**
  - Ports: `ReviewJobRepo` (claim with lease, architecture §5.1), `Lock`, `EventDedupe`, `RateLimiter`, `Throttle` and `WakeUp`.
  - For each port: an in-memory fake, plus one contract suite that runs against the fake.
- **Step 3: adapters.**
  - drizzle schema and migrations, and repositories passing the contract suites on PGlite (db-fast) and on remote PG (integration). This includes the N-way parallel claim test.
  - node-redis adapters passing the contract suites on remote Redis.
- **Step 4: better-auth spike.**
  - Generate the better-auth schema with `npx auth@latest generate`, migrate, and run one sign-in against drizzle 1.0 RC on remote PG.
  - If better-auth emits RQB v1 `relations()`, hand-write `defineRelations`.
  - If it is still blocked, stop and escalate (R2).
- **Not in P1.** Existing `src/lib` callers are not switched over yet. The old stores keep working until P3 moves each use case onto the ports. `@upstash/redis` and `proper-lockfile` are removed at the end of P3.

### P2 — Authentication

- Adds `src/adapters/auth/better-auth.ts`, `src/routes/api/auth/$.ts`, `src/routes/login.tsx`, and a `src/routes/_authed.tsx` layout guard (`beforeLoad` redirect).
- Adds `src/server/middleware/require-auth.ts`. It produces an `Actor` from the session cookie; any request with an `Authorization` header gets 401. It applies to every server function and to `/api/*` except `/api/auth/*` and `/api/slack/events`.
- CSRF protection uses better-auth's built-in checks. Cookies are `HttpOnly`, `Secure` and `SameSite=Lax`.
- **Tests (written first):**
  - An unauthenticated page request redirects to `/login`.
  - An unauthenticated API request returns 401.
  - Any `Authorization` header returns 401.
  - A valid session returns 200.
  - `/api/slack/events` without a session but with a valid signature returns 200.

### P3 — Domain, use cases and server endpoints (parallel with P4)

- **Domain.** Moves the pure code into `src/domain/<context>/` (architecture §3). Adds the review job state machine (§4), driven by table-driven and property-based tests, and `ShipPolicy` with the repo allowlist (S2). The 2026-11-04 changes (ShipPolicy reshaping, the status-emoji machine, thread commands) are the sub-tasks in §5.1.
- **Use cases.** Builds the use cases in `src/application/` on the ports.
  - `review_session` is merged into `review_job` with `source='web'` (architecture §10.3).
  - `UrlProgress` (`src/domain/review-queue/types.ts`) does not yet carry the `ShipProgress` checkpoint fields: `pr`, `review`, `batchReview`, `commentId` and `githubReviewId`. Extend it test-first before porting `shipPullRequest`, because idempotent GitHub writes depend on these fields.
  - The single GitHub account comes from the encrypted credential (FR-GITHUB-03); the multi-account code is removed (S3).
- **Endpoints.**
  - UI calls go through `createServerFn` in `src/functions/`.
  - External callers use server routes, and their contracts are preserved: Slack events and auth.
  - `slack-review-vercel.ts` is replaced by `src/server/workers/review-job-consumer.ts`, which claims jobs through `ReviewJobRepo` and is woken by `WakeUp`.
- **LLM adapters.** The Anthropic `Reviewer` maps SDK errors to `DomainError`.
  - Forced `tool_choice` becomes `auto` + `strict: true` with a prompt instruction, or structured outputs.
  - The deprecated fallback model is replaced.
  - The `ANTHROPIC_MODEL` trim bug is fixed, test first.
- **Error mapping.** Implements S4 (no leaked errors) and S6 (rate limit).
- **Clean-up.** Removes `@upstash/redis`, `proper-lockfile` and the legacy `src/lib` modules.
- **Tests (written first):**
  - The state-machine table and invariants.
  - The `ShipPolicy` table, including 403 for a repo outside the allowlist.
  - The account taken from the `Actor`, with the `x-github-account` header ignored.
  - The Slack signature checked on the raw body.
  - A contract test per external route.
  - An msw-backed test for the LLM adapter.
- **Stryker.** Runs on `src/domain/**` at the end of P3, with a mutation score of at least 80 %.

### P4 — UI (parallel with P3)

- **Primitives.** Builds `src/ui/` per styling.md: Button, Input, Alert, Spinner, Skeleton, Tag, Empty, Text, plus Dialog, Select and Collapsible on Base UI, sonner, and icons.
- **Pages.** The final routes are fixed (requirements.md §2.7). There are no redirects and no aliases:

  | Route               | Page                          | Status                      |
  | ------------------- | ----------------------------- | --------------------------- |
  | `/setup`            | First-run setup wizard        | done                        |
  | `/login`            | Token sign-in                 | done (`7566e1e`)            |
  | `/settings`         | GitHub token and repo list    | done (`7c638a5`)            |
  | `/review`           | Review history (view-only)    | done (`0c9b6ce`)            |
  | `/review/$reviewId` | Review detail, read-only      | done (`0c9b6ce`)            |
  | `/merge`            | Merge queue and history       | done (`159036f`)            |
  | `/`                 | Overview (workbench)          | stage 5 (placeholder today) |

  The nav is a flat sidebar (requirements.md §2.7, decided): Overview, Review and Merge; then, below a divider at the bottom, Settings with sign-out. Legacy components (`src/app/**`, `src/components/**`) are ported into each page's `-components/` folder, replacing `next/link` with `Link` and `usePathname` with `useLocation`. `AccountSwitcher` is deleted, not ported.

- **Fonts and assets.** Fonts come from `@fontsource-variable/*`. Icons and other assets move to `public/`.
- **Clean-up.** Merges the theme tokens from antd and `globals.css` into `@theme`, and deletes the 3 rules that override antd.
- **Acceptance.** No `antd` import remains, and `src/app/` is deleted.

### 5.1 Remaining P3/P4 work: stages, sub-tasks and file ownership

The stages run **in order**: /settings (GitHub) → /review + /merge with the full Slack flow and the Slack settings → LLM settings → workbench `/`. Inside a stage, the sub-tasks run **in parallel**, and every path has exactly one owner. Two files are shared by everything, so each stage has one **wiring** sub-task that owns them and runs last:

- `src/server/config.ts`, `src/server/container.ts`, `.env.example`
- `src/adapters/db/schema.ts` and new files in `drizzle/` (one migration per stage)

Other sub-tasks export factories and schema fragments, and name what they need wired in their report. New ports come with an in-memory fake in `src/testing/fakes/` and a contract suite in `src/testing/contracts/`, both owned by the sub-task that owns the port.

**Stage 1: `/settings`, GitHub section** (FR-GITHUB-01..08, FR-SETTINGS-01, requirements.md §3.7). **Done (`7c638a5`).** It shipped `CredentialStore` (GitHub only, read on every call, no cache yet; requirements.md FR-GITHUB-09) rather than the full `SettingsStore`; 3j and stage 4 generalise it.

| ID  | Work                                                                                                                                                                                                       | Owns                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1a  | Repo-entry parsing, credential state, HKDF + AES-256-GCM `TokenCipher` with a per-kind info (fixed test vectors)                                                                                           | `src/domain/settings/github*.ts`, `src/domain/settings/credential-state.ts`, `src/adapters/crypto/**`                                                                    |
| 1b  | `SettingsStore` and `SettingsRepo` ports, fakes, contracts and PG adapters. The port declares **every** secret kind up front (GitHub, Slack ×2, Anthropic ×2), so later stages never edit it                     | `src/ports/settings-store.ts`, `src/ports/settings-repo.ts`, `src/adapters/db/pg-settings-store.ts`, `src/adapters/db/pg-settings-repo.ts`, their fakes and contracts    |
| 1c  | `GitHubPort.getRepo` with permissions; the token read per call from `SettingsStore`                                                                                                                        | `src/ports/github.ts`, `src/adapters/github/**`                                                                                                                          |
| 1d  | Use cases (save, remove, add/remove repo, re-validate) and server functions                                                                                                                                | `src/application/settings/github*.ts`, `src/functions/settings-github*.ts`                                                                                               |
| 1e  | The page, the sidebar and sign-out (§2.7, FR-AUTH-08)                                                                                                                                                      | `src/routes/_authed/settings.tsx`, `src/routes/_authed/-settings/github/**`, `src/routes/_authed/-settings/shared/**`, `src/routes/-nav.ts`, `src/routes/-app-shell.tsx` |
| 1w  | Wiring: tables `github_credential`, `github_repo`; drop `GH_TOKEN_*`, `GITHUB_REPO_ALLOWLIST`                                                                                                              | the shared files above                                                                                                                                                   |

**Stage 3: `/review`, `/review/$reviewId`, `/merge`, the Slack review flow and the Slack settings** (FR-REVIEW, FR-SHIP, FR-SLACK, FR-SLACKCFG). **Done, except 3w-2 (in progress).**

| ID   | Commits              | Status      |
| ---- | -------------------- | ----------- |
| 3a   | `8d47c50`            | done        |
| 3b   | `1f47b66`            | done        |
| 3c   | `013dbff`            | done        |
| 3d   | `a37d726`            | done        |
| 3e   | `f334203`            | done        |
| 3w-1 | `75512d8`            | done        |
| 3h   | `0c9b6ce`            | done        |
| 3j   | `7e7e8a4`            | done        |
| 3f   | `524723f`, `cb079da` | done        |
| 3i   | `c3fed41`, `159036f` | done        |
| 3g   | `65130e3`            | done        |
| 3w-2 | —                    | in progress |

Decisions taken during stage 3 (details in requirements.md and architecture.md):

- **Force approve** needs the latest review to be for the current head SHA; after new commits the owner replies `review` (or the requester `updated`) first (FR-SHIP-06).
- **No re-review after a merge**; ✅ is never removed (FR-SHIP-08).
- **`hasApproval`** looks at the account's latest `APPROVED` or `CHANGES_REQUESTED` review; comment-only and dismissed reviews are ignored (FR-SHIP-04).
- **Merge gate.** Unknown mergeability fails (`mergeableUnknown`); the merge pins the confirmed head SHA and refuses a moved head with `headMoved` before any write; `mergeChecklist` and `mergePr` share the rules (FR-SHIP-05).
- **Merge method.** No env var; a preference list in the container (legacy `merge` first), and the adapter picks the first method the repo allows. A `/settings` control is a possible stage-4 item **(assumed)**.
- **Lease-expired reclaims count as interruptions** (`cb079da`); the third fails the job as `interrupted` through `interruption_limit`, so record, outbox and reply are still written (architecture.md §4).
- **Auto-approve outcomes** `approved | approve_skipped(reason) | approve_failed`; an approve failure never fails the job (FR-SHIP-01).
- **Reaction outbox** rebuilds pending ops with `convergeOps(placed, latest)` when a newer review supersedes the old one (FR-SLACK-08).
- **Slack.** The owner's own messages never start a review; `review` in a thread with no earlier review is ignored; the events route acks first, then processes; the worker process runs the consumer and the outbox drainer and reclaims expired leases itself; settings changes are published on `slack-settings:changed` and invalidate cached credentials (FR-SLACK-01..14, FR-SLACKCFG-05).
- **Slack settings.** Secrets in `setting_secret` with HKDF info `agent-ops:<kind>:v1`; `auth.test` must return a user; the signing secret is format-checked, and the signing secret is verified on its first valid signed event; the channel picker caps at 10 pages × 200 or 15 s and reports `truncated`; missing channels are kept and flagged; saves 10 and listings 30 per 10 minutes; UI wording `⚠ 未验证` (FR-SLACKCFG-02..04).
- **`/review`** is view-only, with URL filters, a cursor "加载更多", UTC+8 calendar days and no PR title. Records of removed repos are hidden there but shown in `/merge` history (open, requirements.md Q27).
- **`/merge`**: live gate checklist; the button is enabled only when every gate passes and opens a confirm dialog with the full SHA; 10 merges per minute per user; GitHub's raw text is never shown; the queue checks at most 50 PRs, 6 concurrently.
- **Env.** Every `SLACK_*` variable and `SLACK_REVIEW_ALLOWED_USER_IDS` are removed (requirements.md §4).

Follow-ups (requirements.md §6.1): LLM calls cannot be cancelled (no `AbortSignal`; stage 4); a result reply is dropped after 3 Slack refusals (logged); an event is lost if the process crashes after the ack; the manual first review through the thread `review` command is not built.

The original sub-task plan:

| ID  | Work                                                                                                                                                                                                                                                                                                    | Owns                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3a  | ShipPolicy reshaping (architecture §4.2): no ship mode, `autoApprovePlan`, approve-only force approve, merge needs approval at the current SHA, P0 waiver                                                                                                                                               | `src/domain/ship/**`                                                                                                                                                                            |
| 3b  | Status-emoji machine (§4.1), `parseThreadCommand`, `extractReviewPrUrls(text, repoList)`, removal of the sender allowlist                                                                                                                                                                               | `src/domain/slack/**`                                                                                                                                                                           |
| 3c  | State-machine changes: auto-approve checkpoint, `reaction_pending` replaced by the outbox, record written at the terminal transition                                                                                                                                                                    | `src/domain/review-queue/**`, `src/domain/review/**`                                                                                                                                            |
| 3d  | `ReviewRecordRepo`, `ReviewEventRepo`, `ThreadReviewIndex`, `ReactionOutbox` ports, fakes, contracts, PG adapters                                                                                                                                                                                       | `src/ports/{review-record-repo,review-event-repo,thread-review-index,reaction-outbox}.ts`, `src/adapters/db/pg-{review-record,review-event,thread-review-index,reaction-outbox}*.ts`            |
| 3e  | `GitHubPort.getChecks` and `hasApproval`; the merge method no longer hard-coded                                                                                                                                                                                                                         | `src/ports/github.ts`, `src/adapters/github/**`                                                                                                                                                 |
| 3f  | Review and ship use cases, the queue consumer and the outbox drainer                                                                                                                                                                                                                                    | `src/application/review/**`, `src/application/ship/**`, `src/server/workers/**`                                                                                                                 |
| 3g  | Slack intake and thread commands (`review`, `approve`, `force approve`, `merge`, `updated`), the events route and the review worker; the signing secret read from `SettingsStore` (cached, invalidated on change)                                                                                      | `src/application/slack/**`, `src/routes/api/slack/events.ts`, `scripts/slack-review-worker.ts`, `src/adapters/slack/**`, `src/server/slack-features.ts` |
| 3h  | `/review` and the read-only `/review/$reviewId`                                                                                                                                                                                                                                                         | `src/routes/_authed/review*.tsx`, `src/routes/_authed/-review/**`, `src/functions/review*.ts`                                                                                                   |
| 3i  | `/merge` (the only web action)                                                                                                                                                                                                                                                                          | `src/routes/_authed/merge.tsx`, `src/routes/_authed/-merge/**`, `src/functions/merge*.ts`                                                                                                       |
| 3j  | Slack settings section: validation (`auth.test` user, signing-secret status), the channel picker (`conversations.list`, paginated, search)                                                                                                                                                     | `src/domain/settings/slack*.ts`, `src/application/settings/slack*.ts`, `src/functions/settings-slack*.ts`, `src/routes/_authed/-settings/slack/**`, `src/routes/_authed/settings.tsx`           |
| 3w  | Wiring: tables `review_result`, `review_event`, `slack_review_thread`, `slack_reaction`, `reaction_outbox`, `setting_secret`, `slack_review_channel`; drop `review_job.github_account`, `SLACK_REVIEW_ALLOWED_USER_IDS`, the `SLACK_*` credentials and `SLACK_REVIEW_CHANNEL_IDS`                        | the shared files                                                                                                                                                                                |

3e and 1c own the same files, but they are in different stages. 3j consumes the `SlackPort` methods it needs (`authTest`, `listConversations`) through 3g, which owns `src/adapters/slack/**`. 3a–3e are independent; 3f–3i start once the ports they use have landed (fakes are enough for 3h and 3i).

**Stage 4: LLM settings** (FR-LLMCFG-01, FR-SETTINGS-01..02). **Done (`f64756b`, `2b66dea`, `7b1c84b`, `09f36d3`, `2bdcd48` (4c), `cf3900f`, `4db417b`).** 4b in `09f36d3`, 4c in `2bdcd48`, 4w in `f64756b`, `2b66dea` and `cf3900f`; `4db417b` lifts the temporary dependency exclusion. `ANTHROPIC_*` is gone from `Config` and `.env.example`; env is bootstrap only.

**Why a separate stage, after stage 3** (rather than together with the Slack section): the LLM section shares `src/routes/_authed/settings.tsx`, `src/application/settings/**` and the container with 3j, and the credential swap touches `src/server/llm-providers.ts` and `src/adapters/llm/factories.ts`, which stage 3's review work depends on. Running them after stage 3 keeps every file single-owner without splitting stage 3 further.

| ID  | Work                                                                                                                                                                                             | Owns                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4b  | LLM section: validation, the `llm:ping` probe on save; adapters built per call from `SettingsStore`                                                                                              | `src/domain/settings/llm*.ts`, `src/application/settings/llm*.ts`, `src/functions/settings-llm*.ts`, `src/routes/_authed/-settings/llm/**`, `src/adapters/llm/**`, `scripts/llm-ping.ts` |
| 4c  | Tests stop reading integration env; credentials injected through the `SettingsStore` fake                                                                                                        | `src/testing/**` (except the fakes and contracts owned by 1b), `vitest.config.ts`                                                                                                        |
| 4w  | Wiring: table `setting_value`; factories instead of instances in the container; `settings.tsx` gains the LLM section; drop `ANTHROPIC_*` from `Config` and `.env.example`                     | the shared files, `src/routes/_authed/settings.tsx`, `src/server/llm-providers.ts`                                                                                                       |

- **Switch-over.** The owner re-enters the LLM values on `/settings` once this stage ships. There is no automatic import from env **(assumed)**; a one-off import command is an option.

**Stage 5: workbench `/` and clean-up**

| ID  | Work                                                                                                                                                     | Owns                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 5a  | The workbench page (the review summary)                                                                                                                  | `src/routes/_authed/index.tsx`, `src/routes/_authed/-workbench/**`               |
| 5b  | Delete the legacy code and lift the exclusions (§7): `src/app/**`, `src/components/**`, `src/lib/**`; remove `@upstash/redis`, `proper-lockfile`, `antd` | those paths, `tsconfig.json`, `.oxlintrc.json`, `package.json`, `pnpm-lock.yaml` |

5b runs last, alone.

### P5 — Query, Form, Devtools

- **Query.**
  - Adds one `queryOptions` per endpoint under `src/queries/`. Route loaders prefetch with them.
  - The review 202 polling becomes `refetchInterval`, with a max-attempt cap and automatic stop on unmount. This fixes the unbounded loop at `use-review-page.ts:99-119`.
  - The Slack status 15-second `setInterval` becomes Query polling.
- **Devtools.** A single `TanStackDevtools` shell with the Query, Router and Form panels, rendered in dev only.

### P6 — Slack, deploy and CI

- **Slack worker.** `scripts/slack-review-worker.ts` becomes a production service that shares the Redis queue and event dedupe with the web process.
- **systemd.** Adds `deploy/systemd/` with units for web and worker, plus an example reverse-proxy config.
- **CI.** Adds `.github/workflows/ci.yml`, which runs `typecheck` → `typecheck:tsc` → `lint` → `format:check` → `test` → `build`.
- **Clean-up.** Updates `AGENTS.md`: removes the Next.js block and links this plan and styling.md.

---

## 6. Risks

| #   | Risk                                                                                                                       | Mitigation                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | nitro 3 is an RC                                                                                                           | Pin the exact version, keep the build smoke test in CI, and re-check for a stable release before go-live.                                                                                                  |
| R2  | drizzle 1.0 is an RC, and better-auth's schema generator may emit RQB v1 relations                                         | The P1 spike runs first, with a fallback to hand-written `defineRelations`. If still blocked, escalate.                                                                                                    |
| R3  | unplugin-icons declares Vite ^7 in devDependencies, so Vite 8 support is unverified                                        | The P0-B smoke test checks it. If it fails, fall back to lucide-react plus a hand-made Slack SVG, and update styling.md §8–9.                                                                              |
| R4  | tsrs is pre-stable and may diverge from tsc                                                                                | CI runs both. tsrs replaces tsc only once it is stable and agrees with tsc.                                                                                                                                |
| R5  | react-twc is low-activity, with its last release on 2025-07-18                                                             | It is a thin layer. `tv()` plus a plain `className` is the drop-in replacement.                                                                                                                            |
| R6  | tailwind-variants 4.0 is days old, and the behaviour of `cn` merging is unconfirmed                                        | The guard test `tests/ui-twx.test.tsx` blocks any regression.                                                                                                                                              |
| R7  | Self-hosting removes Vercel's deployment protection                                                                        | S1 lands in P2, before any public deployment.                                                                                                                                                              |
| R8  | A web process restart drops in-flight background work                                                                      | Jobs are durable in PostgreSQL. Their leases expire, and another consumer reclaims them with `FOR UPDATE SKIP LOCKED`.                                                                                       |
| R9  | The remote test databases add latency, and they can be unavailable                                                         | Day-to-day TDD runs on in-memory fakes and PGlite. Contract suites keep those doubles faithful. Only the `integration` project needs the network.                                                          |
| R10 | Prompt injection → **auto-approve** (§4.1)                                                                                 | Merge stays human-gated. Untrusted-input delimiting, the approval recorded as system-on-behalf-of-owner, and Q1 (branch protection) kept open.                                                             |
| R11 | Rotating `BETTER_AUTH_SECRET` invalidates every stored settings secret (and all sessions)                                  | Decryption fails closed into "需要重新设置" (FR-GITHUB-03); the owner re-enters the token. `key_version` allows a later key scheme. Document in the deploy runbook.                                        |
| R12 | Slack reaction rate limits (429) during bursts of swaps                                                                    | Reactions go through the durable outbox with `Retry-After` and backoff, superseded by the latest review; they never change a review result (FR-SLACK-14).                                                  |
| R13 | Switch-over to stored LLM credentials (stage 4) leaves review unconfigured until the owner re-enters them                  | Reviews return 503 `not_configured` with a link to `/settings` (FR-SETTINGS-01); the owner re-enters the values right after deploy; an env import command is an option **(assumed)**. |

---

## 7. Temporary exceptions

| Exception                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Reason                                                                                              | Remove by                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| ~~`minimumReleaseAgeExclude` in `pnpm-workspace.yaml`~~ (lifted), for 27 packages published less than 24h before the install. It covers 20 direct packages and their platform builds, plus 7 transitive packages (`baseline-browser-mapping`, `electron-to-chromium`, `nitro`, `semver`, `seroval`, `seroval-plugins`, `tailwindcss`). P1 step 0 added 9 more: `vitest`, `@vitest/*` (coverage-v8, expect, mocker, pretty-format, runner, snapshot, spy, utils). Without these exclusions, pnpm silently resolved vitest to an older version instead of failing. | The user chose to install the latest versions immediately                                           | **Done 2026-11-05**: list deleted; `pnpm install` passed the supply-chain check with no change to the lockfile. |
| `allowBuilds` in `pnpm-workspace.yaml` set to `false` for `esbuild`, `sharp` and `unrs-resolver`                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | pnpm 12 treats unapproved build scripts as an error. None of these needs its postinstall step here. | Review in P6                                                                                                    |
| `src/app/**`, `src/components/**` and `src/lib/slack-review-vercel.ts` excluded from type checking and linting                                                                                                                                                                                                                                                                                                                                                                                                                                                   | This legacy Next and antd code is rewritten in P3 and P4                                            | End of P4: sub-task 4b (§5.1)                                                                                   |

---

## 8. Not covered yet

- **OpenTelemetry tracing is on by default.** `@anthropic-ai/sdk` ≥ 0.134 emits spans whenever a global tracer provider is registered. None is registered today. Revisit if observability is added.
- Tests for the UI and for `accounts.ts` and `parse-pr-url.ts`. Coverage is added in the phase that touches each one.
- Decision-driven doc drift: `bosinc/katana-web` and the sender allowlist are gone from `src/domain/slack/review-rules.ts` (`1f47b66`). The removed GitHub and Slack env vars leave `Config` with 3w-2.

---

## 9. Decisions log

Each decision is defined in requirements.md; this table only links to it.

| Date       | Decision                                                                                                                                                                  | Requirement IDs                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 2026-11-03 | `review_session` merged into `review_job` (`source='web'`)                                                                                                                | architecture.md §10                                                 |
| 2026-11-04 | Durable review records and an append-only event timeline                                                                                                                  | FR-REVIEW-05, FR-REVIEW-06                                          |
| 2026-11-04 | Final page IA: 7 routes, no redirects or aliases; flat English sidebar (Overview, Review, Merge; Settings at the bottom); no external link                                | §2.7                                                                |
| 2026-11-04 | One GitHub account, entered on `/settings`, encrypted with a key derived from `BETTER_AUTH_SECRET`                                                                        | FR-REVIEW-08, FR-GITHUB-01..06, §3.7                                |
| 2026-11-04 | Repo list in PG drives the Slack trigger, the picker and the allowlist; empty fails closed                                                                                | FR-GITHUB-07, FR-GITHUB-08, FR-SHIP-02                              |
| 2026-11-04 | Anyone in the workspace may trigger a Slack review (no sender allowlist)                                                                                                  | FR-SLACK-04                                                         |
| 2026-11-04 | Status emoji ⏳ / 🟢 / 🔴 / 🟡, at most one per PR; ✅ only after a confirmed merge                                                                                       | FR-SLACK-08, FR-SHIP-08                                             |
| 2026-11-04 | Re-review: requester `updated` (new commits only); owner `review` (any time)                                                                                              | FR-SLACK-13, FR-SLACK-14                                            |
| 2026-11-04 | Force approve: Slack only, approve only, P0 gate waived for that SHA                                                                                                      | FR-SHIP-06                                                          |
| 2026-11-04 | 🟢 auto-approves; merge is always a separate owner action                                                                                                                 | FR-SHIP-01, FR-SHIP-04, FR-SHIP-05, Q1                              |
| 2026-11-04 | `/review/$reviewId` is read-only; the only web action is Merge on `/merge`                                                                                                | FR-REVIEW-07, Q26                                                   |
| 2026-11-04 | Slack credentials and review channels on `/settings`                                                                                                                      | FR-SLACKCFG-01..07                                                  |
| 2026-11-04 | LLM credentials on `/settings`; env is bootstrap only (Q22 closed); the LLM section is stage 4, after /review + /merge                                                     | FR-LLMCFG-01, FR-SETTINGS-01..02, requirements.md §4                |
| 2026-11-04 | Force approve needs a review of the current head; no re-review after a merge, ✅ never removed                                                                            | FR-SHIP-06, FR-SHIP-08                                              |
| 2026-11-04 | Merge gate: unknown mergeability fails, head pinned to the confirmed SHA (`headMoved`), one rule set for checklist and merge; merge method is a container preference list | FR-SHIP-05, Q13                                                     |
| 2026-11-04 | Lease-expired reclaims count as interruptions; the third fails the job through `interruption_limit`                                                                       | FR-SLACK-06, FR-SLACK-07                                            |
| 2026-11-04 | The worker runs the review consumer and the outbox drainer, and reclaims expired leases itself                                                                            | FR-SLACK-07, FR-SLACK-12                                            |
| 2026-11-04 | `/review` is view-only; records of removed repos hidden there (open)                                                                                                      | FR-REVIEW-06, Q26, Q27                                              |
| 2026-11-05 | Single-user token login (PBKDF2 hash in `login_token`); first-run `/setup` wizard, first-writer-wins                                                                      | FR-AUTH-01, FR-AUTH-02, FR-AUTH-07                                  |
